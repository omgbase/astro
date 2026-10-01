/** A lean query hit before hydration. */
export interface QueryHit {
  id: string;
  path: string;
  /** Optional projections returned by the OQX query. */
  [key: string]: unknown;
}

/** Fully hydrated document ready for Astro entry mapping. */
export interface HydratedDoc {
  id: string;
  path: string;
  /** Properties grouped by source: frontmatter / inline / computed. */
  properties: Record<string, Record<string, unknown>>;
  /** Full reconstructed file bytes (includes YAML frontmatter when present). */
  body: string;
  /** Content hash for digest / cache skipping when available. */
  contentHash: string | null;
  rev: string | null;
}

export interface QueryOptions {
  query: string;
  limit?: number;
  repo?: string;
}

export interface HydrateOptions {
  ids: string[];
  repo?: string;
}

export interface ChangesPage {
  digests: Array<{ seq: number; summary?: string }>;
  /** Current tip of the repo commit feed — use as the next poll cursor. */
  head: number;
  truncated: boolean;
}

export interface ChangesSinceOptions {
  /** Exclusive lower bound (repo commit seq). Omit / use a high value to probe `head`. */
  cursor?: number;
  limit?: number;
  repo?: string;
}

/** Live document out-edge used for identity-gated markdown link rewriting. */
export interface DocOutEdge {
  src: string;
  dst: string;
  dstPath: string | null;
}

export interface OutEdgesOptions {
  /** Source doc ids to collect out-edges for. */
  ids: string[];
  repo?: string;
}

/**
 * Largest source-id set for which {@link outEdgesQuery} filters by `$src` in
 * OQX instead of scanning every document edge in the repo. A request-time
 * loader asks for one doc's edges; the build-time loader asks for a whole
 * collection's, where the repo-wide scan is the cheaper shape.
 */
export const OUT_EDGES_PREDICATE_MAX_IDS = 25;

/**
 * OQX for the document out-edges of `ids`. OQX has no list literals, so small
 * id sets become an `||` chain of `$src == "…"` tests; larger sets fall back to
 * the repo-wide edge scan and are filtered client-side by the transport.
 */
export function outEdgesQuery(ids: string[]): string {
  const base = `select $src, $dst, $dst_path from edges where dst_kind == "document"`;
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > OUT_EDGES_PREDICATE_MAX_IDS) return base;
  const predicate = unique.map((id) => `$src == ${JSON.stringify(id)}`).join(" || ");
  return `${base} && (${predicate})`;
}

/**
 * Transport seam: local `@omgbase/core` or remote Streamable HTTP MCP.
 * Both paths share query → hydrate; optional `changesSince` enables remote watch.
 */
export interface Transport {
  readonly kind: "local" | "remote";
  query(opts: QueryOptions): Promise<QueryHit[]>;
  hydrate(opts: HydrateOptions): Promise<HydratedDoc[]>;
  /**
   * Live out-edges from the given docs to document destinations (`$dst` / `$dst_path`).
   * Used to gate markdown link rewrites to destinations omg already resolved.
   */
  outEdges?(opts: OutEdgesOptions): Promise<DocOutEdge[]>;
  /** Optional change feed for remote (and local) live reload. */
  changesSince?(opts?: ChangesSinceOptions): Promise<ChangesPage>;
  /** Local filesystem root to watch in `astro dev`, when available. */
  watchRoot?: string | null;
  close?(): void | Promise<void>;
}
