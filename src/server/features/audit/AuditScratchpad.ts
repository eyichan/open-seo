/**
 * Per-audit crawl scratchpad — a SQLite-backed Durable Object.
 *
 * Holds all transient crawl state for one audit (id = auditId): the frontier
 * (URL queue + seen-set), each page's internal link targets, and a slim
 * mirror of page rows. This keeps chatty crawl-loop writes off Postgres,
 * removes the ~1MiB Workflow step-output limits (nothing large flows through
 * step returns anymore), and gives the finalize link checks a local SQL
 * database.
 *
 * Lifecycle: seeded by the discover-urls step, read/written by every crawl
 * chunk, queried once at finalize, then destroyed on success. A self-cleanup
 * alarm set on every construction guarantees any instantiation — including a
 * write racing in after destroy() — is wiped after 7 days (failed audits'
 * state doubles as the resume/debug artifact until then).
 *
 * SQL mutations are synchronous; key-value checkpoints await durable writes.
 * Writes are idempotent: the workflow retries steps, so
 * every insert is OR IGNORE / OR REPLACE on a stable key.
 */
import { DurableObject, env } from "cloudflare:workers";
import type { CrawlThrottleState } from "@/server/lib/audit/crawl-throttle";
import type { LinkCaptureReason } from "@/server/lib/audit/frontier-checkpoint";
import type { AuditConfig } from "@/server/lib/audit/types";
import { readVisitedUrls, restoreCheckpoint } from "./scratchpad-checkpoint";
import { readCaptureCoverage } from "./scratchpad-depth-diagnostics";
import {
  advanceNavigation,
  readNavigationCoverage,
  readNavigationRows,
} from "./scratchpad-navigation";
import {
  BROKEN_LINKS_SQL,
  FRONTIER_CLAIM_SQL,
  FRONTIER_DISCOVER_SQL,
  INCOMPLETE_LINK_GRAPH_SQL,
  ORPHAN_PAGES_SQL,
  SCRATCHPAD_SCHEMA_SQL,
  serializeLinkCapture,
} from "@/server/features/audit/scratchpad-sql";

export interface ClaimedUrl {
  url: string;
  /** Provisional click estimate for scheduling. Final depth is graph-derived. */
  depth: number | null;
  inSitemap: boolean;
}

interface ClaimedChunk {
  urls: ClaimedUrl[];
  /**
   * True when a prior attempt of this chunk already claimed work — i.e. the
   * caller is a workflow step retry after that attempt died mid-crawl. The
   * crawler uses this to retry far more conservatively (the usual cause of a
   * dead attempt is exceededMemory).
   */
  isRetry: boolean;
}

export interface FrontierStats {
  /** Pages attempted (crawled or errored) so far. */
  attempted: number;
  /** URLs still waiting to be crawled. */
  pending: number;
  /** Every URL ever enqueued (attempted + pending + leased). */
  seen: number;
}

interface ScratchpadPageRow {
  pageId: string;
  url: string;
  statusCode: number;
  fetchClass: string;
  redirectUrl: string | null;
}

/** One crawled page's internal link targets — the whole row is one write. */
export interface ScratchpadPageLinksRow {
  pageId: string;
  url: string;
  /** Same-origin link targets, already deduped by the page analyzer. */
  targets: string[];
  /** True when extraction or bounded RPC/row packing omitted a target. */
  incomplete?: boolean;
  captureReason?: LinkCaptureReason;
  isHtml?: boolean;
  /** Unqueued navigation targets form the suffix of the target array. */
  unqueuedFrom?: number;
  unqueuedRedirect?: boolean;
  robotsExcludedFrom?: number;
  robotsExcludedRedirect?: boolean;
}

interface RecordBatchInput {
  /** URLs whose crawl attempt finished (successfully or not). */
  crawledUrls: string[];
  pages: ScratchpadPageRow[];
  links: ScratchpadPageLinksRow[];
  /** Newly discovered same-origin URLs to enqueue (already policy-filtered). */
  discovered: Array<{ url: string; depth: number | null }>;
  discoveryLimited?: boolean;
}

