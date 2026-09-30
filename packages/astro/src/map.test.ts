import { describe, expect, it } from "vitest";
import {
  contentHashOf,
  defaultSlug,
  mapDoc,
  mergeHitProjections,
  stripFrontmatter,
} from "./map.js";
import type { HydratedDoc } from "./transport.js";

describe("stripFrontmatter", () => {
  it("removes a YAML fence and leaves the body", () => {
    const raw = "---\ntitle: Hi\n---\n\nHello\n";
    expect(stripFrontmatter(raw)).toBe("Hello\n");
  });

  it("returns content unchanged when there is no fence", () => {
    expect(stripFrontmatter("# Hi\n")).toBe("# Hi\n");
  });
});

describe("defaultSlug", () => {
  it("strips .md", () => {
    expect(defaultSlug({ path: "posts/hello.md", docId: "d_1", properties: {} })).toBe(
      "posts/hello",
    );
  });
});

describe("mapDoc", () => {
  it("spreads frontmatter and sets intrinsics", () => {
    const doc: HydratedDoc = {
      id: "d_abc",
      path: "posts/hello.md",
      properties: {
        frontmatter: { title: "Hello", status: "published" },
        computed: { $content_hash: "deadbeef" },
      },
      body: "Hello\n",
      contentHash: "deadbeef",
      rev: "r_1",
    };
    const mapped = mapDoc(doc);
    expect(mapped.id).toBe("d_abc");
    expect(mapped.data).toMatchObject({
      title: "Hello",
      status: "published",
      path: "posts/hello.md",
      docId: "d_abc",
      contentHash: "deadbeef",
      slug: "posts/hello",
    });
    expect(mapped.digest).toContain("deadbeef|path:posts/hello.md|rev:r_1|fm:");
    expect(mapped.digest).toContain('"status":"published"');
  });

  it("falls back to computed $title when frontmatter has none", () => {
    const doc: HydratedDoc = {
      id: "d_abc",
      path: "projects/foo.md",
      properties: {
        frontmatter: { status: "active" },
        computed: { $title: "Foo" },
      },
      body: "# Foo\n",
      contentHash: null,
      rev: null,
    };
    expect(mapDoc(doc).data.title).toBe("Foo");
  });

  it("changes digest when path changes but content hash does not", () => {
    const base = {
      id: "d_1",
      properties: { frontmatter: {}, computed: { $content_hash: "abc" } },
      body: "hi\n",
      contentHash: "abc",
      rev: "r_1",
    } satisfies Omit<HydratedDoc, "path">;
    const a = mapDoc({ ...base, path: "concepts/attn.md" });
    const b = mapDoc({ ...base, path: "projects/attn.md" });
    expect(a.digest).not.toBe(b.digest);
    expect(b.data.slug).toBe("projects/attn");
  });

  it("changes digest when frontmatter changes but body hash/length do not", () => {
    const base = {
      id: "d_1",
      path: "projects/attn.md",
      body: "# attn\n",
      contentHash: null,
      rev: "r_1",
    } satisfies Omit<HydratedDoc, "properties">;
    const before = mapDoc({
      ...base,
      properties: { frontmatter: { layer: "working" }, computed: {} },
    });
    const after = mapDoc({
      ...base,
      properties: {
        frontmatter: { layer: "working", status: "active" },
        computed: {},
      },
    });
    expect(before.digest).not.toBe(after.digest);
    expect(after.data.status).toBe("active");
  });

  it("changes digest when rev changes", () => {
    const base = {
      id: "d_1",
      path: "projects/attn.md",
      properties: { frontmatter: { status: "active" }, computed: {} },
      body: "# attn\n",
      contentHash: null,
    } satisfies Omit<HydratedDoc, "rev">;
    const a = mapDoc({ ...base, rev: "r_1" });
    const b = mapDoc({ ...base, rev: "r_2" });
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("mergeHitProjections", () => {
  it("aliases $updated_at and $title from the lean hit", () => {
    const merged = mergeHitProjections(
      { path: "a.md", docId: "d_1", contentHash: null, slug: "a" },
      { id: "d_1", path: "a.md", $updated_at: "2026-09-28T00:00:00Z", $title: "A" },
    );
    expect(merged.updatedAt).toBe("2026-09-28T00:00:00Z");
    expect(merged.title).toBe("A");
    expect(merged.$updated_at).toBe("2026-09-28T00:00:00Z");
  });

  it("lets hydrated data win over hit projections", () => {
    const merged = mergeHitProjections(
      { title: "Authored", path: "a.md", docId: "d_1", contentHash: null, slug: "a" },
      { id: "d_1", path: "a.md", $title: "Computed" },
    );
    expect(merged.title).toBe("Authored");
  });
});

describe("contentHashOf", () => {
  it("reads $content_hash from computed properties", () => {
    expect(contentHashOf({ computed: { $content_hash: "abc" } })).toBe("abc");
  });
});
