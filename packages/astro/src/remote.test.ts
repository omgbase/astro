import { describe, expect, it, vi } from "vitest";
import { RemoteTransport, isConnectionLost, type ToolClient } from "./remote.js";

const SESSION_LOST =
  'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}';

/**
 * A fake connection factory: each connect() yields a client whose callTool
 * pops the next scripted outcome (a value or an Error to throw).
 */
function fakeConnect(script: Array<unknown | Error>) {
  const clients: Array<ToolClient & { closed: number }> = [];
  const connect = vi.fn(async () => {
    const client = {
      closed: 0,
      callTool: vi.fn(async <T>(): Promise<T> => {
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next as T;
      }),
      close: vi.fn(async () => {
        client.closed += 1;
      }),
    };
    clients.push(client);
    return client;
  });
  return { connect, clients };
}

describe("isConnectionLost", () => {
  it("recognises a stale Streamable HTTP session", () => {
    expect(isConnectionLost(new Error(SESSION_LOST))).toBe(true);
    expect(isConnectionLost(new Error("MCP error -32001: expired"))).toBe(true);
    expect(isConnectionLost(Object.assign(new Error("x"), { code: -32001 }))).toBe(true);
  });

  it("recognises connection-level failures", () => {
    expect(isConnectionLost(new Error("fetch failed"))).toBe(true);
    expect(isConnectionLost(new Error("connect ECONNREFUSED 127.0.0.1:8787"))).toBe(true);
    expect(isConnectionLost(new Error("socket hang up"))).toBe(true);
    expect(isConnectionLost(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("leaves ordinary tool errors alone", () => {
    expect(isConnectionLost(new Error("tool query failed: parse — unknown field $nope"))).toBe(false);
    expect(isConnectionLost(new Error("tool docs_get_many returned non-JSON: <html>"))).toBe(false);
  });
});

describe("RemoteTransport reconnect", () => {
  it("reconnects once on Session not found and returns the retried result", async () => {
    const { connect, clients } = fakeConnect([
      { digests: [], head: 5, truncated: false }, // warm-up on client #1
      new Error(SESSION_LOST), // client #1 is stale now
      { digests: [{ seq: 6 }], head: 6, truncated: false }, // client #2 answers
    ]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect });

    await transport.changesSince({ cursor: 5 });
    expect(connect).toHaveBeenCalledTimes(1);

    const page = await transport.changesSince({ cursor: 5 });
    expect(page).toEqual({ digests: [{ seq: 6 }], head: 6, truncated: false });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(clients[0]!.closed).toBe(1);
    expect(clients[1]!.callTool).toHaveBeenCalledWith("changes_since", { cursor: 5 });
  });

  it("retries every tool call site, not just changes_since", async () => {
    const { connect, clients } = fakeConnect([
      new Error(SESSION_LOST),
      { hits: [{ id: "d_1", path: "a.md" }] },
      new Error("fetch failed"),
      { items: [{ docId: "d_1", path: "a.md", properties: {}, content: "Hi", rev: null }] },
    ]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect, repo: "notes" });

    expect(await transport.query({ query: "from docs" })).toEqual([{ id: "d_1", path: "a.md" }]);
    const docs = await transport.hydrate({ ids: ["d_1"] });
    expect(docs.map((d) => d.body)).toEqual(["Hi"]);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(clients.map((c) => c.closed)).toEqual([1, 1, 0]);
  });

  it("propagates the retry's error when the reconnected call also fails", async () => {
    const { connect } = fakeConnect([new Error(SESSION_LOST), new Error("connect ECONNREFUSED")]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect });

    await expect(transport.changesSince({ cursor: 1 })).rejects.toThrow("ECONNREFUSED");
    // Exactly one reconnect: the initial client plus one replacement.
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect on a non-session error", async () => {
    const { connect, clients } = fakeConnect([
      new Error("tool query failed: parse — unknown field $nope"),
      { hits: [] },
    ]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect });

    await expect(transport.query({ query: "select $nope from docs" })).rejects.toThrow("unknown field");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clients[0]!.closed).toBe(0);

    // The same client keeps serving later calls.
    expect(await transport.query({ query: "from docs" })).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("ignores errors from closing the dead client", async () => {
    const { connect, clients } = fakeConnect([new Error(SESSION_LOST), { hits: [] }]);
    const transport = new RemoteTransport({ url: "http://omg.test/mcp", connect });
    // Pre-connect so we can sabotage close() on the first client.
    await expect(transport.query({ query: "from docs" })).resolves.toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.mocked(clients[1]!.close).mockRejectedValueOnce(new Error("already closed"));
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
