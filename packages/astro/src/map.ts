import type { HydratedDoc } from "./transport.js";

export interface SlugContext {
  path: string;
  docId: string;
  properties: Record<string, Record<string, unknown>>;
}

/** Default slug: document path with a trailing `.md` removed. */
export function defaultSlug({ path }: SlugContext): string {
  return path.replace(/\.md$/i, "");
}

/** Strip a leading YAML frontmatter fence from reconstructed file bytes. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const nl = content.startsWith("---\r\n") ? "\r\n" : "\n";
  const close = content.indexOf(`${nl}---`, 3);
  if (close === -1) return content;
  let rest = content.slice(close + nl.length + 3);
  // Drop the fence's trailing newline and any blank line that conventionally
  // separates frontmatter from the body.
  rest = rest.replace(/^(?:\r?\n)+/, "");
  return rest;
}

/** Prefer computed `$content_hash`, else null (caller may digest the body). */
export function contentHashOf(
  properties: Record<string, Record<string, unknown>>,
  fullContent?: string,
): string | null {
  const computed = properties.computed ?? {};
  const hash = computed.$content_hash;
  if (typeof hash === "string" && hash.length > 0) return hash;
  // Some workspaces materialize content_hash without the $ prefix.
  const plain = computed.content_hash;
  if (typeof plain === "string" && plain.length > 0) return plain;
  void fullContent;
  return null;
}

export interface MappedEntry {
  id: string;
  data: Record<string, unknown>;
  body: string;
  digest: string;
}

/**
 * Fold lean OQX hit projections into entry data (e.g. `$updated_at` from
 * `select …`). Intrinsic `id` / `path` stay on the hit; everything else merges
 * under the hydrated frontmatter so authored fields win on collision.
 * Also aliases `$updated_at` → `updatedAt` and `$title` → `title` when absent.
 */
export function mergeHitProjections(
  data: Record<string, unknown>,
  hit: { id: string; path: string; [key: string]: unknown },
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hit)) {
    if (key === "id" || key === "path") continue;
    extras[key] = value;
  }
  if (extras.$updated_at !== undefined && data.updatedAt === undefined) {
    extras.updatedAt = extras.$updated_at;
  }
  if (typeof extras.$title === "string" && data.title === undefined) {
    extras.title = extras.$title;
  }
  return { ...extras, ...data };
}

/**
 * Stable fingerprint for digest inputs. Order-insensitive for plain objects so
 * frontmatter key reshuffles don't thrash the content store.
 */
export function digestFingerprint(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => digestFingerprint(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${digestFingerprint(v)}`).join(",")}}`;
}

/**
 * Map a hydrated omg doc to Astro entry fields.
 * Frontmatter keys are spread into `data`; intrinsic keys are always set.
 * When frontmatter has no `title`, computed `$title` is used.
 */
export function mapDoc(
  doc: HydratedDoc,
  slugFn: (ctx: SlugContext) => string = defaultSlug,
): MappedEntry {
  const frontmatter = { ...(doc.properties.frontmatter ?? {}) };
  const computed = doc.properties.computed ?? {};
  if (frontmatter.title === undefined && typeof computed.$title === "string") {
    frontmatter.title = computed.$title;
  }
  const slug = slugFn({
    path: doc.path,
    docId: doc.id,
    properties: doc.properties,
  });
  // Digest must change for path moves, rev bumps, and frontmatter-only edits.
  // `$content_hash` is often absent remotely; falling back to body length alone
  // would skip status/priority/etc. updates in Astro's content store.
  const contentDigest = doc.contentHash ?? `body:${doc.body.length}`;
  const digest = [
    contentDigest,
    `path:${doc.path}`,
    `rev:${doc.rev ?? ""}`,
    `fm:${digestFingerprint(frontmatter)}`,
  ].join("|");
  return {
    id: doc.id,
    data: {
      ...frontmatter,
      path: doc.path,
      docId: doc.id,
      contentHash: doc.contentHash,
      slug,
    },
    body: doc.body,
    digest,
  };
}
