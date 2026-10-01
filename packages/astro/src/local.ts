import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Workspace,
  freshnessSweep,
  oqxRun,
  docsRead,
  changesSince,
  type Store,
  type RepoRow,
} from "@omgbase/core";
import {
  outEdgesQuery,
  type ChangesPage,
  type ChangesSinceOptions,
  type DocOutEdge,
  type HydrateOptions,
  type HydratedDoc,
  type OutEdgesOptions,
  type QueryHit,
  type QueryOptions,
  type Transport,
} from "./transport.js";
import { contentHashOf, stripFrontmatter } from "./map.js";

export interface LocalTransportOptions {
  /** Path to the omgbase workspace root (directory containing `.omgbase/`). */
  workspace: string;
  /** Repo slug inside the workspace. When omitted, the sole repo is used. */
  repo?: string;
  /** Skip freshnessSweep before reads (default false). */
  stale?: boolean;
}

function resolveRepo(ws: Workspace, slug?: string): RepoRow {
  if (slug) {
    const found = ws.repoBySlug(slug);
    if (!found) {
      throw new Error(`omgbase repo not found: ${slug}`);
    }
    return found;
  }
  const repos = ws.repos();
  if (repos.length === 0) {
    throw new Error(`no omgbase repos in workspace ${ws.root}`);
  }
  if (repos.length > 1) {
    throw new Error(
      `ambiguous omgbase repo in ${ws.root}; pass repo: one of ${repos.map((r) => r.slug).join(", ")}`,
    );
  }
  return repos[0]!;
}

function openWorkspace(workspacePath: string): Workspace {
  const root = resolve(workspacePath);
  if (existsSync(join(root, ".omgbase"))) {
    return Workspace.open(root);
  }
  const found = Workspace.find(root);
  if (found) return found;
  return Workspace.open(root);
}

function toHydrated(read: NonNullable<ReturnType<typeof docsRead>>): HydratedDoc {
  return {
    id: read.docId,
    path: read.path,
    properties: read.properties,
    body: stripFrontmatter(read.content),
    contentHash: contentHashOf(read.properties, read.content),
    rev: read.rev,
  };
}

/**
 * Local transport: open a workspace via `@omgbase/core`, run OQX, hydrate with docsRead.
 */
export class LocalTransport implements Transport {
  readonly kind = "local" as const;
  private readonly ws: Workspace;
  private readonly repo: RepoRow;
  private readonly stale: boolean;

  constructor(opts: LocalTransportOptions) {
    this.ws = openWorkspace(opts.workspace);
    this.repo = resolveRepo(this.ws, opts.repo);
    this.stale = opts.stale ?? false;
  }

  get store(): Store {
    return this.ws.store;
  }

  get repoId(): string {
    return this.repo.repoId;
  }

  get watchRoot(): string | null {
    return this.repo.rootPath ?? this.ws.root;
  }

  private ensureFresh(): void {
    if (this.stale) return;
    if (this.repo.rootPath) {
      freshnessSweep(this.ws.store, this.repo.repoId, this.repo.rootPath);
    }
  }

  async query(opts: QueryOptions): Promise<QueryHit[]> {
    this.ensureFresh();
    const result = oqxRun(
      this.ws.store,
      this.repo.repoId,
      opts.query,
      opts.limit !== undefined ? { limit: opts.limit } : {},
    );
    if (result.consumer === "count" || result.consumer === "exists") {
      throw new Error(`omgLoader query must return document hits, got consumer=${result.consumer}`);
    }
    return result.hits.map((h) => {
      const { id, path, ...rest } = h;
      return { id, path, ...rest };
    });
  }

  async hydrate(opts: HydrateOptions): Promise<HydratedDoc[]> {
    this.ensureFresh();
    const out: HydratedDoc[] = [];
    for (const id of opts.ids) {
      const read = docsRead(this.ws.store, id);
      if (!read) continue;
      out.push(toHydrated(read));
    }
    return out;
  }

  async outEdges(opts: OutEdgesOptions): Promise<DocOutEdge[]> {
    this.ensureFresh();
    if (opts.ids.length === 0) return [];
    const wanted = new Set(opts.ids);
    const result = oqxRun(this.ws.store, this.repo.repoId, outEdgesQuery(opts.ids));
    const out: DocOutEdge[] = [];
    const seen = new Set<string>();
    for (const h of result.hits) {
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
    this.ensureFresh();
    const page = changesSince(this.ws.store, this.repo.repoId, {
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    return {
      digests: page.digests.map((d) => ({ seq: d.seq, summary: d.summary })),
      head: page.head,
      truncated: page.truncated,
    };
  }

  close(): void {
    this.ws.store.close();
  }
}

export function createLocalTransport(opts: LocalTransportOptions): LocalTransport {
  return new LocalTransport(opts);
}
