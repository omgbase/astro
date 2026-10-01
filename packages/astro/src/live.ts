import type { LiveLoader } from "astro/loaders";
import type { LiveDataCollection, LiveDataEntry } from "astro";
import type { AstroMarkdownOptions, MarkdownRenderer } from "@astrojs/markdown-remark";
import type { DocOutEdge, HydratedDoc, QueryHit, Transport } from "./transport.js";
import { resolveTransport } from "./loader.js";
import { defaultSlug, mapDoc, mergeHitProjections, type SlugContext } from "./map.js";
import {
  buildHrefIndex,
  defaultHref,
  rewriteMarkdownLinks,
  type HrefContext,
  type HrefEntry,
} from "./links.js";

export interface OmgLiveLoaderOptions {
  /** Streamable HTTP MCP endpoint (same as `omg … --server <url>`). Selects the remote transport. */
  url?: string;
  /** Convenience bearer token → `Authorization: Bearer …` if unset. */
  token?: string;
  /** Extra headers on every MCP request (CLI `-H` as a map). */
  headers?: Record<string, string>;
  /** Extra headers as CLI `-H` strings: `["X-Foo: bar"]`. */
  headerLines?: string[];
  /** Path to the omgbase workspace root (directory containing `.omgbase/`). Selects the local transport. */
  workspace?: string;
  /** Local only: skip the freshness sweep before reads (default false). */
  stale?: boolean;
  /** Repo slug (local workspace or remote multi-repo server). */
  repo?: string;
  /** Inject a pre-built transport (tests, or sharing one connection between loaders). */
  transport?: Transport;
  /** Default OQX for `loadCollection`. Hits must be documents. */
  query: string;
  /** Default result limit for `loadCollection`. */
  limit?: number;
  /** Override slug generation. Default: path with `.md` stripped. */
  slug?: (ctx: SlugContext) => string;
  /**
   * Site href for a doc; used to rewrite markdown links in hydrated bodies.
   * `false` disables rewriting. Default: `/${slug}`.
   */
  href?: false | ((ctx: HrefContext) => string);
  /** Inverse of the default slug, for `loadEntry({ slug })`. Default: `(slug) => `${slug}.md``. */
  pathForSlug?: (slug: string) => string;
  /** Hydrate bodies for collection entries too (default false: collection entries are lean). */
  hydrate?: boolean;
  /** Options for `@astrojs/markdown-remark`'s `createMarkdownProcessor` (e.g. `shikiConfig`). */
  markdown?: AstroMarkdownOptions;
  /** Replace the markdown renderer entirely. */
  render?: (markdown: string, ctx: { docId: string; path: string }) => Promise<{ html: string }>;
}

/** `getLiveCollection(name, filter)` shape. Each field falls back to the loader option. */
export type OmgLiveCollectionFilter = { query?: string; limit?: number; hydrate?: boolean };

/** `getLiveEntry(name, filter)` shape. Exactly one key must be set. */
export type OmgLiveEntryFilter = { id?: string; path?: string; slug?: string };

export type OmgLiveErrorCode =
  | "not_found"
  | "invalid_filter"
  | "query_failed"
  | "hydrate_failed"
  | "render_failed";

export class OmgLiveError extends Error {
  readonly code: OmgLiveErrorCode;

  constructor(code: OmgLiveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OmgLiveError";
    this.code = code;
  }
}

/**
 * Entry `data` for live collections. Lean entries carry the hit projections
 * plus intrinsics; hydrated entries add frontmatter, `contentHash` and `body`.
 */
export interface OmgLiveEntryData {
  path: string;
  docId: string;
  slug: string;
  /** Alias of the `$updated_at` projection when the query selects it. */
  updatedAt?: unknown;
  /** Frontmatter `title`, else `$title` (computed or projected). */
  title?: unknown;
  /** Hydrated only: markdown after frontmatter, with inter-doc links rewritten. */
  body?: string;
  contentHash?: string | null;
  [key: string]: unknown;
}

export type OmgLiveLoader = LiveLoader<
  OmgLiveEntryData,
  OmgLiveEntryFilter,
  OmgLiveCollectionFilter,
  OmgLiveError
>;

type Renderer = NonNullable<OmgLiveLoaderOptions["render"]>;

