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
5. **Identity-aware interlinks** — vault Markdown like `./graph-shaped.md#why-identity` becomes `/blog/graph-shaped/#why-identity` for docs in this load (see below).
6. Astro pages call `getCollection("posts")` / `render()` as usual.

Drafts (`status: draft`) stay in the vault but never enter the collection.

## See the link rewrite

The exciting bit: write normal omgbase links in the vault; the loader maps them onto site routes using omg document identity.

In `content/posts/hello.md` you’ll find:

| Authored in the vault | After build (published peers) |
| --- | --- |
| `[…](./graph-shaped.md#why-identity)` | `/blog/graph-shaped/#why-identity` |
| `[…](/posts/graph-shaped.md)` | `/blog/graph-shaped/` |
| `[[posts/graph-shaped]]` | body becomes `[[/blog/graph-shaped/]]` (wikilink HTML still needs a renderer) |
| `[…](https://github.com/omgbase/omgbase)` | unchanged (external) |
| `[…](./draft.md)` | unchanged (draft not in this load) |
| A `./graph-shaped.md` link inside a fence | unchanged (code) |

`href: ({ slug }) => \`/blog/${slug}/\`` in `content.config.ts` is the only site-specific piece. After `pnpm build:local`, open `dist/blog/hello/index.html` and confirm the peer `<a href="…">` values — that’s the demo.

## Live reload

`astro dev` keeps the collection fresh automatically (`watch` defaults to on):

- **Local** (`dev:local`): Vite watches the `content/` vault; edits re-ingest via freshness sweep and update the collection.
- **Remote** (`dev:remote` / `OMG_URL`): polls MCP `changes_since`; CMS commits trigger a re-query/hydrate.

Updates go through Astro’s content data store, so pages hot-reload like a normal `glob()` collection. Tune with `watch: { intervalMs: 1500 }` or `watch: false` in `content.config.ts`.
