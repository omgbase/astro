import { describe, expect, it, vi } from "vitest";
import { syncEntries, stopWatch } from "./watch.js";
import type { Transport } from "./transport.js";
import type { LoaderContext } from "astro/loaders";

function mockContext(): LoaderContext {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; digest?: string; body?: string }>();
  return {
    collection: "posts",
    store: {
      get: (id: string) => entries.get(id),
      set: (entry: { id: string; data: Record<string, unknown>; digest?: string; body?: string }) => {
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
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
      has: () => false,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      fork: () => undefined as never,
    } as never,
    config: {} as never,
    parseData: async ({ data }) => data,
    renderMarkdown: async (content: string) => ({ html: `<p>${content}</p>` }),
    generateDigest: (data: string | Record<string, unknown>) =>
      typeof data === "string" ? `d:${data.length}` : `d:${Object.keys(data).length}`,
  } as unknown as LoaderContext;
}

describe("syncEntries", () => {
  it("writes hydrated docs into the store", async () => {
    const transport: Transport = {
      kind: "remote",
      query: vi.fn(async () => [{ id: "d_1", path: "posts/a.md" }]),
      hydrate: vi.fn(async () => [
        {
          id: "d_1",
          path: "posts/a.md",
          properties: { frontmatter: { title: "A", status: "published" } },
          body: "Hello",
          contentHash: "abc",
          rev: "r_1",
        },
      ]),
    };
    const ctx = mockContext();
    const { seen, written } = await syncEntries(ctx, transport, {
      query: "from docs",
      slug: ({ path }) => path.replace(/\.md$/, ""),
      href: ({ slug }) => `/blog/${slug}/`,
    });
    expect(seen).toBe(1);
    expect(written).toBe(1);
    expect(ctx.store.get("d_1")?.data).toMatchObject({ title: "A", slug: "posts/a" });
  });

  it("rewrites markdown links to other hydrated docs", async () => {
    const transport: Transport = {
      kind: "remote",
      query: vi.fn(async () => [
        { id: "d_a", path: "posts/a.md" },
        { id: "d_b", path: "posts/b.md" },
      ]),
      hydrate: vi.fn(async () => [
        {
          id: "d_a",
          path: "posts/a.md",
          properties: { frontmatter: { title: "A" } },
          body: "See [B](./b.md#x) and [ext](https://x.test).",
          contentHash: "a",
          rev: null,
        },
        {
          id: "d_b",
          path: "posts/b.md",
          properties: { frontmatter: { title: "B" } },
          body: "Target",
          contentHash: "b",
          rev: null,
        },
      ]),
      outEdges: vi.fn(async () => [
        { src: "d_a", dst: "d_b", dstPath: "posts/b.md" },
      ]),
    };
    const ctx = mockContext();
    await syncEntries(ctx, transport, {
      query: "from docs",
      slug: ({ path }) => path.replace(/^posts\//, "").replace(/\.md$/, ""),
      href: ({ slug }) => `/blog/${slug}/`,
    });
    expect(ctx.store.get("d_a")?.body).toBe("See [B](/blog/b/#x) and [ext](https://x.test).");
    expect(transport.outEdges).toHaveBeenCalled();
  });
});

describe("stopWatch", () => {
  it("is a no-op when nothing is watching", async () => {
    await expect(stopWatch("missing")).resolves.toBeUndefined();
  });
});
