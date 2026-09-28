import { describe, expect, it } from "vitest";
import {
  allowedDstsFor,
  buildHrefIndex,
  canonicalLinkPath,
  defaultHref,
  resolveLinkHref,
  rewriteMarkdownLinks,
  splitDestination,
} from "./links.js";

describe("splitDestination / canonicalLinkPath", () => {
  it("splits fragments", () => {
    expect(splitDestination("./b.md#sec")).toEqual({ path: "./b.md", fragment: "#sec" });
    expect(splitDestination("note^ref")).toEqual({ path: "note", fragment: "^ref" });
  });

  it("resolves relative paths against the source doc dir", () => {
    expect(canonicalLinkPath("./b.md", "posts/")).toBe("posts/b.md");
    expect(canonicalLinkPath("../about.md", "posts/")).toBe("about.md");
    expect(canonicalLinkPath("/posts/b.md", "posts/")).toBe("posts/b.md");
  });
});

describe("rewriteMarkdownLinks", () => {
  const index = buildHrefIndex([
    { docId: "d_a", path: "posts/a.md", href: "/blog/a/" },
    { docId: "d_b", path: "posts/b.md", href: "/blog/b/" },
  ]);

  it("rewrites relative md links and keeps fragments", () => {
    const body = "See [B](./b.md#sec) and [ext](https://x.test).\n";
    expect(
      rewriteMarkdownLinks(body, { srcPath: "posts/a.md", hrefIndex: index }),
    ).toBe("See [B](/blog/b/#sec) and [ext](https://x.test).\n");
  });

  it("rewrites wikilinks that resolve to a hydrated path", () => {
    const body = "Jump [[posts/b]] or [[posts/b|Alias]].\n";
    expect(
      rewriteMarkdownLinks(body, { srcPath: "posts/a.md", hrefIndex: index }),
    ).toBe("Jump [[/blog/b/]] or [[/blog/b/|Alias]].\n");
  });

  it("leaves code fences and inline code alone", () => {
    const body = "Prose [B](./b.md)\n\n```\n[B](./b.md)\n```\n\nAnd `./b.md`.\n";
    const out = rewriteMarkdownLinks(body, { srcPath: "posts/a.md", hrefIndex: index });
    expect(out).toContain("Prose [B](/blog/b/)");
    expect(out).toContain("```\n[B](./b.md)\n```");
    expect(out).toContain("And `./b.md`.");
  });

  it("respects allowedDstIds edge gate", () => {
    const body = "See [B](./b.md) and [A](./a.md).\n";
    expect(
      rewriteMarkdownLinks(body, {
        srcPath: "posts/x.md",
        hrefIndex: index,
        allowedDstIds: new Set(["d_b"]),
      }),
    ).toBe("See [B](/blog/b/) and [A](./a.md).\n");
  });

  it("leaves pure fragments alone", () => {
    expect(
      rewriteMarkdownLinks("Jump [here](#sec).\n", {
        srcPath: "posts/a.md",
        hrefIndex: index,
      }),
    ).toBe("Jump [here](#sec).\n");
  });
});

describe("resolveLinkHref / allowedDstsFor / defaultHref", () => {
  it("defaultHref uses slug", () => {
    expect(defaultHref({ slug: "hello", path: "p", docId: "d", properties: {} })).toBe(
      "/hello",
    );
  });

  it("resolveLinkHref returns null for unknowns", () => {
    const index = buildHrefIndex([{ docId: "d_a", path: "posts/a.md", href: "/a" }]);
    expect(resolveLinkHref("./missing.md", "posts/a.md", index)).toBeNull();
  });

  it("allowedDstsFor intersects edges with the href index", () => {
    const index = buildHrefIndex([
      { docId: "d_a", path: "posts/a.md", href: "/a" },
      { docId: "d_b", path: "posts/b.md", href: "/b" },
    ]);
    const allowed = allowedDstsFor(
      "d_a",
      [
        { src: "d_a", dst: "d_b", dstPath: "posts/b.md" },
        { src: "d_a", dst: "phantom:gone", dstPath: null },
        { src: "d_a", dst: "d_other", dstPath: "other.md" },
      ],
      index,
    );
    expect([...allowed]).toEqual(["d_b"]);
  });
});