interface BrokenLinkRow {
  sourcePageId: string;
  sourceUrl: string;
  targetUrl: string;
  targetStatus: number;
  previous?: true;
}

interface OrphanPageRow {
  pageId: string;
  url: string;
  previous?: true;
}

const BROKEN_LINK_ISSUE_CAP = 2_000;
const CLEANUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Stop storing link targets once the database reaches this size. The link
 * arrays are the only unbounded-per-page data; a pathological link-dense site
 * could otherwise hit the platform's per-object SQLite cap (1 GB on the free
 * plan self-hosters may run on) and fail the crawl with SQLITE_FULL. Past the
 * budget the crawl continues with partial broken link coverage and no orphan
 * conclusions.
 */
const LINK_STORAGE_BUDGET_BYTES = 500 * 1024 * 1024;

export class AuditScratchpad extends DurableObject {
  constructor(ctx: DurableObjectState, workerEnv: Env) {
    super(ctx, workerEnv);
    this.ctx.storage.sql.exec(SCRATCHPAD_SCHEMA_SQL);
    // Guarantee the cleanup alarm on EVERY instantiation, not just at seed:
    // any RPC (even one racing in right after destroy()) re-creates the
    // schema, and without an alarm that storage would leak forever.
    // blockConcurrencyWhile gates RPC delivery on its own; the returned
    // promise doesn't need observing (constructors can't await).
    void this.ctx.blockConcurrencyWhile(() => this.ensureCleanupAlarm());
  }

