import type { LoaderContext } from "astro/loaders";
import type { Transport } from "./transport.js";
import type { SlugContext } from "./map.js";
import { mapDoc } from "./map.js";
import {
  allowedDstsFor,
  buildHrefIndex,
  hrefIndexFingerprint,
  rewriteMarkdownLinks,
  type HrefContext,
  type OutEdge,
} from "./links.js";

const CURSOR_META = "omg:changes-cursor";
const DEFAULT_POLL_MS = 2000;

export type WatchOption =
  | boolean
  | {
      /** Poll interval for remote `changes_since` (default 2000). */
      intervalMs?: number;
    };

interface WatchHandle {
  stop: () => Promise<void>;
}

/** Per-collection watch handles so a re-sync replaces the previous poll/listeners. */
const watches = new Map<string, WatchHandle>();

export async function stopWatch(collection: string): Promise<void> {
  const prev = watches.get(collection);
  if (!prev) return;
  watches.delete(collection);
  await prev.stop();
}

export async function syncEntries(
  context: LoaderContext,
  transport: Transport,
  opts: {
    query: string;
    limit?: number;
    repo?: string;
    slug: (ctx: SlugContext) => string;
    href: false | ((ctx: HrefContext) => string);
  },
): Promise<{ seen: number; written: number }> {
  const { store, logger, parseData, renderMarkdown, generateDigest } = context;

  const hits = await transport.query({
    query: opts.query,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
  });

  const ids = hits.map((h) => h.id);
  const docs = ids.length
    ? await transport.hydrate({
        ids,
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
      })
    : [];

  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let written = 0;

  // Identity → site URL for every hydrated doc in this collection.
  let hrefIndex = buildHrefIndex([]);
  let edges: OutEdge[] = [];
  let hrefFp = "";
  if (opts.href !== false && docs.length > 0) {
    const hrefOf = opts.href;
    const entries = docs.map((doc) => {
      const slug = opts.slug({
        path: doc.path,
        docId: doc.id,
        properties: doc.properties,
      });
      const href = hrefOf({
        path: doc.path,
        docId: doc.id,
        slug,
        properties: doc.properties,
      });
      return { docId: doc.id, path: doc.path, href };
    });
    hrefIndex = buildHrefIndex(entries);
    hrefFp = hrefIndexFingerprint(hrefIndex);

    if (transport.outEdges) {
      try {
        edges = await transport.outEdges({
          ids: docs.map((d) => d.id),
          ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        });
      } catch (err) {
        logger.warn(
          `omgbase out-edges unavailable; link rewrite uses path resolution only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  for (const hit of hits) {
    const doc = byId.get(hit.id);
    if (!doc) {
      logger.warn(`hydrate missed doc ${hit.id} (${hit.path})`);
      continue;
    }
    seen.add(doc.id);

    const mapped = mapDoc(doc, opts.slug);
    let body = mapped.body;
    if (opts.href !== false && hrefIndex.byDocId.size > 0) {
      const allowed = edges.length
        ? allowedDstsFor(doc.id, edges, hrefIndex)
        : undefined;
      // Prefer edge-gated rewrite when we have live out-edges; if this doc has
      // none into the collection, still allow path resolution into hydrated docs.
      const gate = allowed && allowed.size > 0 ? allowed : undefined;
      body = rewriteMarkdownLinks(body, {
        srcPath: doc.path,
        hrefIndex,
        ...(gate ? { allowedDstIds: gate } : {}),
      });
    }

    const baseDigest = mapped.digest || generateDigest(mapped.body);
    const digest = hrefFp ? `${baseDigest}|href:${hrefFp}` : baseDigest;
    const existing = store.get(doc.id);
    if (existing?.digest === digest) continue;

    const data = await parseData({ id: doc.id, data: mapped.data });
    const rendered = await renderMarkdown(body);
    store.set({ id: doc.id, data, body, digest, rendered });
    written += 1;
  }

  for (const id of store.keys()) {
    if (!seen.has(id)) store.delete(id);
  }

  return { seen: seen.size, written };
}

/**
 * After the initial load, keep the collection fresh in `astro dev`.
 *
 * - **Local:** subscribe to Astro's Vite FS watcher on the vault root (same path
 *   glob/file loaders use). Updates rewrite the content data store → existing HMR.
 * - **Remote:** poll MCP `changes_since`; on new commits, re-query/hydrate into
 *   the store → same data-store write → same HMR.
 *
 * No Astro integration required; enabled automatically when `watcher` is present.
 */
export async function startWatch(
  context: LoaderContext,
  transport: Transport,
  opts: {
    query: string;
    limit?: number;
    repo?: string;
    slug: (ctx: SlugContext) => string;
    href: false | ((ctx: HrefContext) => string);
    watch: WatchOption;
  },
): Promise<void> {
  const { collection, watcher, meta, logger } = context;
  if (!watcher) return;
  if (opts.watch === false) return;

  const intervalMs =
    typeof opts.watch === "object" && opts.watch.intervalMs !== undefined
      ? opts.watch.intervalMs
      : DEFAULT_POLL_MS;

  let busy = false;
  let stopped = false;

  const reload = async (reason: string) => {
    if (busy || stopped) return;
    busy = true;
    try {
      const { written } = await syncEntries(context, transport, opts);
      logger.info(`omgbase reload (${reason})${written ? `: ${written} entries updated` : ""}`);
    } catch (err) {
      logger.error(
        `omgbase reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busy = false;
    }
  };

  const cleanups: Array<() => void | Promise<void>> = [];

  // Local vault: piggyback on Astro's Vite watcher (identical to glob()).
  const root = transport.watchRoot;
  if (transport.kind === "local" && root) {
    watcher.add(root);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFs = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void reload("fs");
      }, 150);
    };
    watcher.on("change", onFs);
    watcher.on("add", onFs);
    watcher.on("unlink", onFs);
    cleanups.push(() => {
      if (timer) clearTimeout(timer);
      watcher.off("change", onFs);
      watcher.off("add", onFs);
      watcher.off("unlink", onFs);
    });
    logger.info(`watching local omgbase vault ${root}`);
  }

  // Remote (or local without a useful root): poll changes_since.
  if (transport.changesSince && (transport.kind === "remote" || !root)) {
    let cursor = meta.get(CURSOR_META);
    if (cursor === undefined) {
      // Seed at tip so the first poll doesn't replay the whole history.
      const tip = await transport.changesSince({
        cursor: Number.MAX_SAFE_INTEGER,
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
      });
      cursor = String(tip.head);
      meta.set(CURSOR_META, cursor);
    }

    const tick = async () => {
      if (busy || stopped || !transport.changesSince) return;
      try {
        const page = await transport.changesSince({
          cursor: Number(cursor),
          ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        });
        if (page.digests.length === 0) {
          if (page.head !== Number(cursor)) {
            cursor = String(page.head);
            meta.set(CURSOR_META, cursor);
          }
          return;
        }
        cursor = String(page.head);
        meta.set(CURSOR_META, cursor);
        await reload(`changes_since → ${cursor}`);
      } catch (err) {
        logger.warn(
          `omgbase changes_since poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const id = setInterval(() => {
      void tick();
    }, intervalMs);
    cleanups.push(() => clearInterval(id));
    logger.info(`polling omgbase changes_since every ${intervalMs}ms`);
  }

  watches.set(collection, {
    stop: async () => {
      stopped = true;
      for (const c of cleanups) await c();
      await transport.close?.();
    },
  });
}
