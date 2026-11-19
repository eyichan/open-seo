import { z } from "zod";
import type {
  BrowserRun,
  Response as BrowserResponse,
} from "@cloudflare/workers-types";
import {
  CLOUDFLARE_RENDER_TIMEOUT_MS,
  type RenderUsage,
} from "@/shared/audit-rendering";
import { classifyFetch } from "./classify-fetch";
import { MAX_HTML_BYTES, readTextUpTo, truncateText } from "./html-response";
import { isCrawlableUrl } from "./url-policy";
import { normalizeUrl } from "./url-utils";

type RenderOptions = {
  // Either renderer may be missing: Docker has no browser binding, and the
  // Context key is optional on self-hosted Cloudflare deployments.
  browser?: Pick<BrowserRun, "quickAction">;
  // Reaches Context.dev authenticated (provider-access.ts).
  contextFetch?: typeof fetch | null;
  /** Logged with each attempt; reads outside an audit have none. */
  auditId?: string;
  // Counts every provider attempt, including rejected ones: both providers
  // bill a request whether or not the HTML turned out to be usable.
  usage: RenderUsage;
};

const cloudflareSchema = z.object({
  success: z.literal(true),
  result: z.string(),
  meta: z.object({
    status: z.number().int(),
    finalUrl: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});
// Context includes key_metadata on every authenticated response, error or not.
const usageSchema = z.object({
  key_metadata: z
    .object({ credits_consumed: z.number().nonnegative().optional() })
    .optional(),
});
const contextSchema = z.object({
  success: z.literal(true),
  type: z.literal("html"),
  html: z.string(),
  metadata: z.object({ finalUrl: z.string().url() }),
  finalDOMState: z.literal("loaded"),
});

// JSON escaping can expand an HTML byte up to sixfold. Bound the transport
// before JSON.parse as well as the decoded HTML before it reaches the parser.
// A body cut off at the bound is incomplete JSON, so parsing rejects it.
const MAX_RESPONSE_BYTES = 8 * MAX_HTML_BYTES;
const CLOUDFLARE_SETTLE_MS = 2_000;
async function readProviderJson(
  response: Response | BrowserResponse,
): Promise<unknown> {
  return JSON.parse(await readTextUpTo(response, MAX_RESPONSE_BYTES));
}

/**
 * The rendered HTML to analyze: the same first 1 MiB the direct crawl keeps,
 * which still holds the metadata and navigation the audit reads.
 */
function usableHtml(url: string, finalUrl: string, html: string) {
  // The existing direct fetch records redirects one hop at a time. A browser
  // must not silently substitute another URL's content into this page row.
  if (normalizeUrl(finalUrl, url) !== normalizeUrl(url, url)) {
    throw new Error("Rendering returned a different URL");
  }
  if (!html.trim()) throw new Error("Rendered HTML is empty");
  const { text, capped } = truncateText(html, MAX_HTML_BYTES);
  return capped ? { html: text, htmlCapped: true } : { html: text };
}

/** The rendered HTML, with the origin's status when the renderer reports it. */
export type RenderedPage = {
  html: string;
  status: number | null;
  htmlCapped?: boolean;
};

/** Null when Cloudflare failed, was blocked, or saw an origin error. */
async function renderWithCloudflare(
  url: string,
  browser: Pick<BrowserRun, "quickAction">,
): Promise<RenderedPage | null> {
  try {
    const response = await browser.quickAction("content", {
      url,
      cacheTTL: 0,
      // Background requests can keep the network busy after the DOM is ready.
      // Give async scripts time to render within the existing attempt budget.
      gotoOptions: {
        waitUntil: "domcontentloaded",
        timeout: CLOUDFLARE_RENDER_TIMEOUT_MS - CLOUDFLARE_SETTLE_MS,
      },
      waitForTimeout: CLOUDFLARE_SETTLE_MS,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = cloudflareSchema.parse(await readProviderJson(response));
    const { status, finalUrl, headers } = data.meta;
    const rendered = usableHtml(url, finalUrl, data.result);
    const mitigated = Object.entries(headers ?? {}).some(
      ([name, value]) =>
        name.toLowerCase() === "cf-mitigated" && Boolean(value.trim()),
    );
    if (
      status >= 400 ||
      classifyFetch(status, mitigated, rendered.html.slice(0, 4_000)) !== "ok"
    ) {
      return null;
    }
    return { ...rendered, status };
  } catch {
    // Provider bodies/errors can contain page data. Nothing raw is logged.
    return null;
  }
}

async function renderWithContext(
  url: string,
  contextFetch: typeof fetch,
): Promise<{
  rendered: Omit<RenderedPage, "status"> | null;
  credits: number;
  httpStatus: number | null;
}> {
  const endpoint = new URL("https://api.context.dev/v1/web/scrape/html");
  endpoint.search = new URLSearchParams({
    url,
    maxAgeMs: "0",
    useMainContentOnly: "false",
    waitForMs: "1000",
    "pdf[shouldParse]": "false",
    "timeoutOpts[milliseconds]": "30000",
    "timeoutOpts[behavior]": "fail",
  }).toString();

  let rendered: Omit<RenderedPage, "status"> | null = null;
  let creditsUsed: number | null = null;
  let httpStatus: number | null = null;
  try {
    const response = await contextFetch(endpoint, {
      signal: AbortSignal.timeout(35_000),
    });
    httpStatus = response.status;
    const json = await readProviderJson(response);
    // Usage first: a rejected or partial document still cost a credit.
    const usage = usageSchema.safeParse(json);
    creditsUsed = usage.success
      ? (usage.data.key_metadata?.credits_consumed ?? null)
      : null;
    if (!response.ok) throw new Error(`Rendering provider HTTP ${httpStatus}`);
    const data = contextSchema.parse(json);
    rendered = usableHtml(url, data.metadata.finalUrl, data.html);
  } catch {
    // Provider bodies/errors can contain page data or credentials. Nothing
    // raw is logged, and a paid call is never retried automatically.
  }
  // Context charges one credit per scrape. Bill what it reports; only assume
  // one credit for a usable page that omits its usage, never for a failure.
  return { rendered, credits: creditsUsed ?? (rendered ? 1 : 0), httpStatus };
}

/**
 * Cloudflare Browser Run first, because it costs a fraction of Context. Context
 * renders only the pages Cloudflare could not: a failure, a bot challenge, or
 * an origin error.
 */
async function renderPage(
  url: string,
  options: RenderOptions,
): Promise<RenderedPage> {
  if (!isCrawlableUrl(url) || new URL(url).username || new URL(url).password) {
    throw new Error("Invalid rendering target");
  }

  if (options.browser) {
    const page = await renderWithCloudflare(url, options.browser);
    options.usage.cloudflareAttempts += 1;
    console.info("site_audit:render", {
      auditId: options.auditId,
      provider: "cloudflare",
      outcome: page ? "ok" : "fallback",
    });
    if (page) return page;
  }

  if (options.contextFetch) {
    const { rendered, credits, httpStatus } = await renderWithContext(
      url,
      options.contextFetch,
    );
    options.usage.contextCredits += credits;
    console.info("site_audit:render", {
      auditId: options.auditId,
      provider: "context",
      httpStatus,
      creditsUsed: credits,
      outcome: rendered ? "ok" : "error",
    });
    // Context reports no origin status.
    if (rendered) return { ...rendered, status: null };
  }
  throw new Error("Unable to render this page");
}

export const RenderedPageService = { renderPage } as const;
