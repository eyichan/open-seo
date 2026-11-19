import type { AuditDepthCoverage } from "@/server/lib/audit/frontier-checkpoint";
import { isAuditablePageUrl, isSameOrigin } from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import type { AuditConfig } from "@/server/lib/audit/types";
import {
  diagnosticLocation,
  MISSING_LINK_TARGETS,
  readDepthGap,
} from "./scratchpad-depth-diagnostics";

const BATCH_VERTICES = 128;
const BATCH_LINK_BYTES = 4 * 1024 * 1024;
const RESULT_ROWS = 200;
const RESULT_BYTES = 4 * 1024 * 1024;

function nearestUnknown(sql: SqlStorage) {
  return (
    sql
      .exec<{ depth: number }>(
        `SELECT unknown_at AS depth FROM navigation_depth
     WHERE unknown_at IS NOT NULL ORDER BY unknown_at LIMIT 1`,
      )
      .toArray()[0]?.depth ?? null
  );
}

/** Work stays in the audit's SQLite object, including across RPC retries. */
export function advanceNavigation(
  storage: DurableObjectStorage,
  startUrl: string,
  sitePlatform?: AuditConfig["sitePlatform"],
) {
  const sql = storage.sql;
  return storage.transactionSync(() => {
    sql.exec(
      `INSERT OR IGNORE INTO navigation_depth (page_rowid, depth)
       SELECT rowid, 0 FROM page_mirror WHERE url = ?`,
      startUrl,
    );
    let cutoff = nearestUnknown(sql);
    let bytes = 0;
    for (let i = 0; i < BATCH_VERTICES; i++) {
      const next = sql
        .exec<{
          id: number;
          depth: number;
          pageId: string;
          redirect: string | null;
          redirectRowId: number | null;
          linkBytes: number;
          unknownFetch: number;
          captureComplete: number;
          unqueuedFrom: number | null;
          unqueuedRedirect: number | null;
          html: number | null;
        }>(
          `SELECT n.page_rowid AS id, n.depth, m.page_id AS pageId,
                CASE WHEN m.fetch_class = 'ok' AND m.status_code >= 300
                          AND m.status_code < 400 THEN m.redirect_url END AS redirect,
                r.rowid AS redirectRowId,
                coalesce(length(CAST(p.targets_json AS BLOB)), 0) AS linkBytes,
                (m.fetch_class != 'ok' OR m.status_code IS NULL OR m.status_code >= 500) AS unknownFetch,
                (json_type(p.targets_json, '$[#-1]') IS 'true') AS captureComplete,
                json_extract(p.targets_json, '$[#-2].unqueuedFrom') AS unqueuedFrom,
                json_extract(p.targets_json, '$[#-2].unqueuedRedirect') AS unqueuedRedirect,
                CASE WHEN m.fetch_class = 'ok' AND m.status_code >= 200 AND m.status_code < 300
                     THEN json_extract(p.targets_json, '$[#-2].html') ELSE 0 END AS html
         FROM (SELECT page_rowid, depth FROM navigation_depth
               WHERE settled = 0 ORDER BY depth, page_rowid LIMIT 1) n
         JOIN page_mirror m ON m.rowid = n.page_rowid
         LEFT JOIN page_mirror r ON r.url = m.redirect_url
         LEFT JOIN page_links p ON p.page_id = m.page_id`,
        )
        .toArray()[0];
      if (!next || (cutoff !== null && next.depth > cutoff)) return true;
      if (i > 0 && bytes + next.linkBytes > BATCH_LINK_BYTES) break;
      bytes += next.linkBytes;

      // All unsettled distances are d or d+1 while expanding depth d.
      // An anchor cannot improve a queued distance. A redirect can lower it
      // once, from d+1 to d, before the target is settled.
      let unknownAt: number | null = next.unknownFetch ? next.depth : null;
      if (next.redirect !== null && next.redirectRowId !== null) {
        sql.exec(
          `INSERT INTO navigation_depth (page_rowid, depth) VALUES (?, ?)
           ON CONFLICT(page_rowid) DO UPDATE SET depth = excluded.depth
           WHERE navigation_depth.settled = 0 AND excluded.depth < navigation_depth.depth`,
          next.redirectRowId,
          next.depth,
        );
      }
      if (
        next.redirect !== null &&
        next.redirectRowId === null &&
        (next.unqueuedRedirect === 1 ||
          (next.unqueuedRedirect === null &&
            isSameOrigin(next.redirect, startUrl) &&
            isCrawlableUrl(next.redirect) &&
            isAuditablePageUrl(next.redirect, sitePlatform)) ||
          sql
            .exec("SELECT 1 FROM frontier WHERE url = ?", next.redirect)
            .toArray().length > 0)
      )
        unknownAt = next.depth;

      const click = next.depth + 1;
      if (
        unknownAt === null &&
        (!next.captureComplete ||
          sql
            .exec(
              `SELECT 1 ${MISSING_LINK_TARGETS} LIMIT 1`,
              next.pageId,
              next.unqueuedFrom,
              next.unqueuedFrom,
            )
            .toArray().length > 0)
      )
        unknownAt = click;
      if (unknownAt !== null) cutoff = Math.min(cutoff ?? unknownAt, unknownAt);
      if (cutoff === null || click <= cutoff) {
        sql.exec(
          `INSERT OR IGNORE INTO navigation_depth (page_rowid, depth)
           SELECT m.rowid, ? FROM page_links p
           CROSS JOIN json_each(p.targets_json) j
           CROSS JOIN page_mirror m ON m.url = j.value
           WHERE p.page_id = ? AND j.type = 'text'`,
          click,
          next.pageId,
        );
      }
      sql.exec(
        "UPDATE navigation_depth SET settled = 1, unknown_at = ?, html = ? WHERE page_rowid = ?",
        unknownAt,
        next.html,
        next.id,
      );
    }
    return false;
  });
}

