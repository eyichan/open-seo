import type { RobotsResult } from "@/server/lib/audit/discovery";
import type { AuditConfig, CrawledPageResult } from "@/server/lib/audit/types";
import {
  isAuditablePageUrl,
  isSameOrigin,
  normalizeUrl,
} from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import {
  runPageReporters,
  type DetectedIssue,
} from "@/server/lib/audit/issues/page-reporters";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  getAuditScratchpad,
  type FrontierStats,
  type ScratchpadPageLinksRow,
} from "@/server/features/audit/AuditScratchpad";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { putTextToR2 } from "@/server/lib/r2";
import type { CrawlPhaseResult } from "@/server/workflows/siteAuditWorkflowCrawl";

/**
 * Mega-menu/footer-heavy sites can carry 1000+ links per page; cap what we
 * record so a 10k-page crawl can't produce tens of millions of link targets
 * to scan at finalize.
 */
const MAX_STORED_LINKS_PER_PAGE = 500;
/**
 * Cap newly discovered URLs sent to the scratchpad per persist sub-batch.
 * Serialized RPC messages are limited to 32 MiB; a crawler-trap page family
 * (faceted nav, calendars) can emit tens of thousands of unique URLs per
 * page. Dropped URLs are usually re-discovered from later pages, and a site
 * generating this many is past maxPages anyway.
 */
const MAX_DISCOVERED_PER_BATCH = 20_000;
const MAX_PROGRESS_TITLE_CHARS = 300;
/** Keep each scratchpad read and R2 write bounded independently of crawl size. */
const FRONTIER_EXPORT_BATCH = 500;

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

  const links: ScratchpadPageLinksRow[] = [];
  const discovered = new Map<string, number | null>();
  for (const page of pages) {
    const pageDepth = depthByUrl.get(page.url) ?? null;
    const childDepth = pageDepth === null ? null : pageDepth + 1;

    const targets: string[] = [];
    for (const link of page.links) {
      if (!link.isInternal) continue;
      if (targets.length < MAX_STORED_LINKS_PER_PAGE) {
        targets.push(link.targetUrl);
      }
      if (
        discovered.size < MAX_DISCOVERED_PER_BATCH &&
        !discovered.has(link.targetUrl) &&
        shouldQueueCrawlLink(link.targetUrl, origin, robots, sitePlatform)
      ) {
        discovered.set(link.targetUrl, childDepth);
      }
    }
    if (targets.length > 0) {
      links.push({ pageId: page.id, url: page.url, targets });
    }

    // Redirect targets continue the same navigation path: same depth.
    if (
      page.redirectUrl &&
      !discovered.has(page.redirectUrl) &&
      shouldQueueCrawlLink(page.redirectUrl, origin, robots, sitePlatform)
    ) {
      discovered.set(page.redirectUrl, pageDepth);
    }
  }

  const stats = await scratchpad.recordBatch({
    crawledUrls: pages.map((page) => page.url),
    pages: pages.map((page) => ({
      pageId: page.id,
      url: page.url,
      statusCode: page.statusCode,
      fetchClass: page.fetchClass,
      redirectUrl: page.redirectUrl,
    })),
    links,
    discovered: Array.from(discovered, ([url, depth]) => ({ url, depth })),
  });

  await AuditRepository.updateAuditProgress(auditId, input.workflowInstanceId, {
    pagesCrawled: stats.attempted,
    pagesTotal: Math.min(stats.seen, input.maxPages),
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
    const rows = await scratchpad.readPendingUrls(
      afterUrl,
      FRONTIER_EXPORT_BATCH,
    );
    const last = rows.at(-1);
    if (!last) break;
    exported += rows.length;
    if (exported > expectedCount) break;
    frontierParts += 1;
    await putTextToR2(
      `${frontierPrefix}${frontierParts}.json`,
      JSON.stringify(rows),
    );
    if (rows.length < FRONTIER_EXPORT_BATCH) break;
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
): Promise<DetectedIssue[]> {
  const scratchpad = getAuditScratchpad(auditId);
  const { brokenLinks, orphanPages } = await scratchpad.runFinalizeChecks({
    // Page rows store normalized URLs; normalize the start URL the same way
    // so the orphan exclusion matches.
    startUrl: normalizeUrl(startUrl) ?? startUrl,
    // Orphan detection only makes sense when the crawl wasn't truncated.
    crawlCompleted: crawl.completed,
  });

  const issues: DetectedIssue[] = [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link" as const,
      pageId: row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page" as const,
      pageId: row.pageId,
      pageUrl: row.url,
    })),
  ];
  if (crawl.stopIssue) {
    const { issueType, details } = crawl.stopIssue;
    const urlsNotCrawled = details?.urlsNotCrawled;
    const frontier =
      issueType === "crawl-page-limit" && urlsNotCrawled
        ? await exportCappedFrontier(projectId, auditId, urlsNotCrawled)
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
