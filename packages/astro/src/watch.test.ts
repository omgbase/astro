import { afterEach, describe, expect, it, vi } from "vitest";
import { startWatch, syncEntries, stopWatch } from "./watch.js";
import type { HydratedDoc, Transport } from "./transport.js";
import type { LoaderContext } from "astro/loaders";

type StoreEntry = {
  id: string;
  data: Record<string, unknown>;
  digest?: string;
  body?: string;
  rendered?: { html: string };
};

type Logged = { level: "info" | "warn" | "error"; msg: string };

function mockContext(): LoaderContext & { renders: string[]; logged: Logged[] } {
  const entries = new Map<string, StoreEntry>();
  const meta = new Map<string, string>();
  const renders: string[] = [];
  const logged: Logged[] = [];
  return {
    renders,
    logged,
    collection: "posts",
    store: {
      get: (id: string) => entries.get(id),
      set: (entry: StoreEntry) => {
        entries.set(entry.id, entry);
        return true;
      },
      keys: () => [...entries.keys()],
      delete: (id: string) => {
        entries.delete(id);
      },
      clear: () => entries.clear(),
      has: (id: string) => entries.has(id),
      entries: () => [...entries.entries()] as never,
      values: () => [...entries.values()] as never,
      addModuleImport: () => undefined,
    },
    meta: {
      get: (k: string) => meta.get(k),
      set: (k: string, v: string) => {
        meta.set(k, v);
      },
      delete: (k: string) => {
        meta.delete(k);
      },
      has: (k: string) => meta.has(k),
    },
    logger: {
      info: (msg: string) => logged.push({ level: "info", msg }),
      warn: (msg: string) => logged.push({ level: "warn", msg }),
      error: (msg: string) => logged.push({ level: "error", msg }),
      debug: () => undefined,
      fork: () => undefined as never,
    } as never,
    config: {} as never,
    parseData: async ({ data }) => data,
    renderMarkdown: async (content: string) => {
      renders.push(content);
      return { html: `<p>${content}</p>` };
    },
    generateDigest: (data: string | Record<string, unknown>) =>
      typeof data === "string" ? `d:${data.length}` : `d:${Object.keys(data).length}`,
  } as unknown as LoaderContext & { renders: string[]; logged: Logged[] };
}

