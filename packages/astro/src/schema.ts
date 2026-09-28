/**
 * Intrinsic fields always written by {@link omgLoader} into entry `data`.
 * Site schemas typically `z.object({ title: z.string(), ... }).passthrough()`
 * or explicitly include these keys.
 */
export interface OmgEntryIntrinsics {
  /** Repository-relative document path (e.g. `posts/hello.md`). */
  path: string;
  /** Stable omg document id — also the Astro entry id. */
  docId: string;
  /** Content hash when available from omg computed properties. */
  contentHash: string | null;
  /** Routing slug derived from path (or a custom `slug` option). */
  slug: string;
}
