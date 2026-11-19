import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  discoverUrls,
  parseRobotsTxt,
  readAuditRobots,
} from "@/server/lib/audit/discovery";
import {
  failedLighthouseFetch,
  fetchLighthouseResult,
  selectLighthouseSample,
  storeLighthouseResult,
} from "@/server/lib/audit/lighthouse";
import {
  getOrigin,
  isAuditablePageUrl,
  isSameOrigin,
  normalizeUrl,
} from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  getAuditFrontier,
  restoreAuditFrontier,
} from "@/server/features/audit/services/AuditFrontier";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import type { AuditConfig } from "@/server/lib/audit/types";
import type { CrawlerAccess } from "@/shared/crawler-access";
import type { RenderUsage } from "@/shared/audit-rendering";
import { finalizeAudit } from "@/server/workflows/siteAuditWorkflowFinalize";
import { runCrawlPhase } from "@/server/workflows/siteAuditWorkflowCrawl";
import { pgStep } from "@/server/workflows/pgStep";
import {
  DB_STEP,
  DISCOVERY_STEP,
  LIGHTHOUSE_FETCH_STEP,
  LIGHTHOUSE_PERSIST_STEP,
  MULTIPAGE_CHECKS_STEP,
} from "@/server/workflows/auditStepConfigs";

/**
 * URLs fetched concurrently per wave. Each URL runs mobile + desktop, so one
 * wave holds up to 10 paid DataForSEO calls in flight; the aux worker's parse
 * lock serializes the memory-heavy payload parsing behind them.
 */
const LIGHTHOUSE_URL_CONCURRENCY = 5;
/** Frontier seeds per scratchpad RPC call. */
const SEED_RPC_BATCH = 2_000;

type AuditPhasesParams = {
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  access?: CrawlerAccess | null;
  renderUsage: RenderUsage;
  /** A metered rendered audit's credit hold, which the crawl must stay in. */
  renderHold?: { deadlineAt: number; credits: number };
};

export type DiscoveryResult = {
  robotsText: string | null;
  seededCount: number;
  coverage?: string[];
  cohortId?: string;
  previouslyVisited?: number;
};

export async function runAuditPhases(
  step: WorkflowStep,
  params: AuditPhasesParams,
) {
  const {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    access,
  } = params;
  const origin = getOrigin(startUrl);
  const maxPages = config.maxPages;

  const discoveryInput = {
    auditId,
    workflowInstanceId,
    origin,
    startUrl,
    maxPages,
    access,
  };
  const discovery = config.continuationFrom
    ? await runContinuationDiscovery(step, {
        ...discoveryInput,
        projectId,
        parentAuditId: config.continuationFrom,
      })
    : await runDiscoveryPhase(step, discoveryInput);
  // Parsed outside the step from checkpointed text, so replays see the exact
  // robots rules the original run used (a live re-fetch could differ and
  // desync the frontier from already-persisted crawl batches).
  const robots = parseRobotsTxt(origin, discovery.robotsText);
  const crawl = await runCrawlPhase(step, {
    ...params,
    origin,
    maxPages,
    robots,
    seededCount: discovery.seededCount,
    previouslyVisited: discovery.previouslyVisited,
    renderJavaScript: config.renderJavaScript,
    sitePlatform: config.sitePlatform,
  });
  await runLighthousePhase(step, {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
  });
  await finalizeAudit({
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
    discovery,
  });
}

