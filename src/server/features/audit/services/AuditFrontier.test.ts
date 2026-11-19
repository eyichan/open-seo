import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRow } from "./AuditFrontier";

const { blobs, legacyIssue, legacyVisited } = vi.hoisted(() => ({
  blobs: new Map<string, string>(),
  legacyIssue: vi.fn(),
  legacyVisited: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    constructor(protected ctx: DurableObjectState) {}
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getPageLimitIssue: legacyIssue,
    readLegacyVisited: legacyVisited,
  },
}));
vi.mock("@/server/lib/r2", () => ({
  getJsonFromR2: (key: string) => {
    const data = blobs.get(key);
    if (data === undefined) throw new Error("Audit payload not found");
    return Promise.resolve(data);
  },
  getOptionalJsonFromR2: (key: string) =>
    Promise.resolve(blobs.get(key) ?? null),
  putTextToR2: (key: string, body: string) =>
    Promise.resolve(blobs.set(key, body)),
}));

import { AuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import {
  getAuditFrontier,
  readFrontierPart,
  restoreAuditFrontier,
  saveAuditFrontier,
} from "./AuditFrontier";

const projectId = "4de2a713-7246-494a-b37b-67f616156e8c";
const auditId = "c3bd8596-7bf4-43b0-b7cd-9ac69d6ad912";
const url = "https://example.com/";
const pending = url + "late";
const discovered = url + "new";
const waitingPart = `site-audit/${projectId}/${auditId}/frontier/v1/1.json`;
const visitedPart = `site-audit/${projectId}/${auditId}/frontier/v2/visited/1.json`;

function audit(legacy = false): AuditRow {
  return {
    id: auditId,
    workflowInstanceId: auditId,
    errorCode: null,
    projectId,
    status: "completed",
    startUrl: url,
    pagesCrawled: 1,
    config: JSON.stringify({
      maxPages: 10,
      lighthouseStrategy: "none",
      coverageVersion: legacy ? undefined : 2,
    }),
  };
}

function scratchpad() {
  // Execute the real RPC methods and SQLite against a thin storage shim.
  const db = new DatabaseSync(":memory:");
  const storage = {
    getAlarm: () => Promise.resolve(1),
    sql: {
      databaseSize: 0,
      exec: (query: string, ...params: SQLInputValue[]) => {
        if (!params.length && query.includes("CREATE TABLE")) {
          db.exec(query);
          return {};
        }
        const statement = db.prepare(query);
        if (!statement.columns().length) {
          statement.run(...params);
          return {};
        }
        const rows = statement.all(...params);
        return { one: () => rows[0], toArray: () => rows };
      },
    },
    transactionSync: (fn: () => unknown) => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const ctx = { storage, blockConcurrencyWhile: (fn: () => unknown) => fn() };
  // The test supplies only the DO storage methods used by the production checkpoint.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return new AuditScratchpad(ctx as unknown as DurableObjectState, {} as Env);
}

async function record(
  scratch: AuditScratchpad,
  pageId: string,
  pageUrl: string,
  targets: string[],
  statusCode = 200,
) {
  await scratch.recordBatch({
    crawledUrls: [pageUrl],
    pages: [
      { pageId, url: pageUrl, statusCode, fetchClass: "ok", redirectUrl: null },
    ],
    links: [{ pageId, url: pageUrl, targets, incomplete: false }],
    discovered: targets.map((target) => ({ url: target, depth: 1 })),
  });
}

async function cappedAudit() {
  const scratch = scratchpad();
  await scratch.seedStart(url);
  await scratch.claimChunk(1, 1, 1);
  await record(scratch, "old-page", url, [pending]);
  await saveAuditFrontier({
    auditId,
    projectId,
    startUrl: url,
    parentAuditId: null,
    cohortId: auditId,
    segmentPages: 1,
    pendingCount: 1,
    cumulativeVisited: 1,
    unreadPages: 0,
    graphComplete: true,
    discoveryGaps: [],
    robotsText: null,
    stop: "crawl-page-limit",
    scratchpad: scratch,
  });
  const parent = audit();
  const frontier = await getAuditFrontier(parent);
  if (!frontier) throw new Error("Expected a saved archive");
  return { parent, frontier };
}

beforeEach(() => {
  blobs.clear();
  legacyIssue.mockResolvedValue(null);
  legacyVisited.mockResolvedValue([]);
});

describe("audit checkpoint", () => {
  it("reports an unavailable audit start when no matching page reached the graph", async () => {
    const scratch = scratchpad();
    const start = `${url}short-path-secret?verification=hidden`;
    await scratch.advanceNavigation(start);
    expect(await scratch.readNavigationCoverage(start)).toMatchObject({
      firstIncompleteDepth: 0,
      firstIncomplete: {
        affectedSources: 0,
        samples: [
          {
            sourcePageId: null,
            target: `${url}…?…`,
            reason: "start-unavailable",
          },
        ],
      },
    });
  });

  it("restores a finite queue without reclaiming prior URLs and checks links across segments", async () => {
    const { parent, frontier } = await cappedAudit();
    const child = scratchpad();
    await restoreAuditFrontier(parent, frontier, child, () => true);
    await restoreAuditFrontier(parent, frontier, child, () => true);
    expect(
      (await child.claimChunk(1, 2, 2)).urls.map((row) => row.url),
    ).toEqual([pending]);
    await record(child, "late-page", pending, [url, discovered], 404);
    expect(
      (await child.claimChunk(2, 1, 1)).urls.map((row) => row.url),
    ).toEqual([discovered]);
    await record(child, "new-page", discovered, []);
    expect(await child.getCoverage()).toMatchObject({
      attempted: 2,
      visited: 3,
      pending: 0,
      seen: 3,
      unread: 0,
      incomplete: 0,
    });
    const findings = await child.runFinalizeChecks({
      startUrl: url,
      crawlCompleted: true,
      hasPriorPages: true,
    });
    expect(findings.brokenLinks).toEqual([
      {
        sourcePageId: "old-page",
        sourceUrl: url,
        targetUrl: pending,
        targetStatus: 404,
        previous: true,
      },
    ]);
    expect(findings.orphanPages).toEqual([]);
  });

  it("fails closed when a part disappears or contains the wrong data", async () => {
    const { parent, frontier } = await cappedAudit();
    const visited = blobs.get(visitedPart);
    blobs.delete(visitedPart);
    await expect(
      restoreAuditFrontier(parent, frontier, scratchpad(), () => true),
    ).rejects.toThrow("not found");
    blobs.set(visitedPart, visited ?? "");
    blobs.set(waitingPart, "[]");
    await expect(readFrontierPart(parent, frontier, 1)).rejects.toThrow(
      "integrity checks",
    );
  });

  it("restores legacy page observations while recording the unavailable link graph and discovery", async () => {
    legacyIssue.mockResolvedValue({
      detailsJson: '{"pagesCrawled":1,"urlsNotCrawled":1,"frontierParts":1}',
    });
    legacyVisited.mockResolvedValue([
      {
        url,
        pageId: "old-page",
        depth: 0,
        inSitemap: false,
        statusCode: 200,
        fetchClass: "ok",
        redirectUrl: null,
      },
    ]);
    blobs.set(
      waitingPart,
      JSON.stringify([
        { url: pending, depth: 1, source: "link", inSitemap: false },
      ]),
    );
    const parent = audit(true);
    const frontier = await getAuditFrontier(parent);
    if (!frontier) throw new Error("Expected a saved legacy archive");
    expect(frontier).toMatchObject({
      version: 1,
      graphComplete: false,
      discoveryGaps: [
        "legacy-discovery-unknown",
        "legacy-link-graph-unavailable",
      ],
    });
    const child = scratchpad();
    await restoreAuditFrontier(parent, frontier, child, () => true);
    expect(await child.getCoverage()).toMatchObject({
      visited: 1,
      pending: 1,
      incomplete: 1,
    });
  });
});
