import {
  FRONTIER_PART_ROWS,
  VISITED_PART_BYTES,
  type PendingUrl,
  type VisitedUrl,
} from "@/server/lib/audit/frontier-checkpoint";

export function readVisitedUrls(
  sql: SqlStorage,
  afterUrl: string,
): VisitedUrl[] {
  // The cheap keyset scan finds the batch boundary before loading JSON.
  // Account for JSON escaping when the JSON array is nested as a string.
  const candidates = sql
    .exec<{ url: string; n: number }>(
      `SELECT f.url, 2 * (length(CAST(f.url AS BLOB)) +
                coalesce(length(CAST(p.targets_json AS BLOB)), 0) +
                coalesce(length(CAST(m.redirect_url AS BLOB)), 0)) + 512 AS n
       FROM frontier f JOIN page_mirror m ON m.url = f.url
       LEFT JOIN page_links p ON p.page_id = m.page_id
       WHERE f.url > ? AND f.state IN ('crawled', 'prior')
       ORDER BY f.url LIMIT ?`,
      afterUrl,
      FRONTIER_PART_ROWS,
    )
    .toArray();
  let bytes = 0;
  let last = afterUrl;
  for (const row of candidates) {
    bytes += row.n;
    if (bytes > VISITED_PART_BYTES) break;
    last = row.url;
  }
  if (candidates.length && last === afterUrl)
    throw new Error("Visited URL exceeds checkpoint byte budget");
  return sql
    .exec<{
      url: string;
      depth: number | null;
      source: "link" | "sitemap";
      inSitemap: number;
      pageId: string;
      statusCode: number | null;
      fetchClass: string;
      redirectUrl: string | null;
      targetsJson: string | null;
    }>(
      `SELECT f.url, f.depth, f.source, f.in_sitemap AS inSitemap,
              m.page_id AS pageId, m.status_code AS statusCode, m.fetch_class AS fetchClass,
              m.redirect_url AS redirectUrl, p.targets_json AS targetsJson
       FROM frontier f JOIN page_mirror m ON m.url = f.url
       LEFT JOIN page_links p ON p.page_id = m.page_id
       WHERE f.url > ? AND f.url <= ? AND f.state IN ('crawled', 'prior')
       ORDER BY f.url`,
      afterUrl,
      last,
    )
    .toArray()
    .map((row) => ({ ...row, inSitemap: row.inSitemap === 1 }));
}

export function restoreCheckpoint(
  storage: DurableObjectStorage,
  input: {
    visited?: VisitedUrl[];
    pending?: PendingUrl[];
  },
): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    for (const row of input.visited ?? []) {
      restoreUrl(sql, row, "prior");
      sql.exec(
        `INSERT OR IGNORE INTO page_mirror VALUES (?, ?, ?, ?, ?)`,
        row.pageId,
        row.url,
        row.statusCode,
        row.fetchClass,
        row.redirectUrl,
      );
      if (row.targetsJson !== null) {
        sql.exec(
          "INSERT OR IGNORE INTO page_links VALUES (?, ?, ?)",
          row.pageId,
          row.url,
          row.targetsJson,
        );
      }
    }
    for (const row of input.pending ?? []) restoreUrl(sql, row, "pending");
  });
}

function restoreUrl(
  sql: SqlStorage,
  row: PendingUrl,
  state: "prior" | "pending",
) {
  sql.exec(
    `INSERT OR IGNORE INTO frontier (url, depth, source, in_sitemap, state) VALUES (?, ?, ?, ?, ?)`,
    row.url,
    row.depth,
    row.source,
    Number(row.inSitemap),
    state,
  );
  // INSERT OR IGNORE makes retrying a partial import safe. Different states
  // for a duplicate URL indicate an invalid checkpoint, not a retry.
  const existing = sql
    .exec<{
      state: string;
    }>("SELECT state FROM frontier WHERE url = ?", row.url)
    .one();
  if (existing.state !== state)
    throw new Error("Visited and pending checkpoint URLs overlap");
}