export function readNavigationCoverage(
  sql: SqlStorage,
  startUrl?: string,
): AuditDepthCoverage {
  const bound = nearestUnknown(sql);
  if (
    sql
      .exec(
        `SELECT 1 FROM navigation_depth WHERE settled = 0
     AND depth <= coalesce(?, depth) LIMIT 1`,
        bound,
      )
      .toArray().length
  )
    throw new Error("Navigation depth traversal is unfinished");
  const firstIncompleteDepth = sql
    .exec("SELECT 1 FROM navigation_depth LIMIT 1")
    .toArray().length
    ? bound
    : 0;
  let firstIncomplete: AuditDepthCoverage["firstIncomplete"];
  if (bound !== null) firstIncomplete = readDepthGap(sql, bound);
  else if (firstIncompleteDepth === 0) {
    firstIncomplete = {
      affectedSources: 0,
      samples: [
        {
          source: null,
          sourcePageId: null,
          reason: "start-unavailable",
          target: startUrl ? diagnosticLocation(startUrl) : null,
        },
      ],
    };
  }
  // A missing outgoing edge can only affect a path beyond the distance at
  // which the missing evidence was reached. The known prefix is still exact.
  return {
    method: "captured-navigation-v1",
    firstIncompleteDepth,
    ...(firstIncomplete ? { firstIncomplete } : {}),
    ...sql
      .exec<{
        cohortKnownPages: number;
        segmentKnownPages: number;
        knownPagesWithUnknownHtmlEligibility: number;
      }>(
        `SELECT count(*) FILTER (WHERE n.depth <= coalesce(?, n.depth)) AS cohortKnownPages,
              count(*) FILTER (WHERE n.depth <= coalesce(?, n.depth) AND f.state = 'crawled') AS segmentKnownPages,
              count(*) FILTER (WHERE n.depth <= coalesce(?, n.depth)
                 AND n.html IS NULL) AS knownPagesWithUnknownHtmlEligibility
       FROM page_mirror m
       CROSS JOIN frontier f ON f.url = m.url
       LEFT JOIN navigation_depth n ON n.page_rowid = m.rowid AND n.settled = 1`,
        firstIncompleteDepth,
        firstIncompleteDepth,
        firstIncompleteDepth,
      )
      .one(),
  };
}

export function readNavigationRows(
  sql: SqlStorage,
  after: number,
  firstIncompleteDepth: number | null,
) {
  const range = sql
    .exec<{ size: number; last: number | null }>(
      `SELECT count(*) AS size, max(cursor) FILTER (WHERE bytes <= ?) AS last
     FROM (
       SELECT cursor, sum(bytes) OVER (ORDER BY cursor) AS bytes FROM (
         SELECT rowid AS cursor, length(CAST(url AS BLOB)) + 160 AS bytes
         FROM page_mirror WHERE rowid > ? ORDER BY rowid LIMIT ?
       )
     )`,
      RESULT_BYTES,
      after,
      RESULT_ROWS,
    )
    .one();
  if (range.last === null) {
    if (range.size)
      throw new Error("Navigation row exceeds the RPC byte budget");
    return [];
  }
  return sql
    .exec<{
      cursor: number;
      id: string;
      url: string;
      crawlDepth: number | null;
      current: number;
      html: number | null;
    }>(
      `SELECT m.rowid AS cursor, m.page_id AS id, m.url,
            CASE WHEN n.depth <= coalesce(?, n.depth) THEN n.depth END AS crawlDepth,
            (f.state = 'crawled') AS current,
            n.html
     FROM page_mirror m
     CROSS JOIN frontier f ON f.url = m.url
     LEFT JOIN navigation_depth n ON n.page_rowid = m.rowid AND n.settled = 1
     WHERE m.rowid > ? AND m.rowid <= ? ORDER BY m.rowid`,
      firstIncompleteDepth,
      after,
      range.last,
    )
    .toArray();
}
