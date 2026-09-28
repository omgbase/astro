# Example blog (omgbase → Astro)

A minimal static site that uses **`@omgbase/astro`** to treat an omgbase vault as the CMS.

## Quick start

From the repo root:

```bash
pnpm install
pnpm --filter @omgbase/astro build
pnpm --filter @omgbase/example-blog dev:local
```

Remote over Streamable HTTP MCP (demo server, or your own wrapper via `OMG_URL`):

```bash
pnpm --filter @omgbase/example-blog dev:remote
# or
OMG_URL=https://host/k/secret/mcp OMG_TOKEN=… OMG_HEADER='X-Foo: bar' \
  pnpm --filter @omgbase/example-blog build:remote
```

## How it works

1. `pnpm setup:content` opens `content/` as an omgbase workspace and ingests Markdown.
2. `src/content.config.ts` defines a `posts` collection with `omgLoader(...)`.
3. The loader runs:

   ```
   from docs where $path.startsWith("posts/") && status == "published"
   ```

4. Local transport uses `@omgbase/core`; remote uses MCP tools `query` + `docs_get_many` over Streamable HTTP (same as CLI `--server`).
5. Markdown links between hydrated posts (e.g. `./graph-shaped.md`) are rewritten to site URLs via `href: ({ slug }) => \`/blog/${slug}/\``.
6. Astro pages call `getCollection("posts")` / `render()` as usual.

Drafts (`status: draft`) stay in the vault but never enter the collection.

## Live reload

`astro dev` keeps the collection fresh automatically (`watch` defaults to on):

- **Local** (`dev:local`): Vite watches the `content/` vault; edits re-ingest via freshness sweep and update the collection.
- **Remote** (`dev:remote` / `OMG_URL`): polls MCP `changes_since`; CMS commits trigger a re-query/hydrate.

Updates go through Astro’s content data store, so pages hot-reload like a normal `glob()` collection. Tune with `watch: { intervalMs: 1500 }` or `watch: false` in `content.config.ts`.
