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
    });
    expect(seen).toBe(1);
    expect(written).toBe(1);
    expect(ctx.store.get("d_1")?.data).toMatchObject({ title: "A", slug: "posts/a" });
  });
});

describe("stopWatch", () => {
  it("is a no-op when nothing is watching", async () => {
    await expect(stopWatch("missing")).resolves.toBeUndefined();
  });
});
