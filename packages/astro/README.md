# `@omgbase/astro`

Use an [omgbase](https://github.com/omgbase/omgbase) repository as the CMS for an [Astro](https://astro.build) static site.

The package provides:

- **`omgLoader`** — an Astro Content Layer loader driven by an **OQX** query
- **Local transport** — embedded `@omgbase/core`
- **Remote transport** — Streamable HTTP MCP (`query` + `docs_get_many`), same as `omg … --server <url>`
- **Dev live-reload** — in `astro dev`, local vaults use Vite's FS watcher; remote polls MCP `changes_since`. Both update Astro's content data store so the normal HMR path fires — no custom integration required
- **`createMcpHttpServer`** — optional local Streamable HTTP MCP server for demos/CI

## Install

```bash
pnpm add @omgbase/astro @omgbase/core
```

Peer dependency: Astro 5+.

## Local loader

```ts
// src/content.config.ts
import { defineCollection, z } from "astro:content";
import { omgLoader } from "@omgbase/astro";

const posts = defineCollection({
  loader: omgLoader({
    workspace: "../content", // directory containing `.omgbase/`
    repo: "content",
    query: `from docs where $path.startsWith("posts/") && status == "published"`,
    slug: ({ path }) => path.replace(/^posts\//, "").replace(/\.md$/i, ""),
    href: ({ slug }) => `/blog/${slug}/`,
  }),
  schema: z.object({
    title: z.string(),
    status: z.string(),
    path: z.string(),
    docId: z.string(),
    contentHash: z.string().nullable(),
    slug: z.string(),
  }),
});

export const collections = { posts };
```

Entry **id** = omg document id. **`data.slug`** is for routing (default: path without `.md`).

### Inter-doc links

When the loader hydrates a set of docs, markdown bodies are rewritten so links that resolve to another hydrated doc use that doc’s site URL:

```ts
omgLoader({
  workspace: "../content",
  query: `from docs where status == "published"`,
  slug: ({ path }) => path.replace(/^posts\//, "").replace(/\.md$/i, ""),
  href: ({ slug }) => `/blog/${slug}/`, // match your routes
});
```

Resolution is identity-aware: live omg out-edges (`$dst`) gate rewrites when available, and authored destinations are matched with the same path rules as the engine (`./` / `../`, root-relative, `.md` aliases). Fragments (`#sec`) are preserved. External URLs, pure `#anchors`, code spans/fences, and destinations that aren’t in this load are left alone. Set `href: false` to disable rewriting.

Query projections that return link URL *values* as columns are never rewritten — only markdown bodies going through `renderMarkdown`.

## Remote loader (Streamable HTTP MCP)

Point `url` at the same endpoint you’d pass to `omg query --server <url>` — including a stdio-mcp-to-http wrapper, secret path prefix, etc. Custom headers match CLI `-H`:

```ts
omgLoader({
  url: process.env.OMG_URL!,                    // e.g. https://host/k/<secret>/mcp
  headers: { "X-Env": "prod" },                 // map form
  headerLines: ["X-Request-Id: build-42"],      // CLI -H "Name: value" form
  token: process.env.OMG_TOKEN,                 // → Authorization: Bearer …
  repo: "content",
  query: `from docs where status == "published"`,
});
```

Under the hood this uses `@omgbase/sync`’s `connectHttpEngine` (same client as the CLI).

### Live reload in `astro dev`

Enabled by default whenever Astro passes a `watcher` into the loader:

| Transport | Mechanism |
| --- | --- |
| Local | Vite FS watch on the vault root (same hook as `glob()`) |
| Remote | Poll MCP `changes_since` (default every 2s) |

On change, the loader re-queries/hydrates into the content data store. Astro already watches that store file and hot-reloads pages — we don’t invent a second HMR channel.

```ts
omgLoader({
  url: process.env.OMG_URL!,
  query: `from docs where status == "published"`,
  watch: { intervalMs: 1500 }, // or `watch: false` to disable
});
```

### Demo MCP HTTP server

If you don’t already have an HTTP MCP front-end, `createMcpHttpServer` wraps a local workspace:

```ts
import { createMcpHttpServer } from "@omgbase/astro/server";

const mcp = await createMcpHttpServer({
  workspace: "./content",
  repo: "content",
  token: "secret",
  port: 8787,
});
// mcp.url → http://127.0.0.1:8787/mcp
```

Prefer your real wrapper/hosted endpoint for production builds.

## Identity & caching

- Astro entry **`id`** = omg document id (`d_…`)
- **`data.slug`** = routing key (default: path with `.md` stripped; override with `slug`)
- **`href`** = site URL used when rewriting markdown links between hydrated docs (default `/${slug}`; override to match routes)
- **Hash-first sync.** Every load projects `$content_hash` onto your query, so a hit carries the server's whole-file hash (frontmatter included). Docs whose hash, path and hit projections match the stored entry are reused without `docs_get_many`; only new/changed docs are fetched, mapped and rendered. A no-change reload costs one query and nothing else — an all-docs collection is cheap to keep loaded
- **Link-aware invalidation.** Each entry's digest also pins the hrefs of the docs it links to (via omg out-edges). Adding, removing or moving a doc re-fetches only its linkers, not the whole collection. The edge scan itself is skipped when nothing changed
- **Fallbacks.** If the server rejects the `$content_hash` projection (older omg), the loader warns once and hydrates everything as before; the digest compare still avoids redundant re-renders. Entries stored under the pre-0.2 digest format are re-hydrated once and migrated

## Example

See [`examples/blog`](../../examples/blog):

```bash
pnpm install
pnpm --filter @omgbase/astro build
pnpm --filter @omgbase/example-blog dev:local
# or (demo MCP HTTP server)
pnpm --filter @omgbase/example-blog dev:remote
# or point at your wrapper:
OMG_URL=https://host/k/secret/mcp OMG_TOKEN=… pnpm --filter @omgbase/example-blog build:local
# with OMG_TRANSPORT=remote and OMG_URL set in the environment
```
