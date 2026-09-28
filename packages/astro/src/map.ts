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
 * Map a hydrated omg doc to Astro entry fields.
 * Frontmatter keys are spread into `data`; intrinsic keys are always set.
 */
export function mapDoc(
  doc: HydratedDoc,
  slugFn: (ctx: SlugContext) => string = defaultSlug,
): MappedEntry {
  const frontmatter = { ...(doc.properties.frontmatter ?? {}) };
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
