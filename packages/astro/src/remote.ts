import { connectHttpEngine, type McpEngineClient } from "@omgbase/sync";
import type {
  ChangesPage,
  ChangesSinceOptions,
  DocOutEdge,
  HydrateOptions,
  HydratedDoc,
  OutEdgesOptions,
  QueryHit,
  QueryOptions,
  Transport,
} from "./transport.js";
import { contentHashOf, stripFrontmatter } from "./map.js";

/** Parse a CLI-style `-H "Name: value"` line into a header pair. */
export function parseHeaderLine(line: string): [string, string] {
  const i = line.indexOf(":");
  if (i <= 0) {
    throw new Error(`invalid header (expected "Name: value"): ${line}`);
  }
  const name = line.slice(0, i).trim();
  const value = line.slice(i + 1).trim();
  if (!name) throw new Error(`invalid header name: ${line}`);
  return [name, value];
}

/**
 * Merge header sources the same way the CLI does for `--server` + `-H`:
 * explicit map, then `-H`-style lines, then optional bearer `token`.
 */
export function resolveHeaders(opts: {
  headers?: Record<string, string>;
  headerLines?: string[];
  token?: string;
}): Record<string, string> {
  const out: Record<string, string> = { ...(opts.headers ?? {}) };
  for (const line of opts.headerLines ?? []) {
    const [name, value] = parseHeaderLine(line);
    out[name] = value;
  }
  if (opts.token) {
    const hasAuth = Object.keys(out).some((k) => k.toLowerCase() === "authorization");
    if (!hasAuth) out.Authorization = `Bearer ${opts.token}`;
  }
  return out;
}

export interface RemoteTransportOptions {
  /**
   * Streamable HTTP MCP endpoint URL (same as `omg … --server <url>`).
   * Use the full URL including any secret path prefix.
   */
  url: string;
  /** Extra headers sent on every request (CLI `-H` equivalent as a map). */
  headers?: Record<string, string>;
  /** Extra headers as CLI `-H` strings: `["X-Foo: bar", "Authorization: Bearer …"]`. */
  headerLines?: string[];
  /** Convenience: sets `Authorization: Bearer <token>` if Authorization is unset. */
  token?: string;
  /** Default repo slug passed to MCP tools when the call omits `repo`. */
  repo?: string;
  /**
   * Connection factory (defaults to `connectHttpEngine`). Exposed so tests can
   * inject a fake client; production code never needs to set it.
   */
  connect?: (spec: {
    url: string;
    headers?: Record<string, string>;
  }) => Promise<ToolClient>;
}

/** The slice of `McpEngineClient` the transport uses. */
export type ToolClient = Pick<McpEngineClient, "callTool" | "close">;

/**
 * Does this error mean the MCP session/connection behind the client is gone,
 * so a fresh connection (rather than the same request again) might succeed?
 *
 * Covers the Streamable HTTP "Session not found" (JSON-RPC -32001) a restarted
 * server returns for a stale session id, plus connection-level failures.
 */
export function isConnectionLost(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/session not found/i.test(msg)) return true;
  if (/-32001/.test(msg)) return true;
  if (/\b(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(msg)) return true;
  if (/fetch failed|socket hang up/i.test(msg)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === -32001) return true;
  return typeof code === "string" && /^E(CONNREFUSED|CONNRESET|PIPE|TIMEDOUT|NOTFOUND|AI_AGAIN)$/.test(code);
}

interface QueryToolResult {
  hits?: QueryHit[];
  consumer?: string;
}

interface DocsGetManyResult {
  items: Array<{
    docId: string;
    path: string;
    properties: Record<string, Record<string, unknown>>;
    content: string;
    rev: string | null;
  }>;
  errors?: Array<{ ref: string; error: string }>;
  truncated?: boolean;
}

const HYDRATE_CHUNK = 100;

/**
 * Remote transport over Streamable HTTP MCP — the same path as
 * `omg sync --server https://…` / `connectHttpEngine`.
 *
 * Calls `query` then `docs_get_many` for the build-time content load.
 */
export class RemoteTransport implements Transport {
  readonly kind = "remote" as const;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly repo: string | undefined;
  private readonly connect: NonNullable<RemoteTransportOptions["connect"]>;
  private client: ToolClient | null = null;

