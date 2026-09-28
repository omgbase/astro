/**
 * Identity-aware markdown link rewriting for rendered omg bodies.
 *
 * When the loader has hydrated docs, each link destination that resolves to one
 * of those docs is rewritten to that doc's site `href` — keyed by omg doc id /
 * path, not by string-guessing alone. Link URL columns / projections are never
 * touched; only markdown bodies passed through {@link rewriteMarkdownLinks}.
 */

export interface HrefEntry {
  docId: string;
  path: string;
  href: string;
}

export interface HrefIndex {
  byDocId: Map<string, string>;
  /** Canonical repo-relative paths (and `.md`-stripped aliases) → href. */
  byPath: Map<string, string>;
  /** Canonical path → doc id (for edge gating). */
  docIdByPath: Map<string, string>;
}

/** Live out-edge to a document (from OQX `edges` or local `docLinks`). */
export interface OutEdge {
  src: string;
  dst: string;
  dstPath: string | null;
}

export interface HrefContext {
  path: string;
  docId: string;
  slug: string;
  properties: Record<string, Record<string, unknown>>;
}

/** Default site href: `/${slug}`. Override to match your routes (e.g. `/blog/${slug}/`). */
export function defaultHref({ slug }: HrefContext): string {
  return `/${slug}`;
}

/** Directory prefix (`""` or `"a/b/"`) of a repo-relative doc path. */
export function docDirOf(docPath: string): string {
  const i = docPath.lastIndexOf("/");
  return i < 0 ? "" : docPath.slice(0, i + 1);
}

/** Split authored destination into path + fragment (`#…` / `^…`, marker kept). */
export function splitDestination(dest: string): { path: string; fragment: string } {
  const caret = dest.indexOf("^");
  if (caret >= 0) return { path: dest.slice(0, caret), fragment: dest.slice(caret) };
  const hash = dest.indexOf("#");
  if (hash >= 0) return { path: dest.slice(0, hash), fragment: dest.slice(hash) };
  return { path: dest, fragment: "" };
}

/**
 * Canonical repo-relative path for a link as authored in `docDir`
 * (mirrors omgbase `canonicalLinkPath`).
 */
export function canonicalLinkPath(path: string, docDir = ""): string {
  if (path.startsWith("./") || path.startsWith("../")) {
    const out: string[] = [];
    for (const p of (docDir + path).split("/")) {
      if (p === "." || p === "") continue;
      if (p === "..") {
        out.pop();
        continue;
      }
      out.push(p);
    }
    return out.join("/");
  }
  return path.replace(/^\//, "");
}

function isExternalDest(path: string): boolean {
  if (!path) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(path);
}

/** Build path/id indexes for every hydrated doc we may link to. */
export function buildHrefIndex(entries: HrefEntry[]): HrefIndex {
  const byDocId = new Map<string, string>();
  const byPath = new Map<string, string>();
  const docIdByPath = new Map<string, string>();

  const rememberPath = (path: string, docId: string, href: string) => {
    byPath.set(path, href);
    docIdByPath.set(path, docId);
    if (path.toLowerCase().endsWith(".md")) {
      const stripped = path.slice(0, -3);
      byPath.set(stripped, href);
      docIdByPath.set(stripped, docId);
    }
  };

  for (const e of entries) {
    byDocId.set(e.docId, e.href);
    rememberPath(e.path, e.docId, e.href);
  }
  return { byDocId, byPath, docIdByPath };
}

/** Stable fingerprint of the href map (for digests when rewrites are enabled). */
export function hrefIndexFingerprint(index: HrefIndex): string {
  const parts: string[] = [];
  for (const [id, href] of [...index.byDocId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`${id}=${href}`);
  }
  return parts.join("|");
}

function lookupHref(
  canonical: string,
  index: HrefIndex,
): { href: string; docId: string } | null {
  const href = index.byPath.get(canonical);
  const docId = index.docIdByPath.get(canonical);
  if (href && docId) return { href, docId };
  return null;
}

/**
 * Resolve an authored destination against the href index.
 * Returns null for external, pure-fragment, dangling, or unknown targets.
 */
export function resolveLinkHref(
  dest: string,
  srcPath: string,
  index: HrefIndex,
  allowedDstIds?: Set<string>,
): string | null {
  const { path, fragment } = splitDestination(dest);
  if (!path) return null; // same-doc `#heading` / `^ref` — leave alone
  if (isExternalDest(path)) return null;

  const canonical = canonicalLinkPath(path, docDirOf(srcPath));
  const hit = lookupHref(canonical, index);
  if (!hit) return null;
  if (allowedDstIds && !allowedDstIds.has(hit.docId)) return null;

  // Avoid `href/#frag` when href already ends with `/` → `href#frag` is fine;
  // fragment already includes the marker.
  return `${hit.href}${fragment}`;
}

// Destination-bearing syntaxes (prefix, dest, suffix) — same shapes as omgbase.
const MD_LINK = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
const WIKILINK = /(!?\[\[)([^\]|]+)((?:\|[^\]]*)?\]\])/g;
const CODE_SPAN = /(`+)[^`][\s\S]*?\1/g;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Rewrite link destinations in markdown that resolve to hydrated omg docs.
 * Fenced code blocks and inline code spans are left untouched.
 */
