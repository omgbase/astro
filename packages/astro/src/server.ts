import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Workspace, freshnessSweep, buildServer, type RepoRow } from "@omgbase/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpHttpServerOptions {
  /** Path to the omgbase workspace root. */
  workspace: string;
  /** Default repo slug for tools that omit `repo`. */
  repo?: string;
  /** Optional bearer token required on `Authorization`. */
  token?: string;
  host?: string;
  port?: number;
  /** Skip freshnessSweep before serving (default false). */
  stale?: boolean;
  /**
   * URL path of the MCP endpoint (default `/mcp`).
   * The returned `url` includes this path — pass it verbatim to `--server` / `omgLoader({ url })`.
   */
  path?: string;
}

export interface McpHttpServer {
  server: Server;
  /** Full Streamable HTTP MCP URL (including path). */
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

function resolveRepo(ws: Workspace, slug?: string): RepoRow {
  if (slug) {
    const found = ws.repoBySlug(slug);
    if (!found) throw new Error(`repo not found: ${slug}`);
    return found;
  }
  const repos = ws.repos();
  if (repos.length === 0) throw new Error("no repos in workspace");
  if (repos.length > 1) {
    throw new Error(`ambiguous repo; pass repo: one of ${repos.map((r) => r.slug).join(", ")}`);
  }
  return repos[0]!;
}

function authorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, value] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && value === token;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Demo/CI Streamable HTTP MCP server for a local workspace.
 *
 * Same protocol as `omg … --server https://…` against a stdio-mcp-to-http wrapper
 * or a future `omg serve`. Prefer pointing production builds at your real MCP HTTP
 * endpoint; this helper is for local remote-transport demos without that wrapper.
 */
export async function createMcpHttpServer(opts: McpHttpServerOptions): Promise<McpHttpServer> {
  const ws = Workspace.open(opts.workspace);
  const repo = resolveRepo(ws, opts.repo);
  if (!opts.stale && repo.rootPath) {
    freshnessSweep(ws.store, repo.repoId, repo.rootPath);
  }

  const mcp = buildServer({
    store: ws.store,
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport as unknown as McpTransport);

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const mcpPath = opts.path ?? "/mcp";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        if (!authorized(req, opts.token)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as unknown) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP HTTP server failed to bind");
  }

  const url = `http://${host}:${address.port}${mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`}`;

  return {
    server,
    url,
    host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(async (err) => {
          try {
            await mcp.close();
            ws.store.close();
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/** @deprecated Use {@link createMcpHttpServer}. */
export const createPublicationServer = createMcpHttpServer;
/** @deprecated Use {@link McpHttpServerOptions}. */
export type PublicationServerOptions = McpHttpServerOptions;
/** @deprecated Use {@link McpHttpServer}. */
export type PublicationServer = McpHttpServer;
