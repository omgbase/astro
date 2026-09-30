import type { LoaderContext } from "astro/loaders";
import type { QueryHit, Transport } from "./transport.js";
import type { SlugContext } from "./map.js";
import { digestFingerprint, mapDoc, mergeHitProjections } from "./map.js";
import {
  allowedDstsFor,
  buildHrefIndex,
  hrefIndexFingerprint,
  rewriteMarkdownLinks,
  type HrefContext,
  type HrefEntry,
  type OutEdge,
} from "./links.js";
import {
  CONTENT_HASH_FIELD,
  encodeEntryDigest,
  hitContentHash,
  hitProjectionsFingerprint,
  linksFingerprint,
  parseEntryDigest,
  withContentHash,
  type EntryDigest,
} from "./digest.js";

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

export interface SyncResult {
  /** Docs matched by the query (entries kept in the store). */
  seen: number;
  /** Entries re-parsed/re-rendered and written to the store. */
  written: number;
  /** Docs whose bodies were fetched from omg this pass. */
  hydrated: number;
}

interface SyncOptions {
  query: string;
  limit?: number;
  repo?: string;
  slug: (ctx: SlugContext) => string;
  href: false | ((ctx: HrefContext) => string);
}

/** Meta key: href map fingerprint from the previous sync of this collection. */
const HREF_FP_META = "omg:href-fingerprint";

interface Plan {
  hit: QueryHit;
  hash: string | null;
  hitsFp: string;
  /** Stored digest when the entry can be reused without fetching; else null. */
  stored: EntryDigest | null;
}

/**
 * Run the collection query with `$content_hash` projected so hits carry the
 * server's whole-file hash. If the augmented query is rejected (older server,
 * unusual syntax), fall back to the user's query as written — every doc is
 * then hydrated, exactly as before hash-first sync existed.
 */
