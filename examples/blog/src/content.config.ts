import { defineCollection, z } from "astro:content";
import { omgLoader } from "@omgbase/astro";
import { resolve } from "node:path";

// Astro may rewrite import.meta.url for content.config; cwd is the site root.
const contentRoot = resolve(process.cwd(), "content");
const transport = process.env.OMG_TRANSPORT === "remote" ? "remote" : "local";

const shared = {
  repo: "content",
  query: `from docs where $path.startsWith("posts/") && status == "published"`,
  slug: ({ path }: { path: string }) => path.replace(/^posts\//, "").replace(/\.md$/i, ""),
  href: ({ slug }: { slug: string }) => `/blog/${slug}/`,
};

function remoteHeaders(): { headers?: Record<string, string>; headerLines?: string[] } {
  const headers: Record<string, string> = {};
  // OMG_HEADERS: JSON object, e.g. {"X-Foo":"bar"}
  if (process.env.OMG_HEADERS) {
    Object.assign(headers, JSON.parse(process.env.OMG_HEADERS) as Record<string, string>);
  }
  // OMG_HEADER: single CLI-style "Name: value" (repeat via OMG_HEADER_2, … not needed often)
  const headerLines = [process.env.OMG_HEADER, process.env.OMG_HEADER_2, process.env.OMG_HEADER_3].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return {
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(headerLines.length ? { headerLines } : {}),
  };
}

const loader =
  transport === "remote"
    ? omgLoader({
        ...shared,
        url: process.env.OMG_URL ?? "http://127.0.0.1:8787/mcp",
        ...(process.env.OMG_TOKEN ? { token: process.env.OMG_TOKEN } : {}),
        ...remoteHeaders(),
      })
    : omgLoader({
        ...shared,
        workspace: contentRoot,
      });

const posts = defineCollection({
  loader,
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    status: z.string(),
    published: z.union([z.string(), z.number()]).optional(),
    path: z.string(),
    docId: z.string(),
    contentHash: z.string().nullable(),
    slug: z.string(),
  }),
});

export const collections = { posts };
