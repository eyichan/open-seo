import {
  DEPTH_DIAGNOSTIC_SAMPLES,
  diagnosticUrlSchema,
  type AuditDepthCoverage,
  type LinkCaptureReason,
} from "@/server/lib/audit/frontier-checkpoint";

// Even an ordinary-looking path segment can be a credential. The page ID
// lets the existing tenant-scoped page inventory identify fetched sources.
export function diagnosticLocation(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  )
    return null;
  const path = url.pathname === "/" ? "/" : "/…";
  const parsed = diagnosticUrlSchema.safeParse(
    `${url.origin}${path}${url.search ? "?…" : ""}`,
  );
  return parsed.success ? parsed.data : null;
}

// The solver and its diagnostic sampler use the exact same missing-edge test.
export const MISSING_LINK_TARGETS = `FROM page_links p
  CROSS JOIN json_each(p.targets_json) j
  LEFT JOIN page_mirror m ON m.url = j.value
  LEFT JOIN frontier f ON f.url = j.value
  WHERE p.page_id = ? AND j.type = 'text' AND m.rowid IS NULL
    AND (f.rowid IS NOT NULL OR ? IS NULL OR j.key >= ?)`;

function pendingTarget(state: string | null) {
  return state === "pending" || state === "leased";
}

export function readDepthGap(sql: SqlStorage, depth: number) {
  const { affectedSources } = sql
    .exec<{
      affectedSources: number;
    }>(
      "SELECT count(*) AS affectedSources FROM navigation_depth WHERE unknown_at = ?",
      depth,
    )
    .one();
  const sources = sql
    .exec<{
      id: string;
      url: string;
      depth: number;
      redirect: string | null;
      redirectFrontierState: string | null;
      unread: number;
      captureComplete: number;
      captureReason: LinkCaptureReason | null;
      unqueuedFrom: number | null;
      robotsExcludedFrom: number | null;
      robotsExcludedRedirect: number | null;
    }>(
      `SELECT m.page_id AS id, m.url, n.depth, m.redirect_url AS redirect,
       f.state AS redirectFrontierState,
       (m.fetch_class != 'ok' OR m.status_code IS NULL OR m.status_code >= 500) AS unread,
       (json_type(p.targets_json, '$[#-1]') IS 'true') AS captureComplete,
       json_extract(p.targets_json, '$[#-2].captureReason') AS captureReason,
       json_extract(p.targets_json, '$[#-2].unqueuedFrom') AS unqueuedFrom,
       json_extract(p.targets_json, '$[#-2].robotsExcludedFrom') AS robotsExcludedFrom,
       json_extract(p.targets_json, '$[#-2].robotsExcludedRedirect') AS robotsExcludedRedirect
     FROM navigation_depth n
     JOIN page_mirror m ON m.rowid = n.page_rowid
     LEFT JOIN page_links p ON p.page_id = m.page_id
     LEFT JOIN frontier f ON f.url = m.redirect_url
     WHERE n.unknown_at = ? ORDER BY n.page_rowid LIMIT ?`,
      depth,
      DEPTH_DIAGNOSTIC_SAMPLES,
    )
    .toArray();
  const samples: NonNullable<AuditDepthCoverage["firstIncomplete"]>["samples"] =
    [];
  for (const row of sources) {
    if (samples.length === DEPTH_DIAGNOSTIC_SAMPLES) break;
    const source = {
      source: diagnosticLocation(row.url),
      sourcePageId: row.id,
    };
    if (row.unread) {
      samples.push({ ...source, reason: "unread-response" });
    } else if (row.depth === depth) {
      let reason: (typeof samples)[number]["reason"] = "missing-redirect";
      if (pendingTarget(row.redirectFrontierState)) reason = "pending-target";
      else if (
        row.redirectFrontierState === null &&
        row.robotsExcludedRedirect !== null
      )
        reason = row.robotsExcludedRedirect
          ? "robots-excluded"
          : "discovery-limit";
      samples.push({
        ...source,
        reason,
        target: row.redirect === null ? null : diagnosticLocation(row.redirect),
      });
    } else {
      if (!row.captureComplete)
        samples.push({
          ...source,
          reason: row.captureReason ?? "capture-incomplete",
        });
      // The capture row already has a byte budget. Deduplicate its masked
      // witnesses before spending the smaller diagnostic output budget.
      const seen = new Set<string>();
      for (const target of sql
        .exec<{
          url: string;
          position: number;
          state: string | null;
        }>(
          `SELECT j.value AS url, j.key AS position, f.state ${MISSING_LINK_TARGETS}`,
          row.id,
          row.unqueuedFrom,
          row.unqueuedFrom,
        )
        .toArray()) {
        if (samples.length === DEPTH_DIAGNOSTIC_SAMPLES) break;
        let reason: (typeof samples)[number]["reason"] = "missing-link-target";
        if (pendingTarget(target.state)) reason = "pending-target";
        else if (
          target.state === null &&
          row.robotsExcludedFrom !== null &&
          row.unqueuedFrom !== null &&
          target.position >= row.unqueuedFrom
        ) {
          reason =
            target.position >= row.robotsExcludedFrom
              ? "robots-excluded"
              : "discovery-limit";
        }
        const location = diagnosticLocation(target.url);
        const key = `${reason}:${location ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        samples.push({ ...source, reason, target: location });
      }
    }
  }
  return { affectedSources, samples };
}

export function readCaptureCoverage(sql: SqlStorage, includeSamples: boolean) {
  const incomplete = "json_type(p.targets_json, '$[#-1]') IS NOT 'true'";
  const reason = "json_extract(p.targets_json, '$[#-2].captureReason')";
  // Pick stable samples during the existing scan. Look up only their rows.
  const columns = includeSamples
    ? `, MIN(m.rowid) FILTER (WHERE ${incomplete}) AS firstSample,
         MIN(m.rowid) FILTER (WHERE ${reason} = 'html-byte-limit') AS htmlCapSample`
    : "";
  const stats = sql
    .exec<{
      visited: number;
      unread: number;
      incomplete: number;
      firstSample?: number | null;
      htmlCapSample?: number | null;
    }>(
      `SELECT COUNT(*) AS visited,
            COUNT(*) FILTER (WHERE m.fetch_class != 'ok') AS unread,
            COUNT(*) FILTER (WHERE ${incomplete}) AS incomplete${columns}
     FROM page_mirror m LEFT JOIN page_links p ON p.page_id = m.page_id`,
    )
    .one();
  const samples = includeSamples
    ? [...new Set([stats.htmlCapSample, stats.firstSample])].flatMap((id) => {
        if (id == null) return [];
        const row = sql
          .exec<{
            page_id: string;
            url: string;
            reason: LinkCaptureReason | null;
          }>(
            `SELECT m.page_id, m.url, ${reason} AS reason
              FROM page_mirror m LEFT JOIN page_links p ON p.page_id = m.page_id WHERE m.rowid = ?`,
            id,
          )
          .one();
        return [
          {
            source: diagnosticLocation(row.url),
            sourcePageId: row.page_id,
            reason: row.reason ?? "capture-incomplete",
          },
        ];
      })
    : [];
  return {
    visited: stats.visited,
    unread: stats.unread,
    incomplete: stats.incomplete,
    ...(includeSamples && stats.incomplete > 0
      ? { incompleteCapture: { affectedPages: stats.incomplete, samples } }
      : {}),
  };
}
