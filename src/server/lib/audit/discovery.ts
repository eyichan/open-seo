/**
 * robots.txt and sitemap.xml discovery for the site audit crawler.
 */
import robotsParser from "robots-parser";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { sort } from "remeda";
import { readBodyCapped, readTextPrefix } from "./html-response";
import { isSameOrigin, normalizeUrl } from "./url-utils";
import { isCrawlableUrl } from "./url-policy";
import { publicFetch } from "@/server/lib/public-fetch";
import { createRateLimitWait, type RateLimitWait } from "./crawl-throttle";
import type { CrawlerAccess } from "@/shared/crawler-access";
import {
  auditRequestHeaders,
  CRAWL_USER_AGENT,
} from "@/server/lib/audit/web-bot-auth";

const SITEMAP_FETCH_TIMEOUT_MS = 15_000;
// robots.txt is checkpointed as durable Workflow step state (~1MiB cap, shared
// with the rest of the step's return). RFC 9309 requires parsers to handle at
// least 500 KiB and permits ignoring anything beyond it — Google does exactly
// that — so this cap matches standard crawler behavior while keeping a
// misbehaving server (e.g. HTML at /robots.txt) from blowing the step limit.
const MAX_ROBOTS_TXT_BYTES = 500 * 1024;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;
const SITEMAP_CONCURRENCY = 5;
const SITEMAP_RETRIES = 1;
// Sitemap shards can legally reach 50 MB and SITEMAP_CONCURRENCY of them are
// read at once, so unbounded reads can exhaust Worker memory. Oversized
// shards are skipped whole — truncated XML would not parse anyway, and real
// generators shard far below this.
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "sitemap" || name === "url",
});

export interface RobotsResult {
  isAllowed: (url: string) => boolean;
  sitemapUrls: string[];
}

/**
 * Fetch the raw robots.txt body (null = missing/unreachable). Kept separate
 * from parsing so Workflows can checkpoint the text as durable step state and
 * re-derive the parsed result deterministically on replay.
 */
async function fetchRobotsTxt(
  origin: string,
  access: CrawlerAccess | null | undefined,
  waitForRateLimit: RateLimitWait,
) {
  try {
    const fetchRobots = () =>
      fetchFollowingRedirects(`${origin}/robots.txt`, 10_000, access);
    let fetched = await fetchRobots();
    if (
      fetched?.response.status === 429 &&
      (await waitForRateLimit(fetched.response))
    ) {
      fetched = await fetchRobots();
    }
    if (!fetched?.response.ok) {
      const status = fetched?.response.status;
      await fetched?.response.body?.cancel();
      return {
        robotsText: null,
        robotsCoverage:
          status === 404 || status === 410 ? "absent" : "unavailable",
      } as const;
    }
    const { text, capped } = await readTextPrefix(
      fetched.response,
      MAX_ROBOTS_TXT_BYTES,
    );
    return {
      robotsText: text,
      robotsCoverage: capped ? "truncated" : "read",
    } as const;
  } catch (error) {
    console.warn("Failed to fetch robots.txt:", error);
    return { robotsText: null, robotsCoverage: "unavailable" } as const;
  }
}

export function readAuditRobots(origin: string, access?: CrawlerAccess | null) {
  return fetchRobotsTxt(origin, access, createRateLimitWait());
}

const MAX_DISCOVERY_REDIRECT_HOPS = 5;

/**
 * Redirects are followed by hand so each hop is revalidated against the crawl
 * policy and crawler-access headers — bot-protection credentials — are
 * re-matched against the hop's host instead of riding along to another site.
 */
async function fetchFollowingRedirects(
  url: string,
  timeoutMs: number,
  access: CrawlerAccess | null | undefined,
): Promise<{ response: Response; finalUrl: string } | null> {
  // One budget for the whole chain, as the automatic follow had.
  const deadline = Date.now() + timeoutMs;
  let current = url;
  for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECT_HOPS; hop++) {
    const response = await publicFetch(current, {
      headers: await auditRequestHeaders(current, access),
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return null;

    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return null;
    }
    if (!isCrawlableUrl(next)) return null;
    current = next;
  }
  return null;
}

/** Deterministic: same text in, same result out. Null = everything allowed. */
export function parseRobotsTxt(
  origin: string,
  text: string | null,
): RobotsResult {
  if (text === null) {
    return { isAllowed: () => true, sitemapUrls: [] };
  }

  const robots = robotsParser(`${origin}/robots.txt`, text);
  return {
    // Our UA so an `OpenSEO-Audit` group wins over `*`.
    isAllowed: (url: string) => robots.isAllowed(url, CRAWL_USER_AGENT) ?? true,
    sitemapUrls: robots.getSitemaps(),
  };
}

