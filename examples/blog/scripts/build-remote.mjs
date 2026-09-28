import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHttpServer } from "@omgbase/astro/server";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = resolve(exampleRoot, "content");
const astroBin = resolve(exampleRoot, "node_modules", "astro", "bin", "astro.mjs");

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["./scripts/setup-content.mjs"], {
    cwd: exampleRoot,
    stdio: "inherit",
  });
  child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`setup exited ${code}`))));
});

const externalUrl = process.env.OMG_URL;
let closeServer = null;
let url = externalUrl;

if (!url) {
  const mcp = await createMcpHttpServer({
    workspace: contentRoot,
    repo: "content",
    token: process.env.OMG_TOKEN ?? "dev-token",
    port: Number(process.env.OMG_PORT ?? 8787),
  });
  url = mcp.url;
  closeServer = mcp.close;
  console.log(`demo MCP HTTP server at ${url}`);
} else {
  console.log(`using external MCP HTTP server at ${url}`);
}

const child = spawn(process.execPath, [astroBin, "build"], {
  cwd: exampleRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    OMG_TRANSPORT: "remote",
    OMG_URL: url,
    OMG_TOKEN: process.env.OMG_TOKEN ?? (closeServer ? "dev-token" : undefined),
  },
});

child.on("exit", async (code) => {
  if (closeServer) await closeServer();
  process.exit(code ?? 0);
});
