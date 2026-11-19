import { z } from "zod";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AppError } from "@/server/lib/errors";
import {
  getJsonFromR2,
  getOptionalJsonFromR2,
  putTextToR2,
} from "@/server/lib/r2";
import {
  FRONTIER_PART_ROWS,
  pendingUrlSchema,
  visitedUrlSchema,
  type PendingUrl,
  type VisitedUrl,
} from "@/server/lib/audit/frontier-checkpoint";
import { parseAuditConfig } from "@/server/lib/audit/types";
import { isSameOrigin, normalizeUrl } from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { sha256Hex } from "@/server/lib/audit/ids";
import type { AuditScratchpad } from "@/server/features/audit/AuditScratchpad";

export type AuditRow = Pick<
  NonNullable<Awaited<ReturnType<typeof AuditRepository.getAuditForProject>>>,
  | "id"
  | "projectId"
  | "startUrl"
  | "status"
  | "pagesCrawled"
  | "config"
  | "workflowInstanceId"
  | "errorCode"
>;
type Scratchpad = Pick<
  AuditScratchpad,
  "readPendingUrls" | "readVisitedUrls" | "restoreCheckpoint" | "getCoverage"
>;
const integer = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

const manifestSchema = z.object({
  version: z.literal(2),
  projectId: z.uuid(),
  auditId: z.uuid(),
  cohortId: z.uuid(),
  parentAuditId: z.uuid().nullable(),
  startUrl: z.string(),
  segmentPages: integer,
  cumulativeVisited: integer,
  pendingCount: integer,
  unreadPages: integer,
  discoveryGaps: z.array(z.string()),
  graphComplete: z.boolean(),
  stop: z.string(),
  robotsText: z.string().nullable(),
  pendingParts: z.array(digest),
  visitedParts: z.array(digest),
});

type Manifest = z.infer<typeof manifestSchema>;
const legacyLimit = z.object({
  pagesCrawled: integer,
  urlsNotCrawled: integer.positive(),
  frontierParts: integer.positive(),
});

type LegacyFrontier = {
  version: 1;
  cohortId: string;
  parentAuditId: null;
  segmentPages: number;
  cumulativeVisited: number;
  pendingCount: number;
  unreadPages: null;
  discoveryGaps: string[];
  graphComplete: false;
  stop: "crawl-page-limit";
  partCount: number;
};

export type Frontier = Manifest | LegacyFrontier;

function prefix(projectId: string, auditId: string) {
  // Both IDs come from the tenant-scoped audit row or an internal workflow.
  // Reject path separators even if a legacy database row is malformed.
  if (
    !z.uuid().safeParse(projectId).success ||
    !z.uuid().safeParse(auditId).success
  ) {
    throw new AppError("VALIDATION_ERROR", "Invalid audit frontier identity.");
  }
  return `site-audit/${projectId}/${auditId}/frontier/`;
}

function integrityFailure(): never {
  throw new Error("Audit frontier is missing data or failed integrity checks");
}

