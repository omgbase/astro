---
title: Hello from omgbase
description: First published post — and a tour of identity-aware interlinks.
status: published
published: 2026-09-20
---

# Hello from omgbase

This post lives in an **omgbase** vault. Astro never copies it into `src/content` — the Content Loader hydrates it at build time with:

```
from docs where $path.startsWith("posts/") && status == "published"
```

## Vault paths, site URLs

In the vault, links look like ordinary Markdown between files. In the built site, destinations that resolve to **other docs in this load** become real routes via each doc’s `href` — keyed by omg document identity (live out-edges ∩ path resolution), not string guessing.

Click these on the built site (they should all land on `/blog/graph-shaped/…`):

- Relative + fragment: [Graph-shaped publishing → Why identity](./graph-shaped.md#why-identity)
- Root-relative vault path: [same post via /posts/graph-shaped.md](/posts/graph-shaped.md)

And these stay exactly as authored:

- External: [omgbase on GitHub](https://github.com/omgbase/omgbase)
- Draft in the vault but **not** in this collection (never hydrated → no site `href`): [Not ready yet](./draft.md)
- Same-page fragment: [jump to See it live](#see-it-live)

Wikilink in the vault (destination rewritten in the loaded body; default Astro Markdown won’t make `[[…]]` clickable HTML):

[[posts/graph-shaped]]

## What does *not* get rewritten

Link-shaped text inside code is left alone on purpose:

```markdown
[Graph-shaped publishing](./graph-shaped.md)
```

## See it live

Open this page after `pnpm build:local` and compare:

| Authored in `content/posts/hello.md` | In `dist/blog/hello/index.html` |
| --- | --- |
| `./graph-shaped.md#why-identity` | `/blog/graph-shaped/#why-identity` |
| `/posts/graph-shaped.md` | `/blog/graph-shaped/` |
| `https://github.com/omgbase/omgbase` | unchanged |
| `./draft.md` | unchanged |
| fenced `./graph-shaped.md` | unchanged |

That gap — vault fidelity in, route fidelity out — is the point of `@omgbase/astro`’s link rewrite.
