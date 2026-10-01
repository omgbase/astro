import { describe, expect, it, vi } from "vitest";
import { OmgLiveError, omgLiveLoader } from "./live.js";
import { RemoteTransport, type ToolClient } from "./remote.js";
import { outEdgesQuery } from "./transport.js";
import type { HydratedDoc, Transport } from "./transport.js";

function doc(
  id: string,
  path: string,
  body: string,
  updatedAt: string,
  frontmatter: Record<string, unknown> = {},
): HydratedDoc {
  return {
    id,
    path,
    properties: { frontmatter, computed: { $title: `T:${id}`, $updated_at: updatedAt } },
    body,
    contentHash: `h:${id}`,
    rev: null,
  };
}

/**
 * A fake omg: `query` answers `$path == "…"` lookups and plain collection
 * queries (projecting `$title` / `$updated_at` when the query mentions them),
 * `hydrate` returns docs by id, and edges are derived from `[x](./y.md)` links.
 */
function fakeOmg(initial: HydratedDoc[]) {
  const docs = new Map(initial.map((d) => [d.id, d]));
  const byPath = () => new Map([...docs.values()].map((d) => [d.path, d.id]));
  const transport: Transport = {
    kind: "remote",
    query: vi.fn(async ({ query, limit }: { query: string; limit?: number }) => {
      let list = [...docs.values()];
      const m = /\$path == ("(?:[^"\\]|\\.)*")/.exec(query);
      if (m) {
        const wanted = JSON.parse(m[1]!) as string;
        list = list.filter((d) => d.path === wanted);
      }
      const hits = list.map((d) => ({
        id: d.id,
        path: d.path,
        ...(query.includes("$title") ? { $title: d.properties.computed!.$title } : {}),
        ...(query.includes("$updated_at") ? { $updated_at: d.properties.computed!.$updated_at } : {}),
      }));
      return limit !== undefined ? hits.slice(0, limit) : hits;
    }),
    hydrate: vi.fn(async ({ ids }: { ids: string[] }) =>
      ids.map((id) => docs.get(id)).filter((d): d is HydratedDoc => d !== undefined),
    ),
    outEdges: vi.fn(async ({ ids }: { ids: string[] }) => {
      const paths = byPath();
      const out: Array<{ src: string; dst: string; dstPath: string | null }> = [];
      for (const id of ids) {
        const d = docs.get(id);
        if (!d) continue;
        for (const m of d.body.matchAll(/\]\(\.\/([^)#]+)/g)) {
          const dstPath = `posts/${m[1]}`;
          const dst = paths.get(dstPath);
          if (dst) out.push({ src: d.id, dst, dstPath });
        }
      }
      return out;
    }),
    close: vi.fn(),
  };
  return { docs, transport };
}

const slug = ({ path }: { path: string }) => path.replace(/^posts\//, "").replace(/\.md$/, "");
const pathForSlug = (s: string) => `posts/${s}.md`;
const href = ({ slug }: { slug: string }) => `/note/${slug}/`;
const render = vi.fn(async (md: string) => ({ html: `<r>${md}</r>` }));

const COLLECTION = "select $path, $title, $updated_at from docs";

function setup(extra: Partial<Parameters<typeof omgLiveLoader>[0]> = {}) {
  const omg = fakeOmg([
    doc("d_a", "posts/a.md", "See [B](./b.md#x), [gone](./missing.md) and [ext](https://x.test).", "2026-09-01T00:00:00Z", {
      title: "Authored A",
      status: "published",
    }),
    doc("d_b", "posts/b.md", "Target", "2026-09-03T00:00:00Z"),
  ]);
  render.mockClear();
  const loader = omgLiveLoader({
    transport: omg.transport,
    query: COLLECTION,
    slug,
    pathForSlug,
    href,
    render,
    ...extra,
  });
  return { ...omg, loader };
}

const errorOf = (result: unknown): OmgLiveError => {
  expect(result).toHaveProperty("error");
  const err = (result as { error: unknown }).error;
  expect(err).toBeInstanceOf(OmgLiveError);
  return err as OmgLiveError;
};

describe("omgLiveLoader.loadCollection", () => {
  it("returns lean entries with hit projections, intrinsics and a lastModified hint", async () => {
    const { loader, transport } = setup();
    const result = await loader.loadCollection({ collection: "notes" });
    if ("error" in result) throw result.error;

    expect(result.entries.map((e) => e.id)).toEqual(["d_a", "d_b"]);
    expect(result.entries[0]!.data).toEqual({
      path: "posts/a.md",
      docId: "d_a",
      slug: "a",
      $title: "T:d_a",
      title: "T:d_a",
      $updated_at: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    expect(result.entries[0]).not.toHaveProperty("rendered");
    expect(result.entries[0]!.data).not.toHaveProperty("body");
    expect(result.cacheHint?.lastModified).toEqual(new Date("2026-09-03T00:00:00Z"));
    expect(result.entries[1]!.cacheHint?.lastModified).toEqual(new Date("2026-09-03T00:00:00Z"));
    expect(transport.hydrate).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(transport.query).toHaveBeenCalledWith({ query: COLLECTION });
  });

  it("lets the filter override query and limit", async () => {
    const { loader, transport } = setup({ limit: 10, repo: "notes" });
    const result = await loader.loadCollection({
      collection: "notes",
      filter: { query: 'select $path from docs where status == "published"', limit: 1 },
    });
    if ("error" in result) throw result.error;
    expect(result.entries).toHaveLength(1);
    expect(transport.query).toHaveBeenCalledWith({
      query: 'select $path from docs where status == "published"',
      limit: 1,
      repo: "notes",
    });
    // No $updated_at projected → no hint.
    expect(result.cacheHint).toBeUndefined();
  });

  it("hydrates every entry when asked (option or filter)", async () => {
    const { loader, transport } = setup();
    const result = await loader.loadCollection({ collection: "notes", filter: { hydrate: true } });
    if ("error" in result) throw result.error;

    expect(vi.mocked(transport.hydrate).mock.calls[0]![0].ids).toEqual(["d_a", "d_b"]);
    const a = result.entries[0]!;
    expect(a.data).toMatchObject({
      title: "Authored A", // frontmatter wins over the $title projection
      status: "published",
      $title: "T:d_a",
      updatedAt: "2026-09-01T00:00:00Z",
      path: "posts/a.md",
      docId: "d_a",
      slug: "a",
      contentHash: "h:d_a",
      body: "See [B](/note/b/#x), [gone](./missing.md) and [ext](https://x.test).",
    });
    expect(a.rendered?.html).toBe(
      "<r>See [B](/note/b/#x), [gone](./missing.md) and [ext](https://x.test).</r>",
    );
    expect(result.entries[1]!.rendered?.html).toBe("<r>Target</r>");
    expect(result.cacheHint?.lastModified).toEqual(new Date("2026-09-03T00:00:00Z"));
    expect(transport.outEdges).toHaveBeenCalledTimes(1);

    const viaOption = omgLiveLoader({ transport, query: COLLECTION, slug, href, render, hydrate: true });
    const second = await viaOption.loadCollection({ collection: "notes" });
    if ("error" in second) throw second.error;
    expect(second.entries.every((e) => e.rendered !== undefined)).toBe(true);
  });

  it("returns { error } with code query_failed instead of throwing", async () => {
    const { loader, transport } = setup();
    vi.mocked(transport.query).mockRejectedValueOnce(new Error("parse — unknown field $nope"));
    const result = await loader.loadCollection({ collection: "notes" });
    const err = errorOf(result);
    expect(err.code).toBe("query_failed");
    expect(err.message).toContain("unknown field $nope");
  });

  it("reports hydrate and render failures by code", async () => {
    const { loader, transport } = setup();
    vi.mocked(transport.hydrate).mockRejectedValueOnce(new Error("docs_get_many: boom"));
    expect(errorOf(await loader.loadCollection({ collection: "n", filter: { hydrate: true } })).code).toBe(
      "hydrate_failed",
    );
    render.mockRejectedValueOnce(new Error("shiki exploded"));
    const err = errorOf(await loader.loadCollection({ collection: "n", filter: { hydrate: true } }));
    expect(err.code).toBe("render_failed");
    expect(err.message).toContain("posts/a.md");
  });
});

describe("omgLiveLoader.loadEntry", () => {
  it("hydrates by id without querying", async () => {
    const { loader, transport } = setup();
    const entry = await loader.loadEntry({ collection: "notes", filter: { id: "d_b" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.id).toBe("d_b");
    expect(entry.data).toMatchObject({
      path: "posts/b.md",
      docId: "d_b",
      slug: "b",
      title: "T:d_b", // mapDoc's computed $title fallback
      body: "Target",
    });
    expect(entry.rendered).toEqual({ html: "<r>Target</r>" });
    expect(transport.query).not.toHaveBeenCalled();
    // Falls back to the doc's computed $updated_at when there is no hit.
    expect(entry.cacheHint?.lastModified).toEqual(new Date("2026-09-03T00:00:00Z"));
  });

  it("resolves a path (leading slash stripped) through a $path lookup, then hydrates", async () => {
    const { loader, transport } = setup();
    const entry = await loader.loadEntry({ collection: "notes", filter: { path: "/posts/a.md" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.id).toBe("d_a");
    expect(transport.query).toHaveBeenCalledWith({
      query: 'select $path, $title, $updated_at from docs where $path == "posts/a.md"',
      limit: 1,
    });
    expect(vi.mocked(transport.hydrate).mock.calls[0]![0].ids).toEqual(["d_a"]);
    // Lean hit projections merge under the hydrated data.
    expect(entry.data).toMatchObject({ $title: "T:d_a", title: "Authored A", updatedAt: "2026-09-01T00:00:00Z" });
    expect(entry.cacheHint?.lastModified).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("resolves a slug via pathForSlug", async () => {
    const { loader, transport } = setup();
    const entry = await loader.loadEntry({ collection: "notes", filter: { slug: "b" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.id).toBe("d_b");
    expect(vi.mocked(transport.query).mock.calls[0]![0].query).toContain('$path == "posts/b.md"');
  });

  it("defaults pathForSlug to the inverse of the default slug", async () => {
    const { transport } = fakeOmg([doc("d_r", "root.md", "Root", "2026-01-01T00:00:00Z")]);
    const loader = omgLiveLoader({ transport, query: COLLECTION, render });
    const entry = await loader.loadEntry({ collection: "notes", filter: { slug: "root" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.data.slug).toBe("root");
    expect(vi.mocked(transport.query).mock.calls[0]![0].query).toContain('$path == "root.md"');
  });

  it("returns undefined when nothing matches", async () => {
    const { loader } = setup();
    expect(await loader.loadEntry({ collection: "notes", filter: { path: "posts/nope.md" } })).toBeUndefined();
    expect(await loader.loadEntry({ collection: "notes", filter: { slug: "nope" } })).toBeUndefined();
    expect(await loader.loadEntry({ collection: "notes", filter: { id: "d_nope" } })).toBeUndefined();
  });

  it("rejects filters that do not name exactly one key", async () => {
    const { loader } = setup();
    for (const filter of [{}, { id: "d_a", path: "posts/a.md" }, { id: "" }]) {
      const err = errorOf(await loader.loadEntry({ collection: "notes", filter }));
      expect(err.code).toBe("invalid_filter");
    }
  });

  it("rewrites links only to edge-confirmed docs and leaves dangling ones alone", async () => {
    const { loader, transport } = setup();
    const entry = await loader.loadEntry({ collection: "notes", filter: { id: "d_a" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.data.body).toBe(
      "See [B](/note/b/#x), [gone](./missing.md) and [ext](https://x.test).",
    );
    expect(render).toHaveBeenCalledWith(entry.data.body, { docId: "d_a", path: "posts/a.md" });
    expect(transport.outEdges).toHaveBeenCalledWith({ ids: ["d_a"] });
  });

  it("ignores edges omg reports when the authored path points elsewhere", async () => {
    const { loader, transport } = setup();
    // omg says A links to B, but the body's destination resolves to a different path.
    vi.mocked(transport.outEdges!).mockResolvedValueOnce([
      { src: "d_a", dst: "d_b", dstPath: "posts/renamed.md" },
    ]);
    const entry = await loader.loadEntry({ collection: "notes", filter: { id: "d_a" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.data.body).toContain("[B](./b.md#x)");
  });

  it("leaves bodies as authored when href is false", async () => {
    const { loader, transport } = setup({ href: false });
    const entry = await loader.loadEntry({ collection: "notes", filter: { id: "d_a" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.data.body).toContain("[B](./b.md#x)");
    expect(transport.outEdges).not.toHaveBeenCalled();
  });

  it("returns { error } with code query_failed / hydrate_failed instead of throwing", async () => {
    const { loader, transport } = setup();
    vi.mocked(transport.query).mockRejectedValueOnce(new Error("Session not found"));
    expect(errorOf(await loader.loadEntry({ collection: "n", filter: { slug: "a" } })).code).toBe("query_failed");
    vi.mocked(transport.hydrate).mockRejectedValueOnce(new Error("boom"));
    expect(errorOf(await loader.loadEntry({ collection: "n", filter: { id: "d_a" } })).code).toBe("hydrate_failed");
  });

  it("keeps one transport open across requests", async () => {
    const { loader, transport } = setup();
    await loader.loadCollection({ collection: "notes" });
    await loader.loadEntry({ collection: "notes", filter: { id: "d_a" } });
    await loader.loadEntry({ collection: "notes", filter: { slug: "b" } });
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("renders markdown with @astrojs/markdown-remark by default", async () => {
    const { transport } = fakeOmg([
      doc("d_m", "posts/m.md", "# Heading\n\nSome *text*.\n", "2026-01-01T00:00:00Z"),
    ]);
    const loader = omgLiveLoader({ transport, query: COLLECTION, slug, href });
    const entry = await loader.loadEntry({ collection: "notes", filter: { id: "d_m" } });
    if (!entry || "error" in entry) throw new Error("expected an entry");
    expect(entry.rendered?.html).toContain("<h1");
    expect(entry.rendered?.html).toContain("<p>Some <em>text</em>.</p>");
  });
});

describe("outEdgesQuery", () => {
  it("filters by $src for small id sets and scans the repo above the threshold", () => {
    expect(outEdgesQuery(["d_a", "d_b", "d_a"])).toBe(
      'select $src, $dst, $dst_path from edges where dst_kind == "document" && ($src == "d_a" || $src == "d_b")',
    );
    const many = Array.from({ length: 30 }, (_, i) => `d_${i}`);
    expect(outEdgesQuery(many)).toBe('select $src, $dst, $dst_path from edges where dst_kind == "document"');
  });
});

describe("RemoteTransport.outEdges", () => {
  function clientWith(hits: unknown[]) {
    const client: ToolClient = {
      callTool: vi.fn(async <T>(): Promise<T> => ({ hits }) as T),
      close: vi.fn(async () => undefined),
    };
    return client;
  }

  it("sends an || chain of $src tests for two ids", async () => {
    const client = clientWith([
      { id: "e_1", path: null, $src: "d_a", $dst: "d_b", $dst_path: "posts/b.md" },
      { id: "e_2", path: null, $src: "d_a", $dst: "phantom:x", $dst_path: null },
    ]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect: async () => client, repo: "notes" });
    const edges = await transport.outEdges({ ids: ["d_a", "d_b"] });
    expect(client.callTool).toHaveBeenCalledWith("query", {
      query:
        'select $src, $dst, $dst_path from edges where dst_kind == "document" && ($src == "d_a" || $src == "d_b")',
      repo: "notes",
    });
    expect(edges).toEqual([{ src: "d_a", dst: "d_b", dstPath: "posts/b.md" }]);
  });

  it("falls back to the repo-wide edge scan for thirty ids and filters client-side", async () => {
    const client = clientWith([
      { id: "e_1", path: null, $src: "d_0", $dst: "d_x", $dst_path: "x.md" },
      { id: "e_2", path: null, $src: "d_other", $dst: "d_y", $dst_path: "y.md" },
    ]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect: async () => client });
    const ids = Array.from({ length: 30 }, (_, i) => `d_${i}`);
    const edges = await transport.outEdges({ ids });
    const [, args] = vi.mocked(client.callTool).mock.calls[0]!;
    expect(args).toEqual({ query: 'select $src, $dst, $dst_path from edges where dst_kind == "document"' });
    expect(edges).toEqual([{ src: "d_0", dst: "d_x", dstPath: "x.md" }]);
  });
});