async function runContinuationDiscovery(
  step: WorkflowStep,
  input: {
    auditId: string;
    workflowInstanceId: string;
    projectId: string;
    parentAuditId: string;
    origin: string;
    startUrl: string;
    maxPages: number;
    access?: CrawlerAccess | null;
  },
): Promise<DiscoveryResult> {
  return pgStep(
    step,
    "restore-audit-frontier",
    MULTIPAGE_CHECKS_STEP,
    async () => {
      const parent = await AuditRepository.getAuditForProject(
        input.parentAuditId,
        input.projectId,
      );
      if (!parent || parent.startUrl !== input.startUrl)
        throw new Error("Continuation parent context mismatch");
      const frontier = await getAuditFrontier(parent);
      if (!frontier)
        throw new Error("Continuation parent has no saved frontier");
      const { robotsText, robotsCoverage } = await readAuditRobots(
        input.origin,
        input.access,
      );
      if (robotsCoverage === "unavailable" || robotsCoverage === "truncated") {
        throw new Error("Cannot verify robots policy for the saved frontier");
      }
      await restoreAuditFrontier(
        parent,
        frontier,
        getAuditScratchpad(input.auditId),
        parseRobotsTxt(input.origin, robotsText).isAllowed,
      );
      await AuditRepository.updateAuditProgress(
        input.auditId,
        input.workflowInstanceId,
        {
          pagesTotal: Math.min(input.maxPages, frontier.pendingCount),
          currentPhase: "crawling",
        },
      );
      return {
        robotsText,
        seededCount: frontier.pendingCount,
        coverage:
          frontier.version === 2 && frontier.robotsText !== robotsText
            ? [...new Set([...frontier.discoveryGaps, "robots-policy-changed"])]
            : frontier.discoveryGaps,
        cohortId: frontier.cohortId,
        previouslyVisited: frontier.cumulativeVisited,
      };
    },
  );
}

async function runDiscoveryPhase(
  step: WorkflowStep,
  input: {
    auditId: string;
    workflowInstanceId: string;
    origin: string;
    startUrl: string;
    maxPages: number;
    access?: CrawlerAccess | null;
  },
): Promise<DiscoveryResult> {
  const { auditId, workflowInstanceId, origin, startUrl, maxPages, access } =
    input;
  // "-v2": the checkpoint shape changed (seeds now live in the scratchpad DO
  // instead of the step return). A pre-refactor instance replayed under this
  // code must re-run discovery — resuming from the old cached {sitemapUrls}
  // shape would leave the scratchpad empty and finalize a zero-page audit.
  return pgStep(step, "discover-urls-v2", DISCOVERY_STEP, async () => {
    const result = await discoverUrls(origin, maxPages, access);
    const robots = parseRobotsTxt(origin, result.robotsText);
    const scratchpad = getAuditScratchpad(auditId);

    // Seeds go straight into the scratchpad frontier — nothing large is
    // returned as step state (an uncapped seed list used to blow the ~1MiB
    // step-output limit on big sitemaps).
    let seededCount = 0;
    const normalizedStart = normalizeUrl(startUrl) ?? startUrl;
    if (
      robots.isAllowed(normalizedStart) &&
      isSameOrigin(normalizedStart, origin)
    ) {
      await scratchpad.seedStart(normalizedStart);
      seededCount += 1;
    }

    // The start URL is deliberately not excluded here: seedSitemapUrls
    // upserts, so a start URL that also appears in the sitemap keeps its
    // link-queue position but gains the in-sitemap flag.
    const seen = new Set<string>();
    const seeds: string[] = [];
    for (const url of result.urls) {
      const normalized = normalizeUrl(url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      if (!isSameOrigin(normalized, origin)) continue;
      if (!isCrawlableUrl(normalized)) continue;
      if (!isAuditablePageUrl(normalized)) continue;
      if (!robots.isAllowed(normalized)) continue;
      seeds.push(normalized);
    }
    for (let i = 0; i < seeds.length; i += SEED_RPC_BATCH) {
      await scratchpad.seedSitemapUrls(seeds.slice(i, i + SEED_RPC_BATCH));
    }
    seededCount += seeds.filter((seed) => seed !== normalizedStart).length;

    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      pagesTotal: Math.min(seededCount, maxPages),
      currentPhase: "crawling",
    });
    return {
      robotsText: result.robotsText,
      seededCount,
      coverage: result.coverage,
    };
  });
}

type LighthousePhaseParams = {
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
};