const slug = ({ path }: { path: string }) => path.replace(/^posts\//, "").replace(/\.md$/, "");
const href = ({ slug }: { slug: string }) => `/blog/${slug}/`;

function doc(
  id: string,
  path: string,
  body: string,
  hash: string,
  frontmatter: Record<string, unknown> = { title: id },
): HydratedDoc {
  return {
    id,
    path,
    properties: { frontmatter, computed: { $content_hash: hash } },
    body,
    contentHash: hash,
    rev: null,
  };
}

/**
 * A fake omg: docs keyed by id, hits carry `$content_hash` when the query asks
 * for it, edges are derived from `[x](./y.md)` links in bodies.
 */
function fakeOmg(initial: HydratedDoc[]) {
  const docs = new Map(initial.map((d) => [d.id, d]));
  const byPath = () => new Map([...docs.values()].map((d) => [d.path, d.id]));
  const transport: Transport = {
    kind: "remote",
    query: vi.fn(async ({ query }: { query: string }) => {
      const withHash = query.includes("$content_hash");
      return [...docs.values()].map((d) => ({
        id: d.id,
        path: d.path,
        ...(withHash ? { $content_hash: d.contentHash } : {}),
      }));
    }),
    hydrate: vi.fn(async ({ ids }: { ids: string[] }) =>
      ids.map((id) => docs.get(id)).filter((d): d is HydratedDoc => d !== undefined),
    ),
    outEdges: vi.fn(async () => {
      const paths = byPath();
      const out: Array<{ src: string; dst: string; dstPath: string | null }> = [];
      for (const d of docs.values()) {
        for (const m of d.body.matchAll(/\]\(\.\/([^)#]+)/g)) {
          const dstPath = `posts/${m[1]}`;
          const dst = paths.get(dstPath);
          if (dst) out.push({ src: d.id, dst, dstPath });
        }
      }
      return out;
    }),
  };
  return { docs, transport };
}

const hydratedIds = (transport: Transport) =>
  vi.mocked(transport.hydrate).mock.calls.flatMap((c) => c[0].ids);

describe("syncEntries", () => {
  it("writes hydrated docs into the store", async () => {
    const { transport } = fakeOmg([
      doc("d_1", "posts/a.md", "Hello", "h1", { title: "A", status: "published" }),
    ]);
    const ctx = mockContext();
    const { seen, written, hydrated } = await syncEntries(ctx, transport, {
      query: "from docs",
      slug,
      href,
    });
    expect(seen).toBe(1);
    expect(written).toBe(1);
    expect(hydrated).toBe(1);
    expect(ctx.store.get("d_1")?.data).toMatchObject({ title: "A", slug: "a" });
    expect(ctx.store.get("d_1")?.data).not.toHaveProperty("$content_hash");
  });

  it("projects $content_hash onto the user's query", async () => {
    const { transport } = fakeOmg([doc("d_1", "posts/a.md", "Hello", "h1")]);
    await syncEntries(mockContext(), transport, {
      query: 'select $path, $title from docs where layer == "canon"',
      slug,
      href,
    });
    expect(transport.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'select $content_hash, $path, $title from docs where layer == "canon"',
      }),
    );
  });

  it("rewrites markdown links to other hydrated docs", async () => {
    const { transport } = fakeOmg([
      doc("d_a", "posts/a.md", "See [B](./b.md#x) and [ext](https://x.test).", "a"),
      doc("d_b", "posts/b.md", "Target", "b"),
    ]);
    const ctx = mockContext();
    await syncEntries(ctx, transport, { query: "from docs", slug, href });
    expect(ctx.store.get("d_a")?.body).toBe("See [B](/blog/b/#x) and [ext](https://x.test).");
    expect(transport.outEdges).toHaveBeenCalled();
  });

  it("does not fetch, render, or scan edges when nothing changed", async () => {
    const { transport } = fakeOmg([
      doc("d_a", "posts/a.md", "See [B](./b.md).", "a"),
      doc("d_b", "posts/b.md", "Target", "b"),
    ]);
    const ctx = mockContext();
    const opts = { query: "from docs", slug, href };
    await syncEntries(ctx, transport, opts);
    vi.mocked(transport.hydrate).mockClear();
    vi.mocked(transport.outEdges!).mockClear();
    ctx.renders.length = 0;

    const second = await syncEntries(ctx, transport, opts);
    expect(second).toEqual({ seen: 2, written: 0, hydrated: 0 });
    expect(transport.hydrate).not.toHaveBeenCalled();
    expect(transport.outEdges).not.toHaveBeenCalled();
    expect(ctx.renders).toEqual([]);
    expect(ctx.store.get("d_a")?.body).toBe("See [B](/blog/b/).");
  });

  it("fetches and re-renders only the doc whose hash changed", async () => {
    const { docs, transport } = fakeOmg([
      doc("d_a", "posts/a.md", "See [B](./b.md).", "a1"),
      doc("d_b", "posts/b.md", "Target", "b1"),
    ]);
    const ctx = mockContext();
    const opts = { query: "from docs", slug, href };
    await syncEntries(ctx, transport, opts);
    vi.mocked(transport.hydrate).mockClear();
    ctx.renders.length = 0;

    docs.set("d_b", doc("d_b", "posts/b.md", "Target v2", "b2"));
    const r = await syncEntries(ctx, transport, opts);
    expect(r).toEqual({ seen: 2, written: 1, hydrated: 1 });
    expect(hydratedIds(transport)).toEqual(["d_b"]);
    expect(ctx.renders).toEqual(["Target v2"]);
    expect(ctx.store.get("d_b")?.body).toBe("Target v2");
    // A still links to B at the same href; untouched.
    expect(ctx.store.get("d_a")?.body).toBe("See [B](/blog/b/).");
  });

  it("re-fetches only the linkers of a newly added doc", async () => {
    const { docs, transport } = fakeOmg([
      doc("d_a", "posts/a.md", "See [C](./c.md).", "a"),
      doc("d_b", "posts/b.md", "Unrelated", "b"),
    ]);
    const ctx = mockContext();
    const opts = { query: "from docs", slug, href };
    await syncEntries(ctx, transport, opts);
    // C doesn't exist yet, so A's link is left as authored.
    expect(ctx.store.get("d_a")?.body).toBe("See [C](./c.md).");
    vi.mocked(transport.hydrate).mockClear();

    docs.set("d_c", doc("d_c", "posts/c.md", "New", "c"));
    const r = await syncEntries(ctx, transport, opts);
    expect(r.hydrated).toBe(2);
    expect(new Set(hydratedIds(transport))).toEqual(new Set(["d_c", "d_a"]));
    expect(ctx.store.get("d_a")?.body).toBe("See [C](/blog/c/).");
    expect(ctx.store.get("d_b")?.body).toBe("Unrelated");
  });

  it("re-fetches linkers when a target's path (and href) moves", async () => {
    const { docs, transport } = fakeOmg([
      doc("d_a", "posts/a.md", "See [B](./b.md).", "a"),
      doc("d_b", "posts/b.md", "Target", "b"),
    ]);
    const ctx = mockContext();
    const opts = { query: "from docs", slug, href };
    await syncEntries(ctx, transport, opts);
    vi.mocked(transport.hydrate).mockClear();

    // Same content hash, new path → new slug/href.
    docs.set("d_b", doc("d_b", "posts/renamed.md", "Target", "b"));
    // A's authored link still says ./b.md; omg keeps the edge by identity.
    vi.mocked(transport.outEdges!).mockResolvedValue([
      { src: "d_a", dst: "d_b", dstPath: "posts/renamed.md" },
    ]);
    const r = await syncEntries(ctx, transport, opts);
    expect(new Set(hydratedIds(transport))).toEqual(new Set(["d_b", "d_a"]));
    expect(r.written).toBe(2);
    expect(ctx.store.get("d_b")?.data.slug).toBe("renamed");
  });

  it("drops entries that fell out of the query", async () => {
    const { docs, transport } = fakeOmg([
      doc("d_a", "posts/a.md", "A", "a"),
      doc("d_b", "posts/b.md", "B", "b"),
    ]);
    const ctx = mockContext();
    const opts = { query: "from docs", slug, href };
    await syncEntries(ctx, transport, opts);
    docs.delete("d_b");
    const r = await syncEntries(ctx, transport, opts);
    expect(r.seen).toBe(1);
    expect(ctx.store.has("d_b")).toBe(false);
    expect(ctx.store.has("d_a")).toBe(true);
  });

  it("re-maps an entry when its hit projections change without a content change", async () => {
    const { transport } = fakeOmg([doc("d_a", "posts/a.md", "A", "a")]);
    let title = "First";
    vi.mocked(transport.query).mockImplementation(async () => [
      { id: "d_a", path: "posts/a.md", $content_hash: "a", $title: title },
    ]);
    const ctx = mockContext();
    const opts = { query: "select $title from docs", slug, href };
    await syncEntries(ctx, transport, opts);
    expect(ctx.store.get("d_a")?.data.$title).toBe("First");
    vi.mocked(transport.hydrate).mockClear();

    title = "Second";
    const r = await syncEntries(ctx, transport, opts);
    expect(r.hydrated).toBe(1);
    expect(ctx.store.get("d_a")?.data.$title).toBe("Second");
  });

  it("falls back to hydrating everything when the server rejects the hash projection", async () => {
    const { transport } = fakeOmg([
      doc("d_a", "posts/a.md", "A", "a"),
      doc("d_b", "posts/b.md", "B", "b"),
    ]);
    const plain = vi.mocked(transport.query).getMockImplementation()!;
    vi.mocked(transport.query).mockImplementation(async (o) => {
      if (o.query.includes("$content_hash")) throw new Error("unknown field $content_hash");
      return plain(o);
    });
    const ctx = mockContext();
    const opts = { query: "from docs", slug, href };
    const first = await syncEntries(ctx, transport, opts);
    expect(first).toEqual({ seen: 2, written: 2, hydrated: 2 });
    vi.mocked(transport.hydrate).mockClear();
    ctx.renders.length = 0;

    // Still fetches every body, but the digest compare avoids re-rendering.
    const second = await syncEntries(ctx, transport, opts);
    expect(second).toEqual({ seen: 2, written: 0, hydrated: 2 });
    expect(ctx.renders).toEqual([]);
  });

  it("re-hydrates entries stored under the legacy digest format once", async () => {
    const { transport } = fakeOmg([doc("d_a", "posts/a.md", "A", "a")]);
    const ctx = mockContext();
    ctx.store.set({
      id: "d_a",
      data: { slug: "a" },
      digest: "a|path:posts/a.md|rev:|fm:{}",
      body: "A",
    });
    const opts = { query: "from docs", slug, href };
    const first = await syncEntries(ctx, transport, opts);
    expect(first.hydrated).toBe(1);
    vi.mocked(transport.hydrate).mockClear();
    const second = await syncEntries(ctx, transport, opts);
    expect(second.hydrated).toBe(0);
  });
});

describe("stopWatch", () => {
  it("is a no-op when nothing is watching", async () => {
    await expect(stopWatch("missing")).resolves.toBeUndefined();
  });
});

describe("startWatch remote polling", () => {
  afterEach(async () => {
    await stopWatch("posts");
    vi.useRealTimers();
  });

  /** A fake Vite watcher: enough of the FSWatcher surface for startWatch. */
  const fakeWatcher = () =>
    ({ add: () => undefined, on: () => undefined, off: () => undefined }) as never;

  it("warns once while the server is unreachable and logs recovery once", async () => {
    vi.useFakeTimers();
    const { transport } = fakeOmg([doc("d_a", "posts/a.md", "A", "a")]);
    let down = false;
    transport.changesSince = vi.fn(async () => {
      if (down) throw new Error("fetch failed");
      return { digests: [], head: 7, truncated: false };
    });
    const ctx = mockContext();
    ctx.watcher = fakeWatcher();
    await startWatch(ctx, transport, {
      query: "from docs",
      slug,
      href,
      watch: { intervalMs: 100 },
    });
    ctx.logged.length = 0;

    down = true;
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(100);
    const warns = ctx.logged.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toMatch(/unreachable, retrying every 100ms.*fetch failed/);

    down = false;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.logged.filter((l) => l.level === "warn")).toHaveLength(1);
    const infos = ctx.logged.filter((l) => l.level === "info" && /reachable again/.test(l.msg));
    expect(infos).toHaveLength(1);
    expect(transport.changesSince).toHaveBeenCalledTimes(1 + 5 + 2);
  });
});
