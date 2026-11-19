import { z } from "zod";

export const FRONTIER_PART_ROWS = 500;
// Keep scratchpad RPC and Workflow heap use bounded even on link-dense pages.
export const VISITED_PART_BYTES = 4 * 1024 * 1024;

const pageCount = z.number().int().nonnegative();
export const DEPTH_DIAGNOSTIC_SAMPLES = 8;
export const diagnosticUrlSchema = z
  .string()
  .max(320)
  .regex(/^https?:\/\/[^/?#@\s]+\/…?(?:\?…)?$/)
  .nullable();
const captureReason = z.enum([
  "html-byte-limit",
  "javascript-shell",
  "link-extraction-limit",
  "link-row-limit",
  "link-storage-limit",
  "unread-response",
  "capture-incomplete",
]);
export type LinkCaptureReason = z.infer<typeof captureReason>;
const captureSample = z.object({
  source: diagnosticUrlSchema,
  sourcePageId: z.string().max(128),
  reason: captureReason,
});
const auditCaptureDiagnosticsSchema = z.object({
  affectedPages: pageCount,
  samples: z.array(captureSample).max(DEPTH_DIAGNOSTIC_SAMPLES),
});
export const auditDepthCoverageSchema = z.object({
  method: z.literal("captured-navigation-v1"),
  firstIncompleteDepth: pageCount.nullable(),
  cohortKnownPages: pageCount,
  segmentKnownPages: pageCount,
  knownPagesWithUnknownHtmlEligibility: pageCount,
  firstIncomplete: z
    .object({
      affectedSources: pageCount,
      samples: z
        .array(
          captureSample.extend({
            sourcePageId: captureSample.shape.sourcePageId.nullable(),
            target: diagnosticUrlSchema.optional(),
            reason: z.union([
              captureReason,
              z.enum([
                "robots-excluded",
                "discovery-limit",
                "missing-redirect",
                "missing-link-target",
                "pending-target",
                "start-unavailable",
              ]),
            ]),
          }),
        )
        .max(DEPTH_DIAGNOSTIC_SAMPLES),
    })
    .optional(),
  incompleteCapture: auditCaptureDiagnosticsSchema.optional(),
});
export type AuditDepthCoverage = z.infer<typeof auditDepthCoverageSchema>;

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