  constructor(opts: RemoteTransportOptions) {
    this.url = opts.url;
    this.headers = resolveHeaders(opts);
    this.repo = opts.repo;
    this.connect = opts.connect ?? connectHttpEngine;
  }

  private async ensureClient(): Promise<ToolClient> {
    if (this.client) return this.client;
    this.client = await this.connect({
      url: this.url,
      ...(Object.keys(this.headers).length > 0 ? { headers: this.headers } : {}),
    });
    return this.client;
  }

  /** Drop the cached client, closing it best-effort (it may already be dead). */
  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // A dead session can't be closed cleanly; nothing to do.
    }
  }

  /**
   * Call a tool on the long-lived client. If the call fails because the
   * session or connection is gone (server restarted, Streamable HTTP session
   * expired), reconnect and retry exactly once. Any other error, and the
   * retry's own error, propagate unchanged.
   */
  private async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.ensureClient();
    try {
      return await client.callTool<T>(name, args);
    } catch (err) {
      if (!isConnectionLost(err)) throw err;
      await this.dropClient();
      const fresh = await this.ensureClient();
      return await fresh.callTool<T>(name, args);
    }
  }

  async query(opts: QueryOptions): Promise<QueryHit[]> {
    const args: Record<string, unknown> = { query: opts.query };
    if (opts.limit !== undefined) args.limit = opts.limit;
    const repo = opts.repo ?? this.repo;
    if (repo !== undefined) args.repo = repo;

    const result = await this.callTool<QueryToolResult>("query", args);
    if (result.consumer === "count" || result.consumer === "exists") {
      throw new Error(`omgLoader query must return document hits, got consumer=${result.consumer}`);
    }
    return (result.hits ?? []).map((h) => {
      const { id, path, ...rest } = h;
      return { id, path, ...rest };
    });
  }

  async hydrate(opts: HydrateOptions): Promise<HydratedDoc[]> {
    const repo = opts.repo ?? this.repo;
    const out: HydratedDoc[] = [];

    for (let i = 0; i < opts.ids.length; i += HYDRATE_CHUNK) {
      const chunk = opts.ids.slice(i, i + HYDRATE_CHUNK);
      const args: Record<string, unknown> = { docs: chunk };
      if (repo !== undefined) args.repo = repo;
      const result = await this.callTool<DocsGetManyResult>("docs_get_many", args);
      for (const item of result.items ?? []) {
        out.push({
          id: item.docId,
          path: item.path,
          properties: item.properties,
          body: stripFrontmatter(item.content),
          contentHash: contentHashOf(item.properties, item.content),
          rev: item.rev,
        });
      }
    }
    return out;
  }

  async outEdges(opts: OutEdgesOptions): Promise<DocOutEdge[]> {
    if (opts.ids.length === 0) return [];
    const wanted = new Set(opts.ids);
    const hits = await this.query({
      query: `$src, $dst, $dst_path from edges where dst_kind == "document"`,
      ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    });
    const out: DocOutEdge[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const src = typeof h.$src === "string" ? h.$src : null;
      const dst = typeof h.$dst === "string" ? h.$dst : null;
      if (!src || !dst || !wanted.has(src)) continue;
      if (dst.startsWith("phantom:")) continue;
      const key = `${src}\0${dst}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        src,
        dst,
        dstPath: typeof h.$dst_path === "string" ? h.$dst_path : null,
      });
    }
    return out;
  }

  async changesSince(opts: ChangesSinceOptions = {}): Promise<ChangesPage> {
    const args: Record<string, unknown> = {};
    if (opts.cursor !== undefined) args.cursor = opts.cursor;
    if (opts.limit !== undefined) args.limit = opts.limit;
    const repo = opts.repo ?? this.repo;
    if (repo !== undefined) args.repo = repo;
    const page = await this.callTool<{
      digests: Array<{ seq: number; summary?: string }>;
      head: number;
      truncated: boolean;
    }>("changes_since", args);
    return {
      digests: page.digests ?? [],
      head: page.head,
      truncated: page.truncated ?? false,
    };
  }

  async close(): Promise<void> {
    await this.dropClient();
  }
}

export function createRemoteTransport(opts: RemoteTransportOptions): RemoteTransport {
  return new RemoteTransport(opts);
}
