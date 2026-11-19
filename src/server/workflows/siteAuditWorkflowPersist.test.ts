import { Buffer } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import type { AuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import { parseRobotsTxt } from "@/server/lib/audit/discovery";
import { MAX_HTML_BYTES } from "@/server/lib/audit/html-response";
import type { CrawledPageResult } from "@/server/lib/audit/types";
import { crawlPage } from "@/server/workflows/site-audit-workflow-helpers";
import { persistCrawledPages } from "@/server/workflows/siteAuditWorkflowPersist";

const { recordBatch } = vi.hoisted(() => ({
  recordBatch: vi.fn<AuditScratchpad["recordBatch"]>().mockResolvedValue({
    attempted: 1,
    pending: 0,
    seen: 1,
  }),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/audit/AuditScratchpad", () => ({
  getAuditScratchpad: () => ({ recordBatch }),
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    insertCrawledBatch: vi.fn(),
    updateAuditProgress: vi.fn(),
  },
}));
vi.mock("@/server/lib/audit/progress-kv", () => ({
  AuditProgressKV: { pushCrawledUrls: vi.fn() },
}));
vi.mock("@/server/lib/r2", () => ({ putTextToR2: vi.fn() }));

const ORIGIN = "https://example.com";
const START = `${ORIGIN}/`;

afterEach(() => vi.restoreAllMocks());

function anchorList(count: number, href: (n: number) => string): string {
  return Array.from(
    { length: count },
    (_, i) => `<a href="${href(i + 1)}">Link</a>`,
  ).join("");
}

async function crawlHtml(
  url: string,
  html: string,
  status = 200,
): Promise<CrawledPageResult> {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(html, { status, headers: { "content-type": "text/html" } }),
  );
  const throttle = createCrawlThrottle(Date.now() + 10_000);
  const page = await crawlPage(url, 0, false, throttle);
  if (!page) throw new Error("Fixture did not crawl");
  return page;
}

async function persist(pages: CrawledPageResult[], robotsText = "") {
  await persistCrawledPages({
    auditId: "audit",
    workflowInstanceId: "workflow",
    origin: ORIGIN,
    robots: parseRobotsTxt(ORIGIN, robotsText),
    sitePlatform: undefined,
    scratchpad: getAuditScratchpad("audit"),
    pages,
    depthByUrl: new Map(pages.map((page) => [page.url, 0])),
    maxPages: 1_500,
  });
}

it("keeps provisional depth out of stored pages and findings", async () => {
  const page = await crawlHtml(
    START,
    '<a rel="nofollow" href="/next">Next</a>',
  );
  page.crawlDepth = 8;
  await persist([page]);
  const [, stored, issues] = vi.mocked(AuditRepository.insertCrawledBatch).mock
    .lastCall!;
  expect(stored[0].crawlDepth).toBeNull();
  expect(issues.map((issue) => issue.issueType)).not.toContain("deep-page");
  expect(recordBatch.mock.lastCall?.[0].links[0]).toMatchObject({
    isHtml: true,
    targets: [`${ORIGIN}/next`],
  });
});

it("records a same-origin robots-excluded anchor as a navigation gap without leasing it", async () => {
  const page = await crawlHtml(START, '<a href="/shortcut">Shortcut</a>');
  await persist([page], "User-agent: *\nDisallow: /shortcut");
  const batch = recordBatch.mock.lastCall?.[0];
  expect(batch?.links[0]).toMatchObject({
    targets: [`${ORIGIN}/shortcut`],
    unqueuedFrom: 0,
  });
  expect(batch?.discovered).toEqual([]);
});

it("passes normalized URLs at positions 500, 501 and 517 to the link graph", async () => {
  const html = anchorList(
    517,
    (n) => `/target/${n}?b=2&amp;utm_source=menu&amp;a=1#top`,
  );
  await persist([await crawlHtml(START, html)]);
  const row = recordBatch.mock.lastCall?.[0].links[0];
  expect(row?.targets).toHaveLength(517);
  for (const n of [500, 501, 517]) {
    expect(row?.targets[n - 1]).toBe(`${ORIGIN}/target/${n}?a=1&b=2`);
  }
  expect(row?.incomplete).toBe(false);
});

it("keeps all long URLs that fit and marks genuine graph overflow", async () => {
  const fit = anchorList(500, (n) => `/target/${n}?q=${"a".repeat(800)}`);
  const near = await crawlHtml(START, fit);
  // A short relative link expands to a long absolute URL after normalization.
  const oversized = await crawlHtml(
    `${START}${"a".repeat(1_200)}/`,
    anchorList(1_000, (n) => `target/${n}`),
  );
  await persist([near, oversized]);
  const batch = recordBatch.mock.lastCall?.[0];
  expect(batch?.links[0]?.incomplete).toBe(false);
  expect(batch?.links[0]?.targets).toHaveLength(500);
  expect(batch?.discovered).toHaveLength(1_500);
  const row = batch?.links[1];
  expect(row?.incomplete).toBe(true);
  expect(row?.targets.length).toBeLessThan(1_000);
  expect(row?.targets.length).toBeGreaterThan(500);
});

it("splits large discovery and graph payloads without losing or reordering targets", async () => {
  const html = anchorList(800, (n) => `target/${n}`);
  const pages: CrawledPageResult[] = [];
  for (let n = 0; n < 25; n += 1) {
    pages.push(await crawlHtml(`${START}${"a".repeat(1_750)}/${n}/`, html));
  }
  await persist(pages);
  const parts = recordBatch.mock.calls.map(([batch]) => batch);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(
      24 * 1024 * 1024,
    );
    expect(part.discovered).toEqual(
      pages
        .filter((page) => part.crawledUrls.includes(page.url))
        .flatMap((page) =>
          page.links.map((link) => ({ url: link.targetUrl, depth: 1 })),
        ),
    );
  }
  const discovered = parts.flatMap((part) =>
    part.discovered.map(({ url }) => url),
  );
  expect(discovered).toEqual(
    pages.flatMap((page) => page.links.map((link) => link.targetUrl)),
  );
  expect(parts.flatMap((part) => part.crawledUrls)).toEqual(
    pages.map((page) => page.url),
  );
});

it("keeps blocked pages unknown and lets a confirmed 404 remain a broken target", async () => {
  const blocked = await crawlHtml(START, "Access restricted", 403);
  const gone = await crawlHtml(`${START}gone`, "Gone", 404);
  await persist([blocked, gone]);
  expect(
    recordBatch.mock.lastCall?.[0].links.map(({ incomplete }) => incomplete),
  ).toEqual([true, false]);
});

it("marks the graph incomplete when a direct HTML fetch reaches its byte cap", async () => {
  const html = `<a href="/known">Known</a><p>${"x".repeat(MAX_HTML_BYTES)}</p><a href="/missed">Missed</a>`;
  await persist([await crawlHtml(START, html)]);
  expect(recordBatch.mock.lastCall?.[0].links[0]).toMatchObject({
    targets: [`${ORIGIN}/known`],
    incomplete: true,
  });
});
