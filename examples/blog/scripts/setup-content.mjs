import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace, ingestDirectory, freshnessSweep } from "@omgbase/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "content");
const repoSlug = "content";

const ws = Workspace.open(root);
const existing = ws.repoBySlug(repoSlug);

if (!existing) {
  console.log(`ingesting ${root} as repo '${repoSlug}'`);
  ingestDirectory(ws.store, repoSlug, root);
} else {
  console.log(`refreshing repo '${repoSlug}'`);
  if (existing.rootPath) {
    freshnessSweep(ws.store, existing.repoId, existing.rootPath);
  } else {
    freshnessSweep(ws.store, existing.repoId, root);
  }
}

if (!existsSync(join(root, ".omgbase"))) {
  throw new Error("setup failed: .omgbase was not created");
}

ws.store.close();
console.log("content workspace ready:", root);
