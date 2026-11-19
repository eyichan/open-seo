/**
 * The scratchpad's SQLite schema and its two finalize link queries, kept in a
 * plain module (no `cloudflare:workers` import) so they can be exercised
 * against a real SQLite engine in tests as well as inside the Durable Object.
 */
import type { ScratchpadPageLinksRow } from "./AuditScratchpad";

export function serializeLinkCapture(
  row: ScratchpadPageLinksRow,
  keepTargets: boolean,
) {
  // Keep a bounded eligibility/capture record even after the edge budget is full.
  // The last element is the completeness flag read by existing graph checks.
  return JSON.stringify([
    ...(keepTargets ? row.targets : []),
    ...(row.isHtml === undefined
      ? []
      : [
          {
            html: row.isHtml,
            unqueuedFrom: keepTargets
              ? (row.unqueuedFrom ?? row.targets.length)
              : 0,
            unqueuedRedirect: row.unqueuedRedirect ?? false,
            robotsExcludedFrom: keepTargets
              ? row.robotsExcludedFrom
              : undefined,
            robotsExcludedRedirect: row.robotsExcludedRedirect,
            captureReason:
              row.captureReason ??
              (keepTargets ? undefined : "link-storage-limit"),
          },
        ]),
    ...(keepTargets && row.incomplete === undefined
      ? []
      : [keepTargets && !row.incomplete]),
  ]);
}

/**
 * `page_links` holds one row per crawled page — its internal link targets as
 * a JSON array of URL strings with a trailing completeness boolean —
 * instead of one row per edge. Rows written is
 * the DO SQLite billing unit, and link edges dominate an audit's writes.
 * WITHOUT ROWID keeps the TEXT primary key as the table itself, so a page
 * costs exactly one row written rather than a row plus an autoindex entry.
 *
 * The legacy per-edge `links` table is still declared (without its target
 * index, which nothing queries any more) so an audit that was mid-crawl when
 * the JSON layout shipped can still be finalized from the rows its earlier
 * chunks wrote. Delete the table and the UNION ALL branches in the queries
 * below after 2026-09-10: the 7-day cleanup alarm guarantees every such
 * object is finished or wiped by then.
 */
