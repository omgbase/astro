---
title: Graph-shaped publishing
description: Why OQX (and omg identity) beat inventing a second CMS schema.
status: published
published: 2026-09-22
---

# Graph-shaped publishing

Frontmatter fields like `status` are ordinary omgbase document properties. Publication rules can use the same query language agents already use — filters, joins, graph follows — instead of inventing a second CMS schema.

## Why identity

A static site needs URLs. A knowledge vault needs stable document identity. `@omgbase/astro` keeps both:

1. Your OQX query pulls a set of docs (here: published posts).
2. Each entry’s Astro `id` is the omg `d_…` doc id; `href` maps that id onto a site path.
3. Markdown bodies are rewritten so links that resolve to another hydrated doc use that `href`.

Rename a file in the vault later and retarget inbound links in omg — the site still joins on identity for whatever docs this build loaded. Authored `./hello.md` is CMS input; `/blog/hello/` is output.

Back to the walkthrough: [Hello from omgbase](./hello.md).

## Compare source vs HTML

In this file the back-link is literally `./hello.md`. After `astro build`, the article HTML should read `href="/blog/hello/"`. Open both and you’ll see the rewrite without reading the package source.
