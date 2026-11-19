import { Buffer } from "node:buffer";
import type { RobotsResult } from "@/server/lib/audit/discovery";
import type { AuditConfig, CrawledPageResult } from "@/server/lib/audit/types";
import {
  isAuditablePageUrl,
  isSameOrigin,
  normalizeUrl,
} from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import { FRONTIER_PART_ROWS } from "@/server/lib/audit/frontier-checkpoint";
import {
  runPageReporters,
  type DetectedIssue,
} from "@/server/lib/audit/issues/page-reporters";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  getAuditScratchpad,
  type FrontierStats,
} from "@/server/features/audit/AuditScratchpad";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { putTextToR2 } from "@/server/lib/r2";
import type { CrawlPhaseResult } from "@/server/workflows/siteAuditWorkflowCrawl";

// Leave room below the SQLite row and serialized RPC limits, respectively.
// These bound link payloads by size, independent of menu link count.
const MAX_LINK_ROW_BYTES = 1024 * 1024;
const SCRATCHPAD_BATCH_BYTES = 24 * 1024 * 1024;
/**
 * Cap newly discovered URLs sent to the scratchpad per persist sub-batch.
 * Serialized RPC messages are limited to 32 MiB; a crawler-trap page family
 * (faceted nav, calendars) can emit tens of thousands of unique URLs per
 * page. Dropped URLs are usually re-discovered from later pages, and a site
 * generating this many is past maxPages anyway.
 */
const MAX_DISCOVERED_PER_BATCH = 20_000;
const MAX_PROGRESS_TITLE_CHARS = 300;

function shouldQueueCrawlLink(
  link: string,
  origin: string,
  robots: RobotsResult,
  sitePlatform: AuditConfig["sitePlatform"],
): boolean {
  return (
    isSameOrigin(link, origin) &&
    isCrawlableUrl(link) &&
    isAuditablePageUrl(link, sitePlatform) &&
    robots.isAllowed(link)
  );
}

type ScratchpadBatch = Parameters<
  ReturnType<typeof getAuditScratchpad>["recordBatch"]
>[0];

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function emptyScratchpadBatch(): ScratchpadBatch {
  return { crawledUrls: [], pages: [], links: [], discovered: [] };
}

function scratchpadBatches(
  sources: Array<{
    page: CrawledPageResult;
    discovered: ScratchpadBatch["discovered"];
  }>,
): ScratchpadBatch[] {
  const batches: ScratchpadBatch[] = [];
  let batch = emptyScratchpadBatch();
  let batchBytes = 0;
  const reserve = (bytes: number) => {
    if (bytes > SCRATCHPAD_BATCH_BYTES) {
      throw new Error("One scratchpad record exceeds the RPC byte budget");
    }
    if (batchBytes + bytes > SCRATCHPAD_BATCH_BYTES) {
      batches.push(batch);
      batch = emptyScratchpadBatch();
      batchBytes = 0;
    }
    batchBytes += bytes;
  };

  for (const { page, discovered } of sources) {
    const { id: pageId, url, statusCode, fetchClass, redirectUrl } = page;
    const targets: string[] = [];
    const sourceBytes = jsonStringBytes(url);
    let rowBytes = sourceBytes + jsonStringBytes(pageId) + 32;
    let incomplete = page.linkCaptureIncomplete !== false;
    for (const link of page.links) {
      if (!link.isInternal) continue;
      const bytes = jsonStringBytes(link.targetUrl) + 1;
      if (rowBytes + bytes > MAX_LINK_ROW_BYTES) {
        incomplete = true;
        continue;
      }
      rowBytes += bytes;
      targets.push(link.targetUrl);
    }
    // Never split a source's discoveries from its page completion. A retry
    // can refetch exactly those sources whose RPC never committed.
    const discoveryBytes = discovered.reduce(
      (bytes, entry) => bytes + jsonStringBytes(entry.url) + 48,
      0,
    );
    reserve(
      rowBytes +
        2 * sourceBytes +
        jsonStringBytes(redirectUrl ?? "") +
        targets.length * 8 +
        256 +
        discoveryBytes,
    );
    batch.crawledUrls.push(url);
    batch.pages.push({ pageId, url, statusCode, fetchClass, redirectUrl });
    batch.links.push({ pageId, url, targets, incomplete });
    batch.discovered.push(...discovered);
  }
  batches.push(batch);
  return batches;
}

/**
 * Persists one crawled sub-batch: page rows and issues to the app DB, links
 * and newly discovered URLs to the scratchpad, and progress for the UI.
 */
