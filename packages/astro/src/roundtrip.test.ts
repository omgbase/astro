import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace, ingestDirectory } from "@omgbase/core";
import { createLocalTransport } from "./local.js";
import { createRemoteTransport, parseHeaderLine, resolveHeaders } from "./remote.js";
import { createMcpHttpServer } from "./server.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("headers", () => {
  it("parses CLI -H lines and merges token", () => {
    expect(parseHeaderLine("X-Test: hi")).toEqual(["X-Test", "hi"]);
    expect(
      resolveHeaders({
        headerLines: ["X-Test: hi"],
        token: "secret",
      }),
    ).toEqual({
      "X-Test": "hi",
      Authorization: "Bearer secret",
    });
  });
});

describe("local + remote MCP round trip", () => {
  it("queries published posts and hydrates bodies over Streamable HTTP MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "omg-astro-"));
    temps.push(root);
    mkdirSync(join(root, "posts"), { recursive: true });
    writeFileSync(
      join(root, "posts", "hello.md"),
      `---\ntitle: Hello\nstatus: published\n---\n\n# Hello\n\nSee [peer](./peer.md).\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "posts", "peer.md"),
      `---\ntitle: Peer\nstatus: published\n---\n\nPeer body.\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "posts", "draft.md"),
      `---\ntitle: Draft\nstatus: draft\n---\n\nSecret.\n`,
      "utf8",
    );

    const ws = Workspace.open(root);
    ingestDirectory(ws.store, "content", root);
    ws.store.close();

    const local = createLocalTransport({ workspace: root, repo: "content" });
    const hits = await local.query({
      query: `from docs where $path.startsWith("posts/") && status == "published"`,
    });
    expect(hits).toHaveLength(2);

    const docs = await local.hydrate({ ids: hits.map((h) => h.id) });
    expect(docs).toHaveLength(2);

    const edges = await local.outEdges({ ids: hits.map((h) => h.id) });
    expect(edges.some((e) => e.dstPath === "posts/peer.md")).toBe(true);
    local.close();

    const mcp = await createMcpHttpServer({
      workspace: root,
      repo: "content",
      token: "secret",
    });

    const remote = createRemoteTransport({
      url: mcp.url,
      token: "secret",
      repo: "content",
      headerLines: ["X-Test: from-astro"],
    });
    const remoteHits = await remote.query({
      query: `from docs where status == "published"`,
    });
    expect(remoteHits).toHaveLength(2);
    const remoteDocs = await remote.hydrate({ ids: remoteHits.map((h) => h.id) });
    expect(remoteDocs.some((d) => d.body.includes("Peer"))).toBe(true);
    const remoteEdges = await remote.outEdges({ ids: remoteHits.map((h) => h.id) });
    expect(remoteEdges.some((e) => e.dstPath === "posts/peer.md")).toBe(true);

    await remote.close();
    await mcp.close();
  });
});
