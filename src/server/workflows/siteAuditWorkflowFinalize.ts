import type { WorkflowStep } from "cloudflare:workers";
import { sort } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { saveAuditFrontier } from "@/server/features/audit/services/AuditFrontier";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import { reportDeepPage } from "@/server/lib/audit/issues/page-reporters";
import { auditDepthCoverageSchema } from "@/server/lib/audit/frontier-checkpoint";
import { normalizeUrl } from "@/server/lib/audit/url-utils";
import type { AuditConfig } from "@/server/lib/audit/types";
import { captureServerEvent } from "@/server/lib/posthog";
import { collectScratchpadIssues } from "@/server/workflows/siteAuditWorkflowPersist";
import type { CrawlPhaseResult } from "@/server/workflows/siteAuditWorkflowCrawl";
import type { DiscoveryResult } from "@/server/workflows/siteAuditWorkflowPhases";
import { pgStep } from "@/server/workflows/pgStep";
import {
  DB_STEP,
  MULTIPAGE_CHECKS_STEP,
} from "@/server/workflows/auditStepConfigs";

export async function finalizeAudit(args: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  crawl: CrawlPhaseResult;
  discovery: DiscoveryResult;
}) {
  const {
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
    discovery,
  } = args;

  const depthCoverage = await pgStep(
    step,
    "navigation-depth",
    MULTIPAGE_CHECKS_STEP,
    async () => {
      await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
        currentPhase: "finalizing",
      });
      const scratchpad = getAuditScratchpad(auditId);
      const root = normalizeUrl(startUrl);
      if (!root) throw new Error("Invalid navigation root");
      while (!(await scratchpad.advanceNavigation(root, config.sitePlatform))) {
        // Each RPC commits a bounded portion. Retries continue the same graph.
      }
      const coverage = auditDepthCoverageSchema.parse(
        await scratchpad.readNavigationCoverage(),
      );
      // Checkpoint the cleanup before any result batch runs.
      await AuditRepository.clearDepthIssues(auditId);
      return coverage;
    },
  );

  let cursor = 0;
  let seen = 0;
  for (;;) {
    const after = cursor;
    const result = await pgStep(
      step,
      `navigation-depth-write-${after}`,
      DB_STEP,
      async () => {
        const rows = await getAuditScratchpad(auditId).readNavigationRows(
          after,
          depthCoverage.firstIncompleteDepth,
        );
        if (!rows.length) return { cursor: null, count: 0 };
        const current = rows.filter((row) => row.current === 1);
        if (current.length)
          await AuditRepository.savePageDepths(auditId, current);
        await AuditRepository.insertIssues(
          auditId,
          rows.flatMap((row) => {
            const issue =
              row.html === 1
                ? reportDeepPage({
                    ...row,
                    id: row.current === 1 ? row.id : null,
                  })
                : null;
            return issue ? [issue] : [];
          }),
        );
        return { cursor: rows[rows.length - 1].cursor, count: current.length };
      },
    );
    seen += result.count;
    if (result.cursor === null) break;
    cursor = result.cursor;
  }
  if (seen !== crawl.pagesCrawled)
    throw new Error("Navigation depth rows do not match the audit segment");

  await pgStep(step, "multipage-checks", MULTIPAGE_CHECKS_STEP, async () => {
    // Integrity guard: pages are persisted inside crawl-chunk steps. If the
    // crawl claims pages but the DB has none, fail loudly instead of
    // completing with an empty audit.
    if (
      crawl.pagesCrawled > 0 &&
      !(await AuditRepository.hasPagesForAudit(auditId))
    ) {
      throw new Error(
        `Audit ${auditId}: crawl reported ${crawl.pagesCrawled} pages but none were persisted`,
      );
    }

    const checksStartedAt = Date.now();
    console.info("Audit finalization started", { auditId });
    const { issues, hasUnreadShells } = await runMultipageChecks({ auditId });
    console.info("Audit multipage checks completed", {
      auditId,
      durationMs: Date.now() - checksStartedAt,
      issueCount: issues.length,
    });
    const linksStartedAt = Date.now();
    const graphGaps = new Set(
      discovery.coverage ?? ["discovery-checkpoint-unavailable"],
    );
    if (hasUnreadShells) graphGaps.add("unread-javascript-shell");
    if (config.coverageVersion === 2) {
      const scratchpad = getAuditScratchpad(auditId);
      const stats = await scratchpad.getCoverage();
      if (
        stats.attempted !== crawl.pagesCrawled ||
        stats.visited !==
          crawl.pagesCrawled + (discovery.previouslyVisited ?? 0) ||
        stats.seen !== stats.visited + stats.pending ||
        (crawl.stopIssue?.issueType === "crawl-page-limit" &&
          stats.pending !== crawl.stopIssue.details?.urlsNotCrawled) ||
        (crawl.completed && stats.pending !== 0)
      )
        throw new Error("Crawl counts do not match the audit frontier");
      if (stats.discoveryLimited) graphGaps.add("link-discovery-limit");
      await saveAuditFrontier({
        auditId,
        projectId,
        startUrl,
        cohortId: discovery.cohortId ?? auditId,
        parentAuditId: config.continuationFrom ?? null,
        segmentPages: crawl.pagesCrawled,
        cumulativeVisited: stats.visited,
        pendingCount: stats.pending,
        unreadPages: stats.unread,
        graphComplete: stats.incomplete === 0,
        depthCoverage,
        discoveryGaps: sort([...graphGaps], (a, b) => a.localeCompare(b)),
        robotsText: discovery.robotsText,
        stop:
          crawl.stopIssue?.issueType ??
          (crawl.completed ? "exhausted" : "stalled"),
        scratchpad,
      });
    }
    const scratchpadIssues = await collectScratchpadIssues(
      auditId,
      projectId,
      startUrl,
      {
        ...crawl,
        completed:
          crawl.completed &&
          !hasUnreadShells &&
          (config.coverageVersion !== 2 || graphGaps.size === 0),
      },
      config.coverageVersion === 2
        ? { saved: true, hasPriorPages: Boolean(discovery.previouslyVisited) }
        : undefined,
    );
    console.info("Audit coverage checks completed", {
      auditId,
      durationMs: Date.now() - linksStartedAt,
      issueCount: scratchpadIssues.length,
    });
    issues.push(...scratchpadIssues);
    const persistStartedAt = Date.now();
    await AuditRepository.insertIssues(auditId, issues);
    console.info("Audit finalization issues persisted", {
      auditId,
      durationMs: Date.now() - persistStartedAt,
      issueCount: issues.length,
    });
    return { issueCount: issues.length };
  });

  await pgStep(step, "finalize", DB_STEP, async () => {
    const blockedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "blocked",
    );
    const rateLimitedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "rate_limited",
    );
    await AuditRepository.completeAudit(auditId, workflowInstanceId, {
      pagesCrawled: crawl.pagesCrawled,
      pagesTotal: crawl.pagesCrawled,
    });
    await captureServerEvent({
      distinctId: billingCustomer.userId,
      event: "site_audit:complete",
      organizationId: billingCustomer.organizationId,
      properties: {
        project_id: projectId,
        status: "completed",
        pages_crawled: crawl.pagesCrawled,
        pages_total: crawl.pagesCrawled,
        crawl_completed: crawl.completed,
        pages_blocked: blockedPages,
        pages_rate_limited: rateLimitedPages,
        run_lighthouse: config.lighthouseStrategy !== "none",
      },
    });
    await AuditProgressKV.clear(auditId);
    // Crawl scratch state (frontier, links, mirror) is no longer needed.
    await getAuditScratchpad(auditId).destroy();
  });
}
