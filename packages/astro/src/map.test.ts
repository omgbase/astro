import { describe, expect, it } from "vitest";
import { contentHashOf, defaultSlug, mapDoc, stripFrontmatter } from "./map.js";
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
    expect(mapped.digest).toBe("deadbeef");
  });
});

describe("contentHashOf", () => {
  it("reads $content_hash from computed properties", () => {
    expect(contentHashOf({ computed: { $content_hash: "abc" } })).toBe("abc");
  });
});
