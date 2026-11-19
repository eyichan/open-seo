import { expect, it, vi } from "vitest";
import { finalizeAudit } from "./siteAuditWorkflowFinalize";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import { putTextToR2 } from "@/server/lib/r2";
const pgStepMock = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    clearDepthIssues: vi.fn(),
    savePageDepths: vi.fn(),
    insertIssues: vi.fn(),
    updateAuditProgress: vi.fn(),
    countPagesByFetchClass: vi.fn(),
    hasPagesForAudit: vi.fn().mockResolvedValue(true),
    completeAudit: vi.fn(),
  },
}));
vi.mock("@/server/features/audit/AuditScratchpad", () => ({
  getAuditScratchpad: vi.fn(),
}));
vi.mock("@/server/lib/audit/issues/multipage", () => ({
  runMultipageChecks: vi.fn(),
}));
vi.mock("@/server/lib/audit/progress-kv", () => ({
  AuditProgressKV: { clear: vi.fn() },
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/server/lib/r2", () => ({ putTextToR2: vi.fn() }));
vi.mock("@/server/workflows/pgStep", () => ({ pgStep: pgStepMock }));

const PHASE_PARAMS = {
  auditId: "2fff40f3-bc1d-41f5-964a-c013ec5fd307",
  workflowInstanceId: "workflow-1",
  billingCustomer: {
    userId: "user-1",
    userEmail: "test@example.com",
    organizationId: "org-1",
  },
  projectId: "c19150a1-ad02-4aeb-8ca6-df382f4020e7",
  startUrl: "https://example.com/",
  config: {
    maxPages: 50,
    lighthouseStrategy: "auto" as const,
    coverageVersion: 2 as const,
  },
};

it("replays final depth writes with current page IDs and cohort-only prior findings", async () => {
  const host = PHASE_PARAMS.startUrl;
  const rows = [
    {
      cursor: 1,
      id: "deep",
      url: `${host}deep`,
      crawlDepth: 5,
      current: 1,
      html: 1,
    },
    {
      cursor: 2,
      id: "short",
      url: `${host}short`,
      crawlDepth: 1,
      current: 1,
      html: 1,
    },
    {
      cursor: 3,
      id: "pdf",
      url: `${host}pdf`,
      crawlDepth: 6,
      current: 1,
      html: 0,
    },
    {
      cursor: 4,
      id: "prior",
      url: `${host}prior`,
      crawlDepth: 7,
      current: 0,
      html: 1,
    },
  ];
  const readNavigationRows = vi.fn((cursor: number) => {
    if (cursor === 0) return rows.slice(0, 1);
    return cursor === 1 ? rows.slice(1) : [];
  });
  const firstIncomplete = {
    affectedSources: 1,
    samples: [
      {
        source: `${host}…`,
        sourcePageId: "prior",
        target: `${host}…?…`,
        reason: "robots-excluded",
      },
    ],
  };
  const incompleteCapture = {
    affectedPages: 1,
    samples: [
      { source: `${host}…`, sourcePageId: "pdf", reason: "html-byte-limit" },
    ],
  };
  const destroy = vi.fn();
  vi.mocked(getAuditScratchpad).mockReturnValue({
    advanceNavigation: vi.fn().mockResolvedValue(true),
    getCoverage: vi.fn().mockResolvedValue({
      attempted: 3,
      seen: 4,
      pending: 0,
      visited: 4,
      unread: 0,
      incomplete: 1,
      incompleteCapture,
    }),
    readNavigationCoverage: vi.fn().mockResolvedValue({
      method: "captured-navigation-v1",
      firstIncompleteDepth: 7,
      cohortKnownPages: 4,
      segmentKnownPages: 3,
      knownPagesWithUnknownHtmlEligibility: 0,
      firstIncomplete,
    }),
    readNavigationRows,
    runFinalizeChecks: vi
      .fn()
      .mockResolvedValue({ brokenLinks: [], orphanPages: [] }),
    destroy,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  } as unknown as ReturnType<typeof getAuditScratchpad>);
  vi.mocked(runMultipageChecks).mockResolvedValue({
    issues: [],
    hasUnreadShells: false,
  });
  const stored = new Set<string>();
  let failPriorOnce = true;
  vi.mocked(AuditRepository.clearDepthIssues).mockImplementation(async () => {
    stored.clear();
  });
  vi.mocked(AuditRepository.insertIssues).mockImplementation(
    async (_id, issues) => {
      if (
        failPriorOnce &&
        issues.some((issue) => issue.pageUrl === `${host}prior`)
      ) {
        failPriorOnce = false;
        throw new Error("retryable write");
      }
      for (const issue of issues) stored.add(issue.pageUrl);
    },
  );
  // A replay receives the outputs of successful Workflow steps without
  // executing their bodies, including the cleanup and first write batch.
  const completed = new Map<string, unknown>();
  pgStepMock.mockImplementation(
    async (
      _step: unknown,
      name: string,
      _config: unknown,
      callback: () => Promise<unknown>,
    ) => {
      if (completed.has(name)) return completed.get(name);
      const result = await callback();
      completed.set(name, result);
      return result;
    },
  );
  const input = {
    ...PHASE_PARAMS,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    step: {} as never,
    crawl: { pagesCrawled: 3, completed: true },
    discovery: {
      seededCount: 4,
      robotsText: "",
      previouslyVisited: 1,
      coverage: [],
    },
  };
  await expect(finalizeAudit(input)).rejects.toThrow("retryable write");
  expect(stored).toEqual(new Set([`${host}deep`]));
  await finalizeAudit(input);
  expect(stored).toEqual(new Set([`${host}deep`, `${host}prior`]));
  expect(AuditRepository.clearDepthIssues).toHaveBeenCalledOnce();
  expect(AuditRepository.savePageDepths).toHaveBeenLastCalledWith(
    PHASE_PARAMS.auditId,
    rows.slice(1, 3),
  );
  expect(AuditRepository.insertIssues).toHaveBeenNthCalledWith(
    1,
    PHASE_PARAMS.auditId,
    [
      {
        issueType: "deep-page",
        pageId: "deep",
        pageUrl: `${host}deep`,
        details: { crawlDepth: 5 },
      },
    ],
  );
  expect(AuditRepository.insertIssues).toHaveBeenNthCalledWith(
    3,
    PHASE_PARAMS.auditId,
    [
      {
        issueType: "deep-page",
        pageId: null,
        pageUrl: `${host}prior`,
        details: { crawlDepth: 7 },
      },
    ],
  );
  expect(readNavigationRows.mock.calls.map(([cursor]) => cursor)).toEqual([
    0, 1, 1, 4,
  ]);
  expect(AuditRepository.savePageDepths).toHaveBeenCalledBefore(
    vi.mocked(AuditRepository.completeAudit),
  );
  expect(putTextToR2).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(putTextToR2).mock.lastCall![1])).toMatchObject({
    graphComplete: false,
    depthCoverage: {
      firstIncompleteDepth: 7,
      firstIncomplete,
      incompleteCapture,
    },
  });
  expect(putTextToR2).toHaveBeenCalledBefore(destroy);
});

it("archives the robots-excluded start without attributing it to a fetched source", async () => {
  pgStepMock.mockImplementation(
    async (_step, _name, _config, run: () => Promise<unknown>) => run(),
  );
  vi.mocked(getAuditScratchpad).mockReturnValue({
    advanceNavigation: vi.fn().mockResolvedValue(true),
    getCoverage: vi
      .fn()
      .mockResolvedValue({
        attempted: 0,
        seen: 0,
        pending: 0,
        visited: 0,
        unread: 0,
        incomplete: 0,
      }),
    readNavigationCoverage: vi.fn().mockResolvedValue({
      method: "captured-navigation-v1",
      firstIncompleteDepth: 0,
      cohortKnownPages: 0,
      segmentKnownPages: 0,
      knownPagesWithUnknownHtmlEligibility: 0,
      firstIncomplete: {
        affectedSources: 0,
        samples: [
          {
            source: null,
            sourcePageId: null,
            reason: "start-unavailable",
            target: PHASE_PARAMS.startUrl,
          },
        ],
      },
    }),
    readNavigationRows: vi.fn().mockResolvedValue([]),
    runFinalizeChecks: vi
      .fn()
      .mockResolvedValue({ brokenLinks: [], orphanPages: [] }),
    destroy: vi.fn(),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  } as unknown as ReturnType<typeof getAuditScratchpad>);
  vi.mocked(runMultipageChecks).mockResolvedValue({
    issues: [],
    hasUnreadShells: false,
  });
  await finalizeAudit({
    ...PHASE_PARAMS,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    step: {} as never,
    crawl: { pagesCrawled: 0, completed: true },
    discovery: {
      seededCount: 0,
      robotsText: "User-agent: *\nDisallow: /",
      coverage: [],
    },
  });
  expect(JSON.parse(vi.mocked(putTextToR2).mock.lastCall![1])).toMatchObject({
    depthCoverage: {
      firstIncompleteDepth: 0,
      firstIncomplete: {
        affectedSources: 0,
        samples: [
          {
            source: null,
            sourcePageId: null,
            reason: "robots-excluded",
            target: PHASE_PARAMS.startUrl,
          },
        ],
      },
    },
  });
});
