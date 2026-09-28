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
  const digest = doc.contentHash ?? `body:${doc.body.length}`;
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
