export { omgLoader } from "./loader.js";
export type {
  OmgLoaderOptions,
  OmgLoaderBaseOptions,
  OmgLoaderLocalOptions,
  OmgLoaderRemoteOptions,
} from "./loader.js";

export type { Transport, QueryHit, HydratedDoc, QueryOptions, HydrateOptions } from "./transport.js";
export { createLocalTransport, LocalTransport } from "./local.js";
export type { LocalTransportOptions } from "./local.js";
export {
  createRemoteTransport,
  RemoteTransport,
  parseHeaderLine,
  resolveHeaders,
} from "./remote.js";
export type { RemoteTransportOptions } from "./remote.js";

export type { WatchOption } from "./watch.js";

export { defaultSlug, stripFrontmatter, mapDoc, contentHashOf } from "./map.js";
export type { SlugContext, MappedEntry } from "./map.js";
export type { OmgEntryIntrinsics } from "./schema.js";

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
