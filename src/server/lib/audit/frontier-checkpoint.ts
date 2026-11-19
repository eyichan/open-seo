import { z } from "zod";

export const FRONTIER_PART_ROWS = 500;
// Keep scratchpad RPC and Workflow heap use bounded even on link-dense pages.
export const VISITED_PART_BYTES = 4 * 1024 * 1024;

export const pendingUrlSchema = z
  .object({
    url: z.string().min(1),
    depth: z.number().int().nonnegative().nullable(),
    source: z.enum(["link", "sitemap"]),
    inSitemap: z.boolean(),
  })
  .strict();

export const visitedUrlSchema = pendingUrlSchema.extend({
  pageId: z.string().min(1),
  statusCode: z.number().int().nullable(),
  fetchClass: z.string(),
  redirectUrl: z.string().nullable(),
  targetsJson: z.string().nullable(),
});

export type PendingUrl = z.infer<typeof pendingUrlSchema>;
export type VisitedUrl = z.infer<typeof visitedUrlSchema>;