async function queryHits(
  transport: Transport,
  opts: SyncOptions,
  logger: LoaderContext["logger"],
): Promise<{ hits: QueryHit[]; injected: boolean }> {
  const base = {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
  };
  const { query, injected } = withContentHash(opts.query);
  if (injected) {
    try {
      return { hits: await transport.query({ query, ...base }), injected: true };
    } catch (err) {
      logger.warn(
        `omgbase: could not project $content_hash; hydrating every doc: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { hits: await transport.query({ query: opts.query, ...base }), injected: false };
}

function stripInjectedHash(hit: QueryHit): QueryHit {
  const { [CONTENT_HASH_FIELD]: _hash, ...rest } = hit;
  return rest as QueryHit;
}

/**
 * Hash-first sync of one collection into Astro's data store.
 *
 * 1. Query with `$content_hash` projected.
 * 2. Reuse any stored entry whose hash, path and hit projections are unchanged.
 * 3. `docs_get_many` only new/changed docs.
 * 4. Rebuild the href map for the whole collection (unchanged docs contribute
 *    the slug/href remembered in their digest) and, only when it moved, fetch
 *    edges and re-hydrate the unchanged docs whose link targets changed.
 * 5. Map, rewrite links, render, and store just those docs.
 *
 * A no-change reload therefore costs one query and nothing else.
 */
export async function syncEntries(
  context: LoaderContext,
  transport: Transport,
  opts: SyncOptions,
): Promise<SyncResult> {
  const { store, logger, meta, parseData, renderMarkdown } = context;
  const repoArg = opts.repo !== undefined ? { repo: opts.repo } : {};

  const { hits, injected } = await queryHits(transport, opts, logger);

  // Decide, per hit, whether the stored entry can stand in for a fetch.
  const seen = new Set<string>();
  const plans = new Map<string, Plan>();
  const toHydrate: string[] = [];
  for (const hit of hits) {
    if (plans.has(hit.id)) continue;
    seen.add(hit.id);
    const hash = hitContentHash(hit);
    const hitsFp = hitProjectionsFingerprint(hit, injected);
    const stored = parseEntryDigest(store.get(hit.id)?.digest);
    const reusable =
      stored !== null &&
      hash !== null &&
      stored.hash === hash &&
      stored.path === hit.path &&
      stored.hitsFp === hitsFp;
    plans.set(hit.id, { hit, hash, hitsFp, stored: reusable ? stored : null });
    if (!reusable) toHydrate.push(hit.id);
  }

  const docs = toHydrate.length
    ? await transport.hydrate({ ids: toHydrate, ...repoArg })
    : [];
  const byId = new Map(docs.map((d) => [d.id, d]));

  // Identity → site URL for every doc in the collection.
  let hrefIndex = buildHrefIndex([]);
  let hrefFp = "";
  const routeById = new Map<string, { slug: string; href: string }>();
  if (opts.href !== false) {
    const hrefOf = opts.href;
    const entries: HrefEntry[] = [];
    for (const plan of plans.values()) {
      const doc = byId.get(plan.hit.id);
      if (doc) {
        const ctx = { path: doc.path, docId: doc.id, properties: doc.properties };
        const slug = opts.slug(ctx);
        const href = hrefOf({ ...ctx, slug });
        routeById.set(doc.id, { slug, href });
        entries.push({ docId: doc.id, path: doc.path, href });
      } else if (plan.stored) {
        routeById.set(plan.hit.id, { slug: plan.stored.slug, href: plan.stored.href });
        entries.push({ docId: plan.hit.id, path: plan.hit.path, href: plan.stored.href });
      }
    }
    hrefIndex = buildHrefIndex(entries);
    hrefFp = hrefIndexFingerprint(hrefIndex);
  }
  const prevHrefFp = meta.get(HREF_FP_META) ?? "";
  const hrefMoved = opts.href !== false && hrefFp !== prevHrefFp;

  // Live out-edges gate link rewriting. Only worth fetching when something
  // will be (re)written: a fetched doc, or an href map that moved.
  let edges: OutEdge[] = [];
  let edgesOk = false;
  if (opts.href !== false && transport.outEdges && (docs.length > 0 || hrefMoved)) {
    try {
      edges = await transport.outEdges({ ids: [...plans.keys()], ...repoArg });
      edgesOk = true;
    } catch (err) {
      logger.warn(
        `omgbase out-edges unavailable; link rewrite uses path resolution only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const linksFpFor = (docId: string): string => {
    if (opts.href === false || hrefIndex.byDocId.size === 0) return "";
    // Without edges the rewrite resolves by path over the whole index.
    if (!edgesOk) return `idx:${hrefFp}`;
    return linksFingerprint(docId, edges, hrefIndex, hrefFp);
  };

  // Unchanged docs whose link targets moved hold an already-rewritten body,
  // so they must be fetched again to be rewritten against the new map.
  if (hrefMoved) {
    const stale: string[] = [];
    for (const plan of plans.values()) {
      if (!plan.stored || byId.has(plan.hit.id)) continue;
      if (linksFpFor(plan.hit.id) !== plan.stored.linksFp) {
        stale.push(plan.hit.id);
        plan.stored = null;
      }
    }
    if (stale.length > 0) {
      for (const doc of await transport.hydrate({ ids: stale, ...repoArg })) {
        byId.set(doc.id, doc);
        docs.push(doc);
      }
    }
  }

  let written = 0;
  for (const plan of plans.values()) {
    const doc = byId.get(plan.hit.id);
    if (!doc) {
      if (plan.stored) continue; // reused as-is
      logger.warn(`hydrate missed doc ${plan.hit.id} (${plan.hit.path})`);
      seen.delete(plan.hit.id);
      continue;
    }

    const mapped = mapDoc(doc, opts.slug);
    mapped.data = mergeHitProjections(
      mapped.data,
      injected ? stripInjectedHash(plan.hit) : plan.hit,
    );
    let body = mapped.body;
    if (opts.href !== false && hrefIndex.byDocId.size > 0) {
      const allowed = edges.length ? allowedDstsFor(doc.id, edges, hrefIndex) : undefined;
      // Prefer edge-gated rewrite when we have live out-edges; if this doc has
      // none into the collection, still allow path resolution into hydrated docs.
      const gate = allowed && allowed.size > 0 ? allowed : undefined;
      body = rewriteMarkdownLinks(body, {
        srcPath: doc.path,
        hrefIndex,
        ...(gate ? { allowedDstIds: gate } : {}),
      });
    }

    const route = routeById.get(doc.id);
    const knownHash = doc.contentHash ?? plan.hash;
    const digest = encodeEntryDigest({
      hash: knownHash ?? `body:${doc.body.length}`,
      path: doc.path,
      slug: route?.slug ?? String(mapped.data.slug ?? ""),
      href: route?.href ?? "",
      hitsFp: plan.hitsFp,
      linksFp: linksFpFor(doc.id),
      // No server hash: fall back to the inputs that used to drive the digest.
      ...(knownHash === null
        ? { fmFp: digestFingerprint(doc.properties.frontmatter ?? {}), rev: doc.rev }
        : {}),
    });
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
  if (opts.href !== false) meta.set(HREF_FP_META, hrefFp);

  return { seen: seen.size, written, hydrated: docs.length };
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
      const { written, hydrated } = await syncEntries(context, transport, opts);
      logger.info(
        `omgbase reload (${reason}): ${hydrated} fetched, ${written} updated`,
      );
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
