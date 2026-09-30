/**
 * Hash-first sync support: the pieces that let `syncEntries` decide, from a
 * lean OQX hit alone, whether a document needs to be fetched or re-rendered.
 *
 * - {@link withContentHash} projects `$content_hash` onto the user's query so
 *   every hit carries the server's whole-file hash (frontmatter included).
 * - {@link encodeEntryDigest} / {@link parseEntryDigest} store everything the
 *   next sync needs to skip a doc — hash, path, slug, href, projection and link
 *   fingerprints — inside the Astro data-store `digest` string, so no extra
 *   state lives outside Astro's own persistence.
 * - {@link linksFingerprint} pins a doc's rewritten body to the hrefs of the
 *   docs it links to, so a new/removed/moved doc only invalidates its linkers.
 */

import { digestFingerprint } from "./map.js";
import type { HrefIndex, OutEdge } from "./links.js";

/** Version tag; bump when the digest shape changes so old stores re-hydrate once. */
const DIGEST_PREFIX = "omg2:";

export interface EntryDigest {
  /** Server `$content_hash`, or `body:<len>` when the server has none. */
  hash: string;
  path: string;
  slug: string;
  /** Site href used for link rewriting; `""` when rewriting is disabled. */
  href: string;
  /** Fingerprint of the hit's extra OQX projections (they land in `data`). */
  hitsFp: string;
  /** Fingerprint of the hrefs of this doc's in-collection link targets. */
  linksFp: string;
  /** Only meaningful when `hash` is a `body:` fallback (no server hash). */
  fmFp?: string;
  rev?: string | null;
}

export function encodeEntryDigest(d: EntryDigest): string {
  const ordered: Record<string, unknown> = {
    h: d.hash,
    p: d.path,
    s: d.slug,
    u: d.href,
    q: d.hitsFp,
    l: d.linksFp,
  };
  if (d.fmFp !== undefined) ordered.fm = d.fmFp;
  if (d.rev !== undefined && d.rev !== null) ordered.r = d.rev;
  return `${DIGEST_PREFIX}${JSON.stringify(ordered)}`;
}

/** Parse a stored digest; `null` for legacy/foreign digests (forces a re-hydrate). */
export function parseEntryDigest(
  digest: string | number | undefined | null,
): EntryDigest | null {
  if (typeof digest !== "string" || !digest.startsWith(DIGEST_PREFIX)) return null;
  try {
    const raw = JSON.parse(digest.slice(DIGEST_PREFIX.length)) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof raw[k] === "string" ? (raw[k] as string) : null);
    const hash = str("h");
    const path = str("p");
    const slug = str("s");
    if (hash === null || path === null || slug === null) return null;
    return {
      hash,
      path,
      slug,
      href: str("u") ?? "",
      hitsFp: str("q") ?? "",
      linksFp: str("l") ?? "",
      ...(str("fm") !== null ? { fmFp: str("fm")! } : {}),
      ...(str("r") !== null ? { rev: str("r") } : {}),
    };
  } catch {
    return null;
  }
}

export const CONTENT_HASH_FIELD = "$content_hash";

/**
 * Add `$content_hash` to the top-level projection of an OQX query.
 *
 * OQX fixes clause order (`select … from … where …`) and only `select` may drop
 * its keyword, so the projection is always at the very start of the string:
 *
 * - `select a, b from docs …`  → `select $content_hash, a, b from docs …`
 * - `a, b from docs …`         → `$content_hash, a, b from docs …`
 * - `from docs …`              → `select $content_hash from docs …`
 *
 * Queries that already mention `$content_hash`, or scalar `$repo.` forms, are
 * returned unchanged. Returns `{ query, injected }` so the caller can strip the
 * field from hit projections again (it must not leak into entry `data`).
 */
export function withContentHash(query: string): { query: string; injected: boolean } {
  const trimmed = query.trimStart();
  const lead = query.slice(0, query.length - trimmed.length);
  if (/\$content_hash\b/.test(trimmed)) return { query, injected: false };
  if (/^\$repo\./.test(trimmed)) return { query, injected: false };

  if (/^select\s/i.test(trimmed)) {
    return {
      query: `${lead}select ${CONTENT_HASH_FIELD}, ${trimmed.slice("select".length).trimStart()}`,
      injected: true,
    };
  }
  if (/^from\s/i.test(trimmed)) {
    return { query: `${lead}select ${CONTENT_HASH_FIELD} ${trimmed}`, injected: true };
  }
  // Bare projection list (`$path, title from docs …`).
  if (/\sfrom\s/i.test(trimmed)) {
    return { query: `${lead}${CONTENT_HASH_FIELD}, ${trimmed}`, injected: true };
  }
  return { query, injected: false };
}

/** Read the projected hash off a hit; `null` when absent or malformed. */
export function hitContentHash(hit: Record<string, unknown>): string | null {
  const v = hit[CONTENT_HASH_FIELD];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Fingerprint of a hit's extra projections (everything but `id`/`path` and an
 * injected `$content_hash`). These merge into entry `data`, so a change in e.g.
 * `outs: doc.out collect { … }` must re-map the entry even when content didn't move.
 */
export function hitProjectionsFingerprint(
  hit: Record<string, unknown>,
  stripContentHash: boolean,
): string {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hit)) {
    if (k === "id" || k === "path") continue;
    if (stripContentHash && k === CONTENT_HASH_FIELD) continue;
    extras[k] = v;
  }
  return digestFingerprint(extras);
}

/**
 * Fingerprint of the hrefs this doc's body may be rewritten to: its live
 * out-edges into the collection. A doc with no such edges falls back to path
 * resolution against the whole index (see `syncEntries`), so it is pinned to
 * the whole-index fingerprint instead.
 */
export function linksFingerprint(
  srcDocId: string,
  edges: OutEdge[],
  index: HrefIndex,
  wholeIndexFp: string,
): string {
  const parts: string[] = [];
  let hasAnyDocEdge = false;
  for (const e of edges) {
    if (e.src !== srcDocId) continue;
    if (!e.dst || e.dst.startsWith("phantom:") || e.dst.startsWith("x_")) continue;
    hasAnyDocEdge = true;
    const href = index.byDocId.get(e.dst);
    if (href !== undefined) parts.push(`${e.dst}=${href}`);
  }
  if (parts.length > 0) return parts.sort().join("|");
  // Edges exist but none land in this collection, or no edges at all: the
  // rewrite is gated by path resolution over the full index.
  return hasAnyDocEdge ? `idx:${wholeIndexFp}` : "";
}