const defaultPathForSlug = (slug: string): string => `${slug}.md`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `$updated_at` as a `Date`, when the value is a parseable string or number. */
function asDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function lastModifiedOf(values: unknown[]): Date | undefined {
  let max: Date | undefined;
  for (const v of values) {
    const d = asDate(v);
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

/** Lazily create the `@astrojs/markdown-remark` processor once per loader. */
function defaultRenderer(markdown: AstroMarkdownOptions | undefined): Renderer {
  let processor: Promise<MarkdownRenderer> | null = null;
  return async (body) => {
    if (!processor) {
      processor = import("@astrojs/markdown-remark").then((m) =>
        m.createMarkdownProcessor(markdown ?? {}),
      );
      processor.catch(() => {
        processor = null; // let the next request retry instead of caching the failure
      });
    }
    const result = await (await processor).render(body);
    return { html: result.code };
  };
}

/**
 * Astro live collection loader backed by omgbase (SSR, request time).
 *
 * `loadCollection` runs an OQX query and returns one lean entry per hit (id,
 * path, slug and the query's projections). `loadEntry` hydrates a single doc by
 * id, path or slug, rewrites its markdown links to the site hrefs of the docs
 * omg says it links to, and renders it to HTML. Pass `hydrate: true` (option or
 * filter) to get the same hydrated shape for every collection entry.
 *
 * One transport is connected lazily per loader and reused across requests.
 */
export function omgLiveLoader(opts: OmgLiveLoaderOptions): OmgLiveLoader {
  const slugFn = opts.slug ?? defaultSlug;
  const hrefFn: false | ((ctx: HrefContext) => string) =
    opts.href === false ? false : (opts.href ?? defaultHref);
  const pathForSlug = opts.pathForSlug ?? defaultPathForSlug;
  const render: Renderer = opts.render ?? defaultRenderer(opts.markdown);
  const repoArg = opts.repo !== undefined ? { repo: opts.repo } : {};

  let transport: Transport | null = null;
  const getTransport = (): Transport => {
    transport ??= resolveTransport(opts, "omgLiveLoader");
    return transport;
  };

  const leanSlug = (hit: { id: string; path: string }): string =>
    slugFn({ path: hit.path, docId: hit.id, properties: {} });

  const leanEntry = (hit: QueryHit): LiveDataEntry<OmgLiveEntryData> => {
    const slug = leanSlug(hit);
    const merged = mergeHitProjections({ path: hit.path, docId: hit.id, slug }, hit);
    const data: OmgLiveEntryData = { ...merged, path: hit.path, docId: hit.id, slug };
    const lastModified = asDate(hit.$updated_at);
    return {
      id: hit.id,
      data,
      ...(lastModified ? { cacheHint: { lastModified } } : {}),
    };
  };

  /** Out-edges to documents for `ids`; unavailable edges degrade to "no rewrite". */
  const edgesFor = async (ids: string[]): Promise<DocOutEdge[]> => {
    if (hrefFn === false) return [];
    const t = getTransport();
    if (!t.outEdges) return [];
    try {
      return await t.outEdges({ ids, ...repoArg });
    } catch {
      return [];
    }
  };

  /** Href index over the destinations of `edges`, keyed by omg identity. */
  const hrefIndexFor = (edges: DocOutEdge[]) => {
    const entries: HrefEntry[] = [];
    const seen = new Set<string>();
    if (hrefFn !== false) {
      for (const e of edges) {
        if (!e.dstPath || seen.has(e.dst)) continue;
        seen.add(e.dst);
        const ctx = { path: e.dstPath, docId: e.dst, properties: {} };
        entries.push({
          docId: e.dst,
          path: e.dstPath,
          href: hrefFn({ ...ctx, slug: slugFn(ctx) }),
        });
      }
    }
    return buildHrefIndex(entries);
  };

  const hydratedEntry = async (
    doc: HydratedDoc,
    hit: QueryHit | undefined,
    edges: DocOutEdge[],
  ): Promise<LiveDataEntry<OmgLiveEntryData> | { error: OmgLiveError }> => {
    const mapped = mapDoc(doc, slugFn);
    const merged = hit ? mergeHitProjections(mapped.data, hit) : mapped.data;

    let body = mapped.body;
    if (hrefFn !== false) {
      const own = edges.filter((e) => e.src === doc.id);
      body = rewriteMarkdownLinks(body, {
        srcPath: doc.path,
        hrefIndex: hrefIndexFor(own),
        allowedDstIds: new Set(own.map((e) => e.dst)),
      });
    }

    let html: string;
    try {
      ({ html } = await render(body, { docId: doc.id, path: doc.path }));
    } catch (err) {
      return {
        error: new OmgLiveError(
          "render_failed",
          `omgbase: rendering ${doc.path} (${doc.id}) failed: ${message(err)}`,
          { cause: err },
        ),
      };
    }

    const data: OmgLiveEntryData = {
      ...merged,
      path: doc.path,
      docId: doc.id,
      slug: String(mapped.data.slug),
      body,
    };
    const lastModified = asDate(hit?.$updated_at ?? doc.properties.computed?.$updated_at);
    return {
      id: doc.id,
      data,
      rendered: { html },
      ...(lastModified ? { cacheHint: { lastModified } } : {}),
    };
  };

  const hydrate = async (
    ids: string[],
  ): Promise<HydratedDoc[] | { error: OmgLiveError }> => {
    try {
      return await getTransport().hydrate({ ids, ...repoArg });
    } catch (err) {
      return {
        error: new OmgLiveError("hydrate_failed", `omgbase: docs_get_many failed: ${message(err)}`, {
          cause: err,
        }),
      };
    }
  };

  const query = async (
    q: string,
    limit: number | undefined,
  ): Promise<QueryHit[] | { error: OmgLiveError }> => {
    try {
      return await getTransport().query({
        query: q,
        ...(limit !== undefined ? { limit } : {}),
        ...repoArg,
      });
    } catch (err) {
      return {
        error: new OmgLiveError("query_failed", `omgbase: query failed: ${message(err)}`, {
          cause: err,
        }),
      };
    }
  };

  return {
    name: "@omgbase/astro",

    async loadCollection({ filter }) {
      const q = filter?.query ?? opts.query;
      const limit = filter?.limit ?? opts.limit;
      const wantBodies = filter?.hydrate ?? opts.hydrate ?? false;

      const queried = await query(q, limit);
      if ("error" in queried) return queried;

      // One entry per doc even if the query yields a doc twice.
      const hits: QueryHit[] = [];
      const seen = new Set<string>();
      for (const hit of queried) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        hits.push(hit);
      }

      const cacheHint = (() => {
        const lastModified = lastModifiedOf(hits.map((h) => h.$updated_at));
        return lastModified ? { cacheHint: { lastModified } } : {};
      })();

      if (!wantBodies) {
        return { entries: hits.map(leanEntry), ...cacheHint } satisfies LiveDataCollection<OmgLiveEntryData>;
      }

      const ids = hits.map((h) => h.id);
      const docs = await hydrate(ids);
      if ("error" in docs) return docs;
      const byId = new Map(docs.map((d) => [d.id, d]));
      const edges = await edgesFor(ids);

      const entries: LiveDataEntry<OmgLiveEntryData>[] = [];
      for (const hit of hits) {
        const doc = byId.get(hit.id);
        if (!doc) continue; // deleted between query and hydrate
        const entry = await hydratedEntry(doc, hit, edges);
        if ("error" in entry) return entry;
        entries.push(entry);
      }
      return { entries, ...cacheHint };
    },

    async loadEntry({ filter }) {
      const given = (["id", "path", "slug"] as const).filter((k) => filter?.[k] !== undefined);
      const key = given[0];
      const value = key ? filter[key] : undefined;
      if (given.length !== 1 || !key || typeof value !== "string" || value.length === 0) {
        return {
          error: new OmgLiveError(
            "invalid_filter",
            "omgbase: loadEntry filter must set exactly one of `id`, `path` or `slug`",
          ),
        };
      }

      let id: string;
      let hit: QueryHit | undefined;
      if (key === "id") {
        id = value;
      } else {
        const path = (key === "path" ? value : pathForSlug(value)).replace(/^\//, "");
        const hits = await query(
          `select $path, $title, $updated_at from docs where $path == ${JSON.stringify(path)}`,
          1,
        );
        if ("error" in hits) return hits;
        hit = hits[0];
        if (!hit) return undefined;
        id = hit.id;
      }

      const docs = await hydrate([id]);
      if ("error" in docs) return docs;
      const doc = docs[0];
      if (!doc) return undefined;

      return hydratedEntry(doc, hit, await edgesFor([doc.id]));
    },
  };
}