/**
 * Fetch and parse a sitemap (supports sitemap index recursion).
 * Returns a flat list of page URLs found.
 */
function isProbablySitemapXml(
  contentType: string | null,
  body: string,
): boolean {
  if (contentType?.toLowerCase().includes("xml")) {
    return true;
  }

  const trimmed = body.trimStart().toLowerCase();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<urlset") ||
    trimmed.startsWith("<sitemapindex")
  );
}

function getSitemapLocations(input: unknown): string[] {
  if (!input) return [];
  const entries = Array.isArray(input) ? input : [input];
  return entries
    .map((entry) => {
      if (isRecord(entry)) {
        const loc = entry["loc"];
        return typeof loc === "string" ? loc : null;
      }
      return null;
    })
    .filter((loc): loc is string => typeof loc === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getParsedSitemapSections(parsed: unknown): {
  sitemap: unknown;
  url: unknown;
} {
  if (!parsed || typeof parsed !== "object") {
    return { sitemap: undefined, url: undefined };
  }

  const root = parsed as {
    sitemapindex?: { sitemap?: unknown };
    urlset?: { url?: unknown };
  };

  return {
    sitemap: root.sitemapindex?.sitemap,
    url: root.urlset?.url,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "name" in error && error.name === "TimeoutError";
}

async function fetchSitemapDocumentWithRetry(
  sitemapUrl: string,
  access: CrawlerAccess | null | undefined,
  waitForRateLimit: RateLimitWait,
): Promise<{
  nestedSitemaps: string[];
  pageUrls: string[];
  timedOut: boolean;
  state: "read" | "absent" | "unavailable" | "truncated";
}> {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl) {
    return {
      nestedSitemaps: [],
      pageUrls: [],
      timedOut: false,
      state: "unavailable",
    };
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= SITEMAP_RETRIES; attempt++) {
    try {
      const fetched = await fetchFollowingRedirects(
        normalizedSitemapUrl,
        SITEMAP_FETCH_TIMEOUT_MS,
        access,
      );
      if (!fetched) {
        return {
          nestedSitemaps: [],
          pageUrls: [],
          timedOut: false,
          state: "unavailable",
        };
      }
      const { response } = fetched;

      const finalUrl = normalizeUrl(fetched.finalUrl, normalizedSitemapUrl);
      if (!finalUrl || !isSameOrigin(finalUrl, normalizedSitemapUrl)) {
        await response.body?.cancel();
        return {
          nestedSitemaps: [],
          pageUrls: [],
          timedOut: false,
          state: "unavailable",
        };
      }

      if (
        response.status === 429 &&
        attempt < SITEMAP_RETRIES &&
        (await waitForRateLimit(response))
      ) {
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return {
          nestedSitemaps: [],
          pageUrls: [],
          timedOut: false,
          state:
            response.status === 404 || response.status === 410
              ? "absent"
              : "unavailable",
        };
      }

      const body = await readBodyCapped(response, MAX_SITEMAP_BYTES);
      if (
        body === null ||
        !isProbablySitemapXml(response.headers.get("content-type"), body) ||
        XMLValidator.validate(body) !== true
      ) {
        return {
          nestedSitemaps: [],
          pageUrls: [],
          timedOut: false,
          state: body === null ? "truncated" : "unavailable",
        };
      }

      const parsed = xmlParser.parse(body) as unknown;
      const sections = getParsedSitemapSections(parsed);
      const nestedSitemaps = getSitemapLocations(sections.sitemap)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);
      const pageUrls = getSitemapLocations(sections.url)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);

      return {
        nestedSitemaps,
        pageUrls,
        timedOut: false,
        state:
          sections.sitemap === undefined &&
          sections.url === undefined &&
          !/<(?:urlset|sitemapindex)\b/i.test(body)
            ? "unavailable"
            : "read",
      };
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt === SITEMAP_RETRIES) {
        break;
      }
    }
  }

  return {
    nestedSitemaps: [],
    pageUrls: [],
    timedOut: isTimeoutError(lastError),
    state: "unavailable",
  };
}

/**
 * Discover all page URLs from robots.txt + sitemaps for an origin.
 * Also tries the default /sitemap.xml if not listed in robots.txt.
 */