export const SCRATCHPAD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS frontier (
    url TEXT PRIMARY KEY,
    depth INTEGER,
    source TEXT NOT NULL,
    in_sitemap INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    chunk_no INTEGER
  );
  CREATE INDEX IF NOT EXISTS frontier_claim_idx ON frontier (state, source);
  CREATE TABLE IF NOT EXISTS page_links (
    page_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    targets_json TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS links (
    source_page_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    target_url TEXT NOT NULL,
    PRIMARY KEY (source_page_id, target_url)
  );
  CREATE TABLE IF NOT EXISTS page_mirror (
    page_id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    status_code INTEGER,
    fetch_class TEXT NOT NULL,
    redirect_url TEXT
  );
  CREATE INDEX IF NOT EXISTS page_mirror_redirect_idx ON page_mirror (redirect_url);
  CREATE TABLE IF NOT EXISTS coverage_flags (name TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS navigation_depth (
    page_rowid INTEGER PRIMARY KEY,
    depth INTEGER NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0,
    unknown_at INTEGER,
    html INTEGER
  );
  CREATE INDEX IF NOT EXISTS navigation_depth_next_idx
    ON navigation_depth (depth, page_rowid) WHERE settled = 0;
  CREATE INDEX IF NOT EXISTS navigation_depth_gap_idx
    ON navigation_depth (unknown_at) WHERE unknown_at IS NOT NULL;
`;

/**
 * The next pending URLs for one crawl chunk. Takes (pagesLeftAfterChunk,
 * limit), where pagesLeftAfterChunk is the audit's page budget once this
 * chunk's pages are crawled.
 *
 * Pages a link has reached go first, oldest first, because only a link gives
 * a page its click depth; pages only the sitemap lists follow. On a site
 * whose links keep leading to more unlisted pages (tag archives, filters),
 * that order alone spends the whole budget before the crawl gets back to the
 * sitemap. So a page the sitemap doesn't list is claimed only while the
 * budget left after this chunk still covers every sitemap page waiting.
 * Depth 0 is the start page, which is crawled either way.
 */
export const FRONTIER_CLAIM_SQL = `
  SELECT url, depth, in_sitemap FROM frontier
  WHERE state = 'pending' AND (
    in_sitemap = 1 OR depth = 0 OR (
      SELECT COUNT(*) FROM frontier WHERE state = 'pending' AND in_sitemap = 1
    ) <= ?
  )
  ORDER BY CASE source WHEN 'link' THEN 0 ELSE 1 END, rowid
  LIMIT ?
`;

/**
 * Queue one link-discovered URL. Already-seen URLs keep their row (the
 * global dedup), except that a pending row with no click depth yet — almost
 * always a sitemap seed — takes the link's depth and link-queue priority
 * while keeping its in-sitemap flag. Sitemap seeding covers the whole
 * sitemap, so without this every linked sitemap page would crawl in sitemap
 * order with no depth. Takes (url, depth).
 */
export const FRONTIER_DISCOVER_SQL = `
  INSERT INTO frontier (url, depth, source, in_sitemap) VALUES (?, ?, 'link', 0)
  ON CONFLICT(url) DO UPDATE SET source = 'link', depth = excluded.depth
  WHERE frontier.state = 'pending' AND frontier.depth IS NULL
    AND excluded.depth IS NOT NULL
`;

/**
 * Every internal link whose target we crawled and saw fail. `json_each`
 * expands a page's target array into one row per edge; the join is on
 * page_mirror's UNIQUE url, so it stays an index seek per link. CROSS JOIN
 * pins that order — left to itself the planner drives page_mirror off
 * `fetch_class` via an automatic index and re-expands the JSON array per
 * candidate, which is quadratic in page count. Takes the issue cap as its
 * only parameter.
 */
export const BROKEN_LINKS_SQL = `
  SELECT source_page_id, source_url, target_url, target_status FROM (
    SELECT p.page_id AS source_page_id, p.url AS source_url, j.value AS target_url,
           m.status_code AS target_status
    FROM page_links p, json_each(p.targets_json) AS j
    CROSS JOIN page_mirror m ON m.url = j.value
    WHERE j.type = 'text' AND m.status_code >= 400 AND m.fetch_class = 'ok'
    UNION ALL
    SELECT l.source_page_id, l.source_url, l.target_url, m.status_code AS target_status
    FROM links l JOIN page_mirror m ON m.url = l.target_url
    WHERE m.status_code >= 400 AND m.fetch_class = 'ok'
  )
  ORDER BY source_page_id, target_url
  LIMIT ?
`;

/** Every crawled page must attest to complete capture, including zero edges. */
export const INCOMPLETE_LINK_GRAPH_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM page_mirror m
    LEFT JOIN page_links p ON p.page_id = m.page_id
    WHERE json_type(p.targets_json, '$[#-1]') IS NOT 'true'
  ) AS incomplete
`;

/**
 * Pages nothing links to. The inbound set is built once and anti-joined,
 * rather than probed per page: without the old per-edge target index a
 * correlated NOT EXISTS would rescan the whole edge set for every page.
 * Self-links don't count (a page linking to itself doesn't rescue it), and
 * page_id is 1:1 with url in page_mirror, so comparing URLs is the same test
 * the per-edge form made on ids. Limit the materialized set to crawled URLs,
 * even if link targets include millions of URLs outside that set. Takes the
 * start URL as its only parameter.
 */
export const ORPHAN_PAGES_SQL = `
  SELECT m.page_id, m.url FROM page_mirror m
  LEFT JOIN (
    SELECT DISTINCT j.value AS target_url
    FROM page_links p, json_each(p.targets_json) AS j
    CROSS JOIN page_mirror candidate ON candidate.url = j.value
    WHERE j.type = 'text' AND j.value != p.url
    UNION ALL
    SELECT DISTINCT l.target_url
    FROM links l
    CROSS JOIN page_mirror candidate ON candidate.url = l.target_url
    WHERE l.target_url != l.source_url
  ) inbound ON inbound.target_url = m.url
  WHERE m.url != ?
    AND m.fetch_class = 'ok'
    AND m.status_code >= 200 AND m.status_code < 300
    AND inbound.target_url IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM page_mirror r WHERE r.redirect_url = m.url
    )
`;
