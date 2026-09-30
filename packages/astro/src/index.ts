export { omgLoader } from "./loader.js";
export type {
  OmgLoaderOptions,
  OmgLoaderBaseOptions,
  OmgLoaderLocalOptions,
  OmgLoaderRemoteOptions,
} from "./loader.js";

export type { Transport, QueryHit, HydratedDoc, QueryOptions, HydrateOptions, DocOutEdge } from "./transport.js";
export { createLocalTransport, LocalTransport } from "./local.js";
export type { LocalTransportOptions } from "./local.js";
export {
  createRemoteTransport,
  RemoteTransport,
  parseHeaderLine,
  resolveHeaders,
} from "./remote.js";
export type { RemoteTransportOptions, ToolClient } from "./remote.js";

export type { WatchOption, SyncResult } from "./watch.js";
export { withContentHash, encodeEntryDigest, parseEntryDigest } from "./digest.js";
export type { EntryDigest } from "./digest.js";

export { defaultSlug, stripFrontmatter, mapDoc, mergeHitProjections, contentHashOf } from "./map.js";
export type { SlugContext, MappedEntry } from "./map.js";
export type { OmgEntryIntrinsics } from "./schema.js";

export {
  defaultHref,
  buildHrefIndex,
  rewriteMarkdownLinks,
  resolveLinkHref,
  canonicalLinkPath,
  splitDestination,
  docDirOf,
} from "./links.js";
export type { HrefContext, HrefEntry, HrefIndex, OutEdge } from "./links.js";

export {
  createMcpHttpServer,
  createPublicationServer,
} from "./server.js";
export type {
  McpHttpServerOptions,
  McpHttpServer,
  PublicationServerOptions,
  PublicationServer,
} from "./server.js";