export async function runLighthousePhase(
  step: WorkflowStep,
  params: LighthousePhaseParams,
) {
  const {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
  } = params;
  if (config.lighthouseStrategy === "none") return;

  const lighthouseWork = await selectLighthousePages({
    step,
    auditId,
    workflowInstanceId,
    startUrl,
    strategy: config.lighthouseStrategy,
  });

  let completedChecks = 0;
  let failedChecks = 0;
  for (
    let chunkStart = 0;
    chunkStart < lighthouseWork.length;
    chunkStart += LIGHTHOUSE_URL_CONCURRENCY
  ) {
    const chunk = lighthouseWork.slice(
      chunkStart,
      chunkStart + LIGHTHOUSE_URL_CONCURRENCY,
    );

    // The paid calls are checkpointed separately from all storage. With
    // Workflow retries disabled, a later R2/DB/progress failure cannot replay
    // DataForSEO. One URL groups its mobile + desktop checks into one compact
    // checkpoint. allSettled, not all: a rejected step must not orphan the
    // sibling paid calls mid-flight — their checkpoints complete and persist
    // below either way.
    const settled = await Promise.allSettled(
      chunk.map(({ url, pageId }, chunkOffset) =>
        pgStep(
          step,
          `lighthouse-fetch-${chunkStart + chunkOffset + 1}`,
          LIGHTHOUSE_FETCH_STEP,
          () =>
            Promise.all([
              fetchLighthouseResult(url, pageId, "mobile", billingCustomer),
              fetchLighthouseResult(url, pageId, "desktop", billingCustomer),
            ]),
        ),
      ),
    );
    const fetched = settled.flatMap((outcome, chunkOffset) => {
      if (outcome.status === "fulfilled") return outcome.value;
      // Step timeout or engine failure — provider errors never reject here
      // (the audit-layer fetch converts them into errorMessage results).
      const { url, pageId } = chunk[chunkOffset];
      const message =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      return (["mobile", "desktop"] as const).map((strategy) =>
        failedLighthouseFetch(url, pageId, strategy, message),
      );
    });

    const chunkIndex = Math.floor(chunkStart / LIGHTHOUSE_URL_CONCURRENCY) + 1;
    const priorCompleted = completedChecks;
    const priorFailed = failedChecks;
    const counts = await pgStep(
      step,
      `lighthouse-persist-chunk-${chunkIndex}`,
      LIGHTHOUSE_PERSIST_STEP,
      async () => {
        const results = await Promise.all(
          fetched.map((result) =>
            storeLighthouseResult({
              projectId,
              auditId,
              fetched: result,
            }),
          ),
        );
        await AuditRepository.insertLighthouseResults(auditId, results);

        const failed = results.filter((result) => result.errorMessage).length;
        const completed = results.length - failed;
        await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
          lighthouseCompleted: priorCompleted + completed,
          lighthouseFailed: priorFailed + failed,
        });
        return { completed, failed };
      },
    );

    completedChecks += counts.completed;
    failedChecks += counts.failed;
  }
}

async function selectLighthousePages(params: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  startUrl: string;
  strategy: AuditConfig["lighthouseStrategy"];
}) {
  const { step, auditId, workflowInstanceId, startUrl, strategy } = params;
  return pgStep(step, "select-lighthouse-sample", DB_STEP, async () => {
    // Crawled pages come from the DB — the crawl phase no longer holds a
    // whole-crawl page list in memory.
    const crawledPages = await AuditRepository.getPagesForAudit(auditId);
    const sample = selectLighthouseSample(
      crawledPages.map((page) => ({
        ...page,
        statusCode: page.statusCode ?? 0,
      })),
      startUrl,
      strategy,
    );
    const selectedUrls = new Set(sample);

    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "lighthouse",
      lighthouseTotal: sample.length * 2,
      lighthouseCompleted: 0,
      lighthouseFailed: 0,
    });
    return crawledPages.flatMap((page) =>
      selectedUrls.has(page.url) ? [{ url: page.url, pageId: page.id }] : [],
    );
  });
}