  async seedStart(url: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO frontier (url, depth, source, in_sitemap) VALUES (?, 0, 'link', 0)`,
      url,
    );
  }

  async getCrawlThrottle(): Promise<CrawlThrottleState | undefined> {
    return this.ctx.storage.get<CrawlThrottleState>("crawl-throttle");
  }

  async saveCrawlThrottle(state: CrawlThrottleState): Promise<void> {
    await this.ctx.storage.put("crawl-throttle", state);
  }

  async seedSitemapUrls(urls: string[]): Promise<void> {
    for (const url of urls) {
      // Upsert so a URL that already exists (e.g. the start URL) still gets
      // its in-sitemap flag; queue position and depth stay as first seen.
      this.ctx.storage.sql.exec(
        `INSERT INTO frontier (url, depth, source, in_sitemap) VALUES (?, NULL, 'sitemap', 1)
         ON CONFLICT(url) DO UPDATE SET in_sitemap = 1`,
        url,
      );
    }
  }

  /**
   * Lease the next batch of pending URLs for one crawl chunk. Idempotent per
   * chunkNo: a retried step gets back exactly the URLs its failed attempt
   * had leased. `pagesLeft` is what remains of the audit's page budget; the
   * order and how the budget shapes it are on FRONTIER_CLAIM_SQL.
   */
  async claimChunk(
    chunkNo: number,
    limit: number,
    pagesLeft: number,
  ): Promise<ClaimedChunk> {
    const existing = this.selectClaimed(
      `SELECT url, depth, in_sitemap FROM frontier WHERE state = 'leased' AND chunk_no = ?`,
      chunkNo,
    );
    if (existing.length > 0) return { urls: existing, isRetry: true };
    // A retried step whose earlier attempt already crawled this chunk's
    // leases must not claim a fresh set under the same chunk number — that
    // would duplicate work and overshoot the page budget.
    const done = this.ctx.storage.sql
      .exec<{
        n: number;
      }>(
        `SELECT COUNT(*) AS n FROM frontier WHERE chunk_no = ? AND state = 'crawled'`,
        chunkNo,
      )
      .one();
    if (done.n > 0) return { urls: [], isRetry: true };
    if (limit <= 0) return { urls: [], isRetry: false };

    const fresh = this.selectClaimed(
      FRONTIER_CLAIM_SQL,
      pagesLeft - limit,
      limit,
    );
    for (const row of fresh) {
      this.ctx.storage.sql.exec(
        `UPDATE frontier SET state = 'leased', chunk_no = ? WHERE url = ?`,
        chunkNo,
        row.url,
      );
    }
    return { urls: fresh, isRetry: false };
  }

  /** Persist one crawled sub-batch: completions, mirror rows, links, frontier. */
  async recordBatch(input: RecordBatchInput): Promise<FrontierStats> {
    return this.ctx.storage.transactionSync(() => this.storeBatch(input));
  }

  private storeBatch(input: RecordBatchInput): FrontierStats {
    if (input.discoveryLimited) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO coverage_flags VALUES ('link-discovery-limited')",
      );
    }
    for (const url of input.crawledUrls) {
      this.ctx.storage.sql.exec(
        `UPDATE frontier SET state = 'crawled' WHERE url = ?`,
        url,
      );
    }
    for (const page of input.pages) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO page_mirror (page_id, url, status_code, fetch_class, redirect_url)
         VALUES (?, ?, ?, ?, ?)`,
        page.pageId,
        page.url,
        page.statusCode,
        page.fetchClass,
        page.redirectUrl,
      );
    }
    // Database size only ever grows (deletes happen solely via destroy), so
    // once the budget trips it stays tripped — runFinalizeChecks uses the
    // same comparison to know the link graph is incomplete.
    const keepTargets =
      this.ctx.storage.sql.databaseSize < LINK_STORAGE_BUDGET_BYTES;
    for (const page of input.links) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO page_links (page_id, url, targets_json) VALUES (?, ?, ?)`,
        page.pageId,
        page.url,
        serializeLinkCapture(page, keepTargets),
      );
    }
    for (const found of input.discovered) {
      this.ctx.storage.sql.exec(FRONTIER_DISCOVER_SQL, found.url, found.depth);
    }
    return this.stats();
  }

  /** Return unattempted leases to the queue (chunk soft-deadline hit). */
  async releaseUrls(urls: string[]): Promise<void> {
    for (const url of urls) {
      this.ctx.storage.sql.exec(
        `UPDATE frontier SET state = 'pending', chunk_no = NULL WHERE url = ? AND state = 'leased'`,
        url,
      );
    }
  }

  /** Read pending URLs for the capped audit report without leasing any work. */
  async readPendingUrls(afterUrl: string, limit: number) {
    // Use the URL primary-key range scan instead of sorting the pending
    // state index again for each export page.
    return this.ctx.storage.sql
      .exec<{
        url: string;
        depth: number | null;
        source: "link" | "sitemap";
        in_sitemap: number;
      }>(
        `SELECT url, depth, source, in_sitemap FROM frontier
         WHERE url > ? AND +state = 'pending' ORDER BY url LIMIT ?`,
        afterUrl,
        limit,
      )
      .toArray()
      .map(({ url, depth, source, in_sitemap }) => ({
        url,
        depth,
        source,
        inSitemap: in_sitemap === 1,
      }));
  }

  async getStats(): Promise<FrontierStats> {
    return this.stats();
  }

  async getCoverage(includeCaptureSamples = false) {
    const sql = this.ctx.storage.sql;
    return {
      ...this.stats(),
      ...readCaptureCoverage(sql, includeCaptureSamples),
      discoveryLimited:
        sql.exec("SELECT 1 FROM coverage_flags LIMIT 1").toArray().length > 0,
    };
  }

  async advanceNavigation(
    startUrl: string,
    sitePlatform?: AuditConfig["sitePlatform"],
  ) {
    return advanceNavigation(this.ctx.storage, startUrl, sitePlatform);
  }

  async readNavigationCoverage(startUrl?: string) {
    return readNavigationCoverage(this.ctx.storage.sql, startUrl);
  }

  async readNavigationRows(after: number, firstIncompleteDepth: number | null) {
    return readNavigationRows(
      this.ctx.storage.sql,
      after,
      firstIncompleteDepth,
    );
  }

  async readVisitedUrls(afterUrl: string) {
    return readVisitedUrls(this.ctx.storage.sql, afterUrl);
  }

  async restoreCheckpoint(input: Parameters<typeof restoreCheckpoint>[1]) {
    restoreCheckpoint(this.ctx.storage, input);
  }

  /**
   * The two finalize checks that need link edges, as local SQL. Mirrors the
   * former Postgres implementations in multipage.ts exactly.
   */
  async runFinalizeChecks(input: {
    startUrl: string;
    crawlCompleted: boolean;
    hasPriorPages?: boolean;
  }): Promise<{ brokenLinks: BrokenLinkRow[]; orphanPages: OrphanPageRow[] }> {
    // Only flag targets we actually crawled and saw fail — never inferred
    // from absence. Blocked targets (WAF challenges) are excluded: a 403
    // from bot protection is not evidence of a broken link.
    const sql = this.ctx.storage.sql;
    const previous = (url: string) =>
      sql
        .exec("SELECT 1 FROM frontier WHERE url = ? AND state = 'prior'", url)
        .toArray().length
        ? { previous: true as const }
        : {};
    const brokenLinks = sql
      .exec<{
        source_page_id: string;
        source_url: string;
        target_url: string;
        target_status: number;
      }>(BROKEN_LINKS_SQL, BROKEN_LINK_ISSUE_CAP)
      .toArray()
      .map((row) => ({
        sourcePageId: row.source_page_id,
        sourceUrl: row.source_url,
        targetUrl: row.target_url,
        targetStatus: row.target_status,
        ...(input.hasPriorPages ? previous(row.source_url) : {}),
      }));

    // A live 2xx page is an orphan when no OTHER crawled page links to it
    // and nothing redirects to it. Only meaningful on a completed crawl with
    // a complete link graph — if the storage budget truncated link writes,
    // "no inbound edge" is missing data, not evidence of orphanhood.
    const linkGraphComplete =
      input.crawlCompleted &&
      sql.databaseSize < LINK_STORAGE_BUDGET_BYTES &&
      sql.exec<{ incomplete: number }>(INCOMPLETE_LINK_GRAPH_SQL).one()
        .incomplete === 0;
    const orphanPages = linkGraphComplete
      ? sql
          .exec<{
            page_id: string;
            url: string;
          }>(ORPHAN_PAGES_SQL, input.startUrl)
          .toArray()
          .map((row) => ({
            pageId: row.page_id,
            url: row.url,
            ...(input.hasPriorPages ? previous(row.url) : {}),
          }))
      : [];

    return { brokenLinks, orphanPages };
  }

  /** Wipe all state (success path, or explicit audit deletion). */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Same wipe exposed under the common erasure RPC used by account deletion. */
  async destroyForErasure(): Promise<void> {
    await this.destroy();
  }

  /**
   * Self-cleanup for audits whose workflow died without reaching finalize.
   * Full destroy(), not just deleteAll(): under our compatibility date,
   * deleteAll() does not clear alarm state, and a leftover alarm would keep
   * the object (and its billing) alive.
   */
  async alarm(): Promise<void> {
    await this.destroy();
  }

  private async ensureCleanupAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
    }
  }

  private selectClaimed(query: string, ...params: number[]): ClaimedUrl[] {
    return this.ctx.storage.sql
      .exec<{ url: string; depth: number | null; in_sitemap: number }>(
        query,
        ...params,
      )
      .toArray()
      .map((row) => ({
        url: row.url,
        depth: row.depth,
        inSitemap: row.in_sitemap === 1,
      }));
  }

  private stats(): FrontierStats {
    const row = this.ctx.storage.sql
      .exec<{ attempted: number; pending: number; seen: number }>(
        `SELECT
           COUNT(*) FILTER (WHERE state = 'crawled') AS attempted,
           COUNT(*) FILTER (WHERE state = 'pending') AS pending,
           COUNT(*) AS seen
         FROM frontier`,
      )
      .one();
    return {
      attempted: row.attempted,
      pending: row.pending,
      seen: row.seen,
    };
  }
}

/** Stub for the audit's scratchpad DO (one instance per audit id). */
export function getAuditScratchpad(auditId: string) {
  // env.d.ts declares the binding untyped (ambient contexts can't import the
  // class); narrow here so callers get typed RPC methods.
  const namespace =
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the binding is declared as this class in wrangler.jsonc
    env.AUDIT_SCRATCHPAD as unknown as DurableObjectNamespace<AuditScratchpad>;
  return namespace.get(namespace.idFromName(auditId));
}