export async function persistCrawledPages(input: {
  auditId: string;
  workflowInstanceId: string;
  origin: string;
  robots: RobotsResult;
  sitePlatform: AuditConfig["sitePlatform"];
  scratchpad: ReturnType<typeof getAuditScratchpad>;
  pages: CrawledPageResult[];
  depthByUrl: Map<string, number | null>;
  maxPages: number;
  previouslyVisited?: number;
}): Promise<FrontierStats> {
  const {
    auditId,
    origin,
    robots,
    sitePlatform,
    scratchpad,
    pages,
    depthByUrl,
  } = input;

  // Deterministic ids keep every write idempotent across step retries.
  for (const page of pages) {
    page.id = await deterministicAuditRowId(auditId, page.url);
  }
  const issues = pages.flatMap((page) => runPageReporters(page));
  await AuditRepository.insertCrawledBatch(auditId, pages, issues);

  const seen = new Set<string>();
  let discoveryLimited = false;
  const sources = pages.map((page) => {
    const discovered: ScratchpadBatch["discovered"] = [];
    const pageDepth = depthByUrl.get(page.url) ?? null;
    const childDepth = pageDepth === null ? null : pageDepth + 1;

    for (const link of page.links) {
      if (!link.isInternal || seen.has(link.targetUrl)) continue;
      if (discoveryLimited) break;
      if (!shouldQueueCrawlLink(link.targetUrl, origin, robots, sitePlatform))
        continue;
      if (seen.size >= MAX_DISCOVERED_PER_BATCH) {
        discoveryLimited = true;
        continue;
      }
      seen.add(link.targetUrl);
      discovered.push({ url: link.targetUrl, depth: childDepth });
    }
    // Redirect targets continue the same navigation path: same depth.
    if (
      page.redirectUrl &&
      !seen.has(page.redirectUrl) &&
      shouldQueueCrawlLink(page.redirectUrl, origin, robots, sitePlatform)
    ) {
      seen.add(page.redirectUrl);
      discovered.push({ url: page.redirectUrl, depth: pageDepth });
    }
    return { page, discovered };
  });

  const [firstBatch, ...remainingBatches] = scratchpadBatches(sources);
  if (discoveryLimited) firstBatch.discoveryLimited = true;
  let stats = await scratchpad.recordBatch(firstBatch);
  for (const batch of remainingBatches) {
    stats = await scratchpad.recordBatch(batch);
  }

  await AuditRepository.updateAuditProgress(auditId, input.workflowInstanceId, {
    pagesCrawled: stats.attempted,
    pagesTotal: Math.min(
      stats.seen - (input.previouslyVisited ?? 0),
      input.maxPages,
    ),
  });
  await AuditProgressKV.pushCrawledUrls(
    auditId,
    pages.map((page) => ({
      url: page.url,
      statusCode: page.statusCode,
      title: page.title.slice(0, MAX_PROGRESS_TITLE_CHARS),
      crawledAt: Date.now(),
    })),
  );
  return stats;
}

// Reuse the audit's private R2 prefix so audit, project and account deletion
// reclaim the export. Stable part keys make retries overwrite the same data.
async function exportCappedFrontier(
  projectId: string,
  auditId: string,
  expectedCount: number,
) {
  const scratchpad = getAuditScratchpad(auditId);
  const frontierPrefix = `site-audit/${projectId}/${auditId}/frontier/v1/`;
  let afterUrl = "";
  let frontierParts = 0;
  let exported = 0;
  for (;;) {
    const rows = await scratchpad.readPendingUrls(afterUrl, FRONTIER_PART_ROWS);
    const last = rows.at(-1);
    if (!last) break;
    exported += rows.length;
    if (exported > expectedCount) break;
    frontierParts += 1;
    await putTextToR2(
      `${frontierPrefix}${frontierParts}.json`,
      JSON.stringify(rows),
    );
    if (rows.length < FRONTIER_PART_ROWS) break;
    afterUrl = last.url;
  }
  if (exported !== expectedCount) {
    throw new Error("Capped frontier does not match the pending URL count");
  }
  return { frontierPrefix, frontierParts };
}

/**
 * Collect the audit's link and coverage findings before dropping scratch state.
 */
export async function collectScratchpadIssues(
  auditId: string,
  projectId: string,
  startUrl: string,
  crawl: CrawlPhaseResult,
  checkpoint?: { saved: true; hasPriorPages: boolean },
): Promise<DetectedIssue[]> {
  const scratchpad = getAuditScratchpad(auditId);
  const { brokenLinks, orphanPages } = await scratchpad.runFinalizeChecks({
    // Page rows store normalized URLs; normalize the start URL the same way
    // so the orphan exclusion matches.
    startUrl: normalizeUrl(startUrl) ?? startUrl,
    // Orphan detection only makes sense when the crawl wasn't truncated.
    crawlCompleted: crawl.completed,
    ...(checkpoint?.hasPriorPages ? { hasPriorPages: true } : {}),
  });

  const issues: DetectedIssue[] = [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link" as const,
      pageId: row.previous ? null : row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page" as const,
      pageId: row.previous ? null : row.pageId,
      pageUrl: row.url,
    })),
  ];
  if (crawl.stopIssue) {
    const { issueType, details } = crawl.stopIssue;
    const urlsNotCrawled = details?.urlsNotCrawled;
    const frontier =
      issueType === "crawl-page-limit" && urlsNotCrawled
        ? checkpoint
          ? {
              frontierPrefix: `site-audit/${projectId}/${auditId}/frontier/v1/`,
              frontierParts: Math.ceil(urlsNotCrawled / FRONTIER_PART_ROWS),
            }
          : await exportCappedFrontier(projectId, auditId, urlsNotCrawled)
        : undefined;
    issues.push({
      issueType,
      pageId: null,
      pageUrl: startUrl,
      details: frontier ? { ...details, ...frontier } : details,
    });
  }
  return issues;
}
