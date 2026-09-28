# omgbase × Astro

Use your **omgbase** as a CMS to drive a static website with Astro.

## Packages

| Package | Description |
| --- | --- |
| [`@omgbase/astro`](packages/astro) | Content Loader: local `@omgbase/core` or remote Streamable HTTP MCP; live-reload in `astro dev` |
| [`examples/blog`](examples/blog) | Minimal static blog wired to an omgbase vault |

## Quick start

```bash
pnpm install
pnpm --filter @omgbase/astro build
pnpm --filter @omgbase/example-blog dev:local
```

Publication model: write Markdown in an omgbase repo, select publishable docs with **OQX**, hydrate at Astro build time (locally or via MCP `--server`-compatible HTTP), emit ordinary static HTML.

In `astro dev`, content stays hot: local vaults use Vite’s FS watcher; remote endpoints poll MCP `changes_since`. Both update Astro’s content data store so the normal HMR path fires. See [`packages/astro/README.md`](packages/astro/README.md).