export function rewriteMarkdownLinks(
  body: string,
  opts: {
    srcPath: string;
    hrefIndex: HrefIndex;
    /**
     * When set, only rewrite destinations whose resolved doc id appears in this
     * set (typically live out-edge `$dst` values that are also in the index).
     * When omitted, any destination that resolves to a hydrated doc is rewritten.
     */
    allowedDstIds?: Set<string>;
  },
): string {
  const { srcPath, hrefIndex, allowedDstIds } = opts;
  if (hrefIndex.byDocId.size === 0) return body;

  const replaceDest = (dest: string): string | null =>
    resolveLinkHref(dest, srcPath, hrefIndex, allowedDstIds);

  const rewriteProse = (seg: string): string => {
    let out = seg.replace(MD_LINK, (whole, pre: string, dest: string, post: string) => {
      const next = replaceDest(dest);
      return next === null ? whole : pre + next + post;
    });
    out = out.replace(WIKILINK, (whole, pre: string, dest: string, post: string) => {
      const next = replaceDest(dest);
      return next === null ? whole : pre + next + post;
    });
    return out;
  };

  /** Rewrite outside inline code spans. */
  const rewriteOutsideSpans = (seg: string): string => {
    let out = "";
    let last = 0;
    for (const m of seg.matchAll(CODE_SPAN)) {
      const start = m.index ?? 0;
      out += rewriteProse(seg.slice(last, start)) + m[0];
      last = start + m[0].length;
    }
    return out + rewriteProse(seg.slice(last));
  };

  // Split on fenced code blocks (line-oriented), rewrite only the prose regions.
  const lines = body.split("\n");
  const outLines: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let proseBuf: string[] = [];

  const flushProse = () => {
    if (proseBuf.length === 0) return;
    outLines.push(rewriteOutsideSpans(proseBuf.join("\n")));
    proseBuf = [];
  };

  for (const line of lines) {
    if (fence) {
      outLines.push(line);
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const fenceMark = open[1]!;
      if (fenceMark[0] === "`" && line.slice(open[0].length).includes("`")) {
        proseBuf.push(line);
        continue;
      }
      flushProse();
      outLines.push(line);
      fence = { ch: fenceMark[0]!, len: fenceMark.length };
      continue;
    }
    proseBuf.push(line);
  }
  flushProse();
  return outLines.join("\n");
}

/**
 * Allowed destination doc ids for a source, from live out-edges ∩ href index.
 * Phantoms / externals are dropped. Empty set means "no edge-gated targets".
 */
export function allowedDstsFor(
  srcDocId: string,
  edges: OutEdge[],
  index: HrefIndex,
): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.src !== srcDocId) continue;
    if (!e.dst || e.dst.startsWith("phantom:") || e.dst.startsWith("x_")) continue;
    if (!index.byDocId.has(e.dst)) continue;
    out.add(e.dst);
  }
  return out;
}