export async function discoverUrls(
  origin: string,
  maxPages = 50,
  access?: CrawlerAccess | null,
) {
  const waitForRateLimit = createRateLimitWait();
  const { robotsText, robotsCoverage } = await fetchRobotsTxt(
    origin,
    access,
    waitForRateLimit,
  );
  const robots = parseRobotsTxt(origin, robotsText);

  // Collect sitemap URLs: from robots.txt + default location
  const sitemapSources = new Set(robots.sitemapUrls);
  sitemapSources.add(`${origin}/sitemap.xml`);

  const maxDiscoveredUrls = Math.min(Math.max(maxPages * 20, 500), 50_000);
  const allUrls = new Set<string>();
  const coverage = new Set<string>();
  if (robotsCoverage === "unavailable" || robotsCoverage === "truncated") {
    coverage.add(`robots-${robotsCoverage}`);
  }
  const declared = new Set(
    robots.sitemapUrls.map((url) => normalizeUrl(url, origin)),
  );
  if ([...declared].some((url) => !url || !isSameOrigin(url, origin))) {
    coverage.add("sitemap-outside-origin");
  }

  const queue: Array<{ url: string; depth: number }> = Array.from(
    sitemapSources,
  )
    .map((url) => normalizeUrl(url, origin))
    .filter((url): url is string => url !== null)
    .filter((url) => isSameOrigin(url, origin))
    .map((url) => ({ url, depth: MAX_SITEMAP_DEPTH }));
  const seenSitemapDocs = new Set<string>();
  let fetchedDocs = 0;
  let failedDocs = 0;
  let timedOutDocs = 0;

  while (queue.length > 0 && allUrls.size < maxDiscoveredUrls) {
    if (fetchedDocs >= MAX_SITEMAP_DOCS) break;
    const batch = queue.splice(
      0,
      Math.min(SITEMAP_CONCURRENCY, MAX_SITEMAP_DOCS - fetchedDocs),
    );
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        const normalizedUrl = normalizeUrl(url);
        if (
          !normalizedUrl ||
          !isSameOrigin(normalizedUrl, origin) ||
          depth <= 0 ||
          seenSitemapDocs.has(normalizedUrl)
        ) {
          return;
        }

        seenSitemapDocs.add(normalizedUrl);
        fetchedDocs += 1;

        const result = await fetchSitemapDocumentWithRetry(
          normalizedUrl,
          access,
          waitForRateLimit,
        );
        if (result.state !== "read") {
          if (
            result.state !== "absent" ||
            declared.has(normalizedUrl) ||
            depth < MAX_SITEMAP_DEPTH
          ) {
            coverage.add(
              result.state === "truncated"
                ? "sitemap-byte-limit"
                : "sitemap-unavailable",
            );
          }
          failedDocs += 1;
          if (result.timedOut) {
            timedOutDocs += 1;
          }
          return;
        }

        for (const pageUrl of result.pageUrls) {
          if (!isSameOrigin(pageUrl, origin)) continue;
          if (allUrls.has(pageUrl)) continue;
          if (allUrls.size >= maxDiscoveredUrls) {
            coverage.add("sitemap-url-limit");
            break;
          }
          allUrls.add(pageUrl);
        }

        for (const nestedUrl of result.nestedSitemaps) {
          if (!isSameOrigin(nestedUrl, origin)) {
            coverage.add("sitemap-outside-origin");
            continue;
          }
          if (!seenSitemapDocs.has(nestedUrl)) {
            if (depth <= 1) coverage.add("sitemap-depth-limit");
            else queue.push({ url: nestedUrl, depth: depth - 1 });
          }
        }
      }),
    );
  }
  if (queue.some(({ url }) => !seenSitemapDocs.has(url))) {
    if (allUrls.size >= maxDiscoveredUrls) coverage.add("sitemap-url-limit");
    if (fetchedDocs >= MAX_SITEMAP_DOCS) coverage.add("sitemap-document-limit");
  }

  if (failedDocs > 0) {
    console.warn(
      `Sitemap discovery completed with partial failures for ${origin}: fetched=${fetchedDocs}, failed=${failedDocs}, timedOut=${timedOutDocs}, discoveredUrls=${allUrls.size}`,
    );
  }

  // Every discovered URL is returned, not just the first maxPages. Seeding is
  // also what records each page's in-sitemap flag on the frontier, so
  // truncating here made every sitemap URL past the budget report
  // inSitemap: false once the crawl reached it through a link. The set is
  // already bounded by maxDiscoveredUrls, seeds go straight into the
  // scratchpad DO rather than through durable step state, and the crawl still
  // stops at maxPages.
  return {
    urls: Array.from(allUrls),
    robotsText,
    coverage: sort([...coverage], (a, b) => a.localeCompare(b)),
  };
}
