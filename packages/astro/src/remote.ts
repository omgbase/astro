import { connectHttpEngine, type McpEngineClient } from "@omgbase/sync";
import type {
  ChangesPage,
  ChangesSinceOptions,
  HydrateOptions,
  HydratedDoc,
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
  private client: McpEngineClient | null = null;

  constructor(opts: RemoteTransportOptions) {
    this.url = opts.url;
    this.headers = resolveHeaders(opts);
    this.repo = opts.repo;
  }

  private async ensureClient(): Promise<McpEngineClient> {
    if (this.client) return this.client;
    this.client = await connectHttpEngine({
      url: this.url,
      ...(Object.keys(this.headers).length > 0 ? { headers: this.headers } : {}),
    });
    return this.client;
  }

  async query(opts: QueryOptions): Promise<QueryHit[]> {
    const client = await this.ensureClient();
    const args: Record<string, unknown> = { query: opts.query };
    if (opts.limit !== undefined) args.limit = opts.limit;
    const repo = opts.repo ?? this.repo;
    if (repo !== undefined) args.repo = repo;

    const result = await client.callTool<QueryToolResult>("query", args);
    if (result.consumer === "count" || result.consumer === "exists") {
      throw new Error(`omgLoader query must return document hits, got consumer=${result.consumer}`);
    }
    return (result.hits ?? []).map((h) => {
      const { id, path, ...rest } = h;
      return { id, path, ...rest };
    });
  }

  async hydrate(opts: HydrateOptions): Promise<HydratedDoc[]> {
    const client = await this.ensureClient();
    const repo = opts.repo ?? this.repo;
    const out: HydratedDoc[] = [];

    for (let i = 0; i < opts.ids.length; i += HYDRATE_CHUNK) {
      const chunk = opts.ids.slice(i, i + HYDRATE_CHUNK);
      const args: Record<string, unknown> = { docs: chunk };
      if (repo !== undefined) args.repo = repo;
      const result = await client.callTool<DocsGetManyResult>("docs_get_many", args);
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

  async changesSince(opts: ChangesSinceOptions = {}): Promise<ChangesPage> {
    const client = await this.ensureClient();
    const args: Record<string, unknown> = {};
    if (opts.cursor !== undefined) args.cursor = opts.cursor;
    if (opts.limit !== undefined) args.limit = opts.limit;
    const repo = opts.repo ?? this.repo;
    if (repo !== undefined) args.repo = repo;
    const page = await client.callTool<{
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
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

export function createRemoteTransport(opts: RemoteTransportOptions): RemoteTransport {
  return new RemoteTransport(opts);
}