export async function getAuditFrontier(
  audit: AuditRow,
): Promise<Frontier | null> {
  if (audit.status !== "completed") return null;
  const base = prefix(audit.projectId, audit.id);
  const body = await getOptionalJsonFromR2(`${base}v2/manifest.json`);
  if (body !== null) {
    const parsed = manifestSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return integrityFailure();
    const manifest = parsed.data;
    const resumable =
      manifest.stop === "crawl-page-limit" && manifest.pendingCount > 0;
    const config = parseAuditConfig(audit.config);
    if (
      manifest.projectId !== audit.projectId ||
      manifest.auditId !== audit.id ||
      manifest.startUrl !== audit.startUrl ||
      manifest.segmentPages !== audit.pagesCrawled ||
      manifest.parentAuditId !== (config?.continuationFrom ?? null) ||
      (!manifest.parentAuditId && manifest.cohortId !== audit.id) ||
      manifest.cumulativeVisited < manifest.segmentPages ||
      manifest.unreadPages > manifest.cumulativeVisited ||
      manifest.pendingParts.length !==
        (resumable
          ? Math.ceil(manifest.pendingCount / FRONTIER_PART_ROWS)
          : 0) ||
      (resumable && manifest.visitedParts.length === 0) ||
      (!resumable && manifest.visitedParts.length > 0)
    )
      return integrityFailure();
    return manifest;
  }
  if (parseAuditConfig(audit.config)?.coverageVersion === 2)
    return integrityFailure();

  const issue = await AuditRepository.getPageLimitIssue(audit.id);
  if (!issue?.detailsJson) return null;
  const details: unknown = JSON.parse(issue.detailsJson);
  const parsed = legacyLimit.safeParse(details);
  if (!parsed.success) {
    // Before the v1 exporter, reports could count a frontier but had no rows.
    if (
      z
        .object({ frontierParts: z.undefined(), frontierPrefix: z.undefined() })
        .safeParse(details).success
    )
      return null;
    return integrityFailure();
  }
  const { pagesCrawled, urlsNotCrawled, frontierParts } = parsed.data;
  if (
    pagesCrawled !== audit.pagesCrawled ||
    frontierParts !== Math.ceil(urlsNotCrawled / FRONTIER_PART_ROWS)
  ) {
    return integrityFailure();
  }
  return {
    version: 1,
    cohortId: audit.id,
    parentAuditId: null,
    segmentPages: pagesCrawled,
    cumulativeVisited: pagesCrawled,
    pendingCount: urlsNotCrawled,
    unreadPages: null,
    discoveryGaps: [
      "legacy-discovery-unknown",
      "legacy-link-graph-unavailable",
    ],
    graphComplete: false,
    stop: "crawl-page-limit",
    partCount: frontierParts,
  };
}

export function frontierPartCount(frontier: Frontier) {
  return frontier.version === 1
    ? frontier.partCount
    : frontier.pendingParts.length;
}

function validateOrderedUrls(
  rows: PendingUrl[],
  startUrl: string,
  afterUrl: string,
) {
  let last = afterUrl;
  for (const row of rows) {
    if (
      row.url <= last ||
      normalizeUrl(row.url) !== row.url ||
      !isSameOrigin(row.url, startUrl) ||
      !isCrawlableUrl(row.url)
    ) {
      return integrityFailure();
    }
    last = row.url;
  }
  return last;
}

export async function readFrontierPart(
  audit: AuditRow,
  frontier: Frontier,
  part: number,
) {
  if (
    !Number.isInteger(part) ||
    part < 1 ||
    part > frontierPartCount(frontier)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Audit frontier part is out of range.",
    );
  }
  const key = `${prefix(audit.projectId, audit.id)}v1/${part}.json`;
  const body = await getJsonFromR2(key);
  if (
    frontier.version === 2 &&
    (await sha256Hex(body)) !== frontier.pendingParts[part - 1]
  ) {
    return integrityFailure();
  }
  const rows = pendingUrlSchema.array().parse(JSON.parse(body));
  if (
    rows.length !==
    Math.min(
      FRONTIER_PART_ROWS,
      frontier.pendingCount - (part - 1) * FRONTIER_PART_ROWS,
    )
  ) {
    return integrityFailure();
  }
  validateOrderedUrls(rows, audit.startUrl, "");
  return rows;
}

