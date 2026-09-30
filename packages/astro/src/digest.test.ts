import { describe, expect, it } from "vitest";
import {
  encodeEntryDigest,
  hitContentHash,
  hitProjectionsFingerprint,
  linksFingerprint,
  parseEntryDigest,
  withContentHash,
} from "./digest.js";
import { buildHrefIndex, hrefIndexFingerprint } from "./links.js";

describe("withContentHash", () => {
  it("prepends to an explicit select", () => {
    expect(withContentHash("select $path, title from docs where x")).toEqual({
      query: "select $content_hash, $path, title from docs where x",
      injected: true,
    });
  });

  it("adds a select to a bare from", () => {
    expect(withContentHash("from docs where layer == \"canon\"")).toEqual({
      query: "select $content_hash from docs where layer == \"canon\"",
      injected: true,
    });
  });

  it("prepends to a keyword-less projection list", () => {
    expect(withContentHash("$path, era from docs order by era")).toEqual({
      query: "$content_hash, $path, era from docs order by era",
      injected: true,
    });
  });

  it("preserves leading whitespace and is case-insensitive", () => {
    expect(withContentHash("  SELECT a FROM docs").query).toBe("  select $content_hash, a FROM docs");
  });

  it("leaves queries that already project the hash alone", () => {
    const q = "select $content_hash, $path from docs";
    expect(withContentHash(q)).toEqual({ query: q, injected: false });
  });

  it("leaves scalar $repo forms alone", () => {
    const q = "$repo.docs count { where layer == \"canon\" }";
    expect(withContentHash(q)).toEqual({ query: q, injected: false });
  });
});

describe("entry digest round trip", () => {
  it("encodes and parses every field", () => {
    const d = {
      hash: "abc",
      path: "posts/a.md",
      slug: "a",
      href: "/blog/a/",
      hitsFp: "{}",
      linksFp: "d_b=/blog/b/",
      rev: "r_1",
    };
    expect(parseEntryDigest(encodeEntryDigest(d))).toEqual(d);
  });

  it("rejects legacy digests", () => {
    expect(parseEntryDigest("abc|path:posts/a.md|rev:r_1|fm:{}")).toBeNull();
    expect(parseEntryDigest(undefined)).toBeNull();
    expect(parseEntryDigest("omg2:not json")).toBeNull();
  });
});

describe("hit helpers", () => {
  it("reads the projected hash", () => {
    expect(hitContentHash({ id: "d", path: "p", $content_hash: "h" })).toBe("h");
    expect(hitContentHash({ id: "d", path: "p" })).toBeNull();
  });

  it("fingerprints projections without id/path or an injected hash", () => {
    const a = hitProjectionsFingerprint(
      { id: "d", path: "p", $content_hash: "h", $title: "T" },
      true,
    );
    const b = hitProjectionsFingerprint({ id: "d", path: "p", $title: "T" }, false);
    expect(a).toBe(b);
    expect(
      hitProjectionsFingerprint({ id: "d", path: "p", $content_hash: "h", $title: "T" }, false),
    ).not.toBe(b);
  });
});

describe("linksFingerprint", () => {
  const index = buildHrefIndex([
    { docId: "d_a", path: "a.md", href: "/a/" },
    { docId: "d_b", path: "b.md", href: "/b/" },
  ]);
  const whole = hrefIndexFingerprint(index);

  it("is empty for a doc with no document edges", () => {
    expect(linksFingerprint("d_a", [], index, whole)).toBe("");
  });

  it("pins to the linked docs' hrefs, sorted", () => {
    const edges = [
      { src: "d_a", dst: "d_b", dstPath: "b.md" },
      { src: "d_a", dst: "d_a", dstPath: "a.md" },
      { src: "d_z", dst: "d_b", dstPath: "b.md" },
    ];
    expect(linksFingerprint("d_a", edges, index, whole)).toBe("d_a=/a/|d_b=/b/");
  });

  it("falls back to the whole index when edges point outside the collection", () => {
    const edges = [{ src: "d_a", dst: "d_out", dstPath: "out.md" }];
    expect(linksFingerprint("d_a", edges, index, whole)).toBe(`idx:${whole}`);
  });

  it("ignores phantom and external destinations", () => {
    const edges = [{ src: "d_a", dst: "phantom:x", dstPath: null }];
    expect(linksFingerprint("d_a", edges, index, whole)).toBe("");
  });
});
