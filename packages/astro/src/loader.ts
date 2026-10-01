import type { Loader, LoaderContext } from "astro/loaders";
import type { Transport } from "./transport.js";
import { createLocalTransport, type LocalTransportOptions } from "./local.js";
import { createRemoteTransport, type RemoteTransportOptions } from "./remote.js";
import { defaultSlug, type SlugContext } from "./map.js";
import { defaultHref, type HrefContext } from "./links.js";
import { startWatch, stopWatch, syncEntries, type WatchOption } from "./watch.js";

export interface OmgLoaderBaseOptions {
  /** OQX query selecting documents for this collection. Must return doc hits. */
  query: string;
  /** Optional result limit passed to OQX / the MCP `query` tool. */
  limit?: number;
  /** Repo slug (local workspace or remote multi-repo server). */
  repo?: string;
  /** Override slug generation. Default: path with `.md` stripped. */
  slug?: (ctx: SlugContext) => string;
  /**
   * Site URL for a hydrated doc (used to rewrite markdown links that resolve to
   * other docs in this load). Default: `/${slug}`. Match your routes, e.g.
   * `({ slug }) => `/blog/${slug}/``.
   *
   * Set `href: false` to leave authored destinations unchanged.
   */
  href?: false | ((ctx: HrefContext) => string);
  /**
   * Live-reload in `astro dev` (default true when Astro provides a watcher).
   * Local: Vite FS watch on the vault. Remote: poll MCP `changes_since`.
   * Store updates use the same data-store write path as glob() → existing HMR.
   */
  watch?: WatchOption;
  /** Inject a pre-built transport (tests). */
  transport?: Transport;
}

export type OmgLoaderLocalOptions = OmgLoaderBaseOptions & {
  /** Path to the omgbase workspace root (directory containing `.omgbase/`). */
  workspace: string;
  url?: undefined;
  token?: undefined;
  headers?: undefined;
  headerLines?: undefined;
  stale?: boolean;
};

export type OmgLoaderRemoteOptions = OmgLoaderBaseOptions & {
  /**
   * Streamable HTTP MCP endpoint (same as `omg … --server <url>`).
   * When set, remote MCP transport is used.
   */
  url: string;
  /** Extra headers on every MCP request (CLI `-H` as a map). */
  headers?: Record<string, string>;
  /** Extra headers as CLI `-H` strings: `["X-Foo: bar"]`. */
  headerLines?: string[];
  /** Convenience bearer token → `Authorization: Bearer …` if unset. */
  token?: string;
  workspace?: undefined;
  stale?: undefined;
};

export type OmgLoaderOptions = OmgLoaderLocalOptions | OmgLoaderRemoteOptions | OmgLoaderBaseOptions;

/** The connection-related subset of loader options shared by `omgLoader` and `omgLiveLoader`. */
export interface TransportOptions {
  url?: string | undefined;
  token?: string | undefined;
  headers?: Record<string, string> | undefined;
  headerLines?: string[] | undefined;
  workspace?: string | undefined;
  stale?: boolean | undefined;
  repo?: string | undefined;
  transport?: Transport | undefined;
}

/**
 * Pick the transport for a loader: an explicit `transport`, else remote when
 * `url` is set, else local when `workspace` is set.
 */
export function resolveTransport(opts: TransportOptions, who = "omgLoader"): Transport {
  if (opts.transport) return opts.transport;
  if (opts.url) {
    const remote: RemoteTransportOptions = {
      url: opts.url,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.headerLines !== undefined ? { headerLines: opts.headerLines } : {}),
      ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    };
    return createRemoteTransport(remote);
  }
  if (opts.workspace) {
    const local: LocalTransportOptions = {
      workspace: opts.workspace,
      ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
      ...(opts.stale !== undefined ? { stale: opts.stale } : {}),
    };
    return createLocalTransport(local);
  }
  throw new Error(
    `${who} requires either \`workspace\` (local) or \`url\` (Streamable HTTP MCP), or an explicit \`transport\``,
  );
}

/**
 * Astro Content Layer loader backed by omgbase.
 *
 * Local: opens a workspace via `@omgbase/core`, runs OQX, hydrates Markdown.
 * Remote: Streamable HTTP MCP (`query` + `docs_get_many`), same as CLI `--server`.
 * In `astro dev`, keeps the collection fresh (FS watch or `changes_since` poll)
 * through Astro's normal content-store → HMR path.
 *
 * Entry `id` is the omg document id. `data.slug` is derived from path (overridable).
 * Markdown bodies are rewritten so links to other hydrated docs use each doc's
 * site `href` (identity via omg out-edges ∩ path resolution).
 */
export function omgLoader(opts: OmgLoaderOptions): Loader {
  const slugFn = opts.slug ?? defaultSlug;
  const hrefFn: false | ((ctx: HrefContext) => string) =
    opts.href === false ? false : (opts.href ?? defaultHref);
  const watchOpt: WatchOption = opts.watch ?? true;

  return {
    name: "@omgbase/astro",
    async load(context: LoaderContext): Promise<void> {
      await stopWatch(context.collection);

      const transport = resolveTransport(opts);
      const syncOpts = {
        query: opts.query,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        slug: slugFn,
        href: hrefFn,
      };

      try {
        context.logger.info(`querying omgbase (${transport.kind})`);
        const { seen, hydrated, written } = await syncEntries(context, transport, syncOpts);
        context.logger.info(
          `loaded ${seen} entries from omgbase (${hydrated} fetched, ${written} updated)`,
        );

        if (context.watcher && watchOpt !== false) {
          await startWatch(context, transport, { ...syncOpts, watch: watchOpt });
          // Watch owns the transport lifetime.
          return;
        }

        await transport.close?.();
      } catch (err) {
        await transport.close?.();
        throw err;
      }
    },
  };
}