export async function saveAuditFrontier(input: {
  auditId: string;
  projectId: string;
  startUrl: string;
  parentAuditId: string | null;
  cohortId: string;
  segmentPages: number;
  pendingCount: number;
  cumulativeVisited: number;
  unreadPages: number;
  graphComplete: boolean;
  discoveryGaps: string[];
  robotsText: string | null;
  stop: string;
  scratchpad: Pick<Scratchpad, "readPendingUrls" | "readVisitedUrls">;
}) {
  const { auditId, projectId, scratchpad, ...fields } = input;
  const base = prefix(projectId, auditId);
  const pendingParts: string[] = [];
  const visitedParts: string[] = [];
  const manifest: Manifest = {
    version: 2,
    auditId,
    projectId,
    pendingParts,
    visitedParts,
    ...fields,
  };
  if (fields.stop === "crawl-page-limit" && fields.pendingCount > 0) {
    let afterUrl = "";
    let count = 0;
    for (;;) {
      const rows = await scratchpad.readPendingUrls(
        afterUrl,
        FRONTIER_PART_ROWS,
      );
      if (!rows.length) break;
      afterUrl = validateOrderedUrls(rows, fields.startUrl, afterUrl);
      count += rows.length;
      if (count > fields.pendingCount) return integrityFailure();
      const body = JSON.stringify(rows);
      pendingParts.push(await sha256Hex(body));
      await putTextToR2(`${base}v1/${pendingParts.length}.json`, body);
      if (rows.length < FRONTIER_PART_ROWS) break;
    }
    if (count !== fields.pendingCount) return integrityFailure();

    afterUrl = "";
    count = 0;
    for (;;) {
      const rows = await scratchpad.readVisitedUrls(afterUrl);
      if (!rows.length) break;
      afterUrl = validateOrderedUrls(rows, fields.startUrl, afterUrl);
      count += rows.length;
      if (count > fields.cumulativeVisited) return integrityFailure();
      const body = JSON.stringify(rows);
      visitedParts.push(await sha256Hex(body));
      await putTextToR2(`${base}v2/visited/${visitedParts.length}.json`, body);
    }
    if (count !== fields.cumulativeVisited) return integrityFailure();
  }

  // The manifest is the archive commit record. MCP serves it only after
  // the audit row is completed; partial writes are never usable.
  await putTextToR2(`${base}v2/manifest.json`, JSON.stringify(manifest));
}

export async function restoreAuditFrontier(
  audit: AuditRow,
  frontier: Frontier,
  scratchpad: Pick<Scratchpad, "restoreCheckpoint" | "getCoverage">,
  isAllowed: (url: string) => boolean,
) {
  const partCount = frontierPartCount(frontier);
  if (!partCount || frontier.stop !== "crawl-page-limit")
    return integrityFailure();
  const base = prefix(audit.projectId, audit.id);
  let afterUrl = "";
  let count = 0;
  const restoreVisited = async (rows: VisitedUrl[]) => {
    afterUrl = validateOrderedUrls(rows, audit.startUrl, afterUrl);
    count += rows.length;
    if (
      !rows.length ||
      rows.length > FRONTIER_PART_ROWS ||
      count > frontier.cumulativeVisited
    )
      return integrityFailure();
    await scratchpad.restoreCheckpoint({ visited: rows });
  };
  if (frontier.version === 2) {
    for (const [i, hash] of frontier.visitedParts.entries()) {
      const body = await getJsonFromR2(`${base}v2/visited/${i + 1}.json`);
      if ((await sha256Hex(body)) !== hash) return integrityFailure();
      await restoreVisited(visitedUrlSchema.array().parse(JSON.parse(body)));
    }
  } else {
    for (;;) {
      const rows = await AuditRepository.readLegacyVisited(
        audit.id,
        afterUrl,
        FRONTIER_PART_ROWS,
      );
      if (!rows.length) break;
      await restoreVisited(
        rows.map((row) => ({
          ...row,
          source: row.depth === null && row.inSitemap ? "sitemap" : "link",
          targetsJson: null,
        })),
      );
      if (rows.length < FRONTIER_PART_ROWS) break;
    }
  }
  if (count !== frontier.cumulativeVisited) return integrityFailure();
  afterUrl = "";
  for (let i = 1; i <= partCount; i++) {
    const rows = await readFrontierPart(audit, frontier, i);
    afterUrl = validateOrderedUrls(rows, audit.startUrl, afterUrl);
    if (!rows.every((row) => isAllowed(row.url))) {
      throw new Error("Robots policy does not allow every saved frontier URL");
    }
    await scratchpad.restoreCheckpoint({ pending: rows });
  }
  const stats = await scratchpad.getCoverage();
  if (
    stats.attempted !== 0 ||
    stats.visited !== frontier.cumulativeVisited ||
    stats.pending !== frontier.pendingCount ||
    stats.seen !== stats.visited + stats.pending
  ) {
    return integrityFailure();
  }
}
