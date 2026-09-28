---
title: Not ready yet
description: Drafts stay in the vault; published posts may link here, but the site will not invent a route.
status: draft
published: 2026-09-21
---

# Not ready yet

This draft is in the vault so you can see that the OQX filter excludes it from the Astro collection.

Published posts can still *author* a link to `./draft.md`. Because this doc is never hydrated into the collection, `@omgbase/astro` does **not** rewrite that destination to a site URL — only docs in the load get an `href`. That’s the hyperfidelity boundary: rewrite when we know the doc; leave alone when we don’t.
