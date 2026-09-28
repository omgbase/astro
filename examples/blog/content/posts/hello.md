---
title: Hello from omgbase
description: First published post loaded through @omgbase/astro.
status: published
published: 2026-09-20
---

# Hello from omgbase

This post lives in an **omgbase** vault and is selected for the site with an OQX query:

```
from docs where $path.startsWith("posts/") && status == "published"
```

Astro never copies these files into `src/content` — the Content Loader hydrates them at build time.

Related: [Graph-shaped publishing](./graph-shaped.md).
