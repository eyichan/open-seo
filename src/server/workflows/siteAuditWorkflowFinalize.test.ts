import { expect, it, vi } from "vitest";
import { finalizeAudit } from "./siteAuditWorkflowFinalize";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
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
  auditId: "audit-1",
  workflowInstanceId: "workflow-1",
  billingCustomer: {
    userId: "user-1",
    userEmail: "test@example.com",
    organizationId: "org-1",
  },
  projectId: "project-1",
  startUrl: "https://example.com/",
  config: { maxPages: 50, lighthouseStrategy: "auto" as const },
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
  vi.mocked(getAuditScratchpad).mockReturnValue({
    advanceNavigation: vi.fn().mockResolvedValue(true),
    readNavigationCoverage: vi.fn().mockResolvedValue({
      method: "captured-navigation-v1",
      firstIncompleteDepth: null,
      cohortKnownPages: 4,
      segmentKnownPages: 3,
      knownPagesWithUnknownHtmlEligibility: 0,
    }),
    readNavigationRows,
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
    discovery: { seededCount: 4, robotsText: "" },
  };
  await expect(finalizeAudit(input)).rejects.toThrow("retryable write");
  expect(stored).toEqual(new Set([`${host}deep`]));
  await finalizeAudit(input);
  expect(stored).toEqual(new Set([`${host}deep`, `${host}prior`]));
  expect(AuditRepository.clearDepthIssues).toHaveBeenCalledOnce();
  expect(AuditRepository.savePageDepths).toHaveBeenLastCalledWith(
    "audit-1",
    rows.slice(1, 3),
  );
  expect(AuditRepository.insertIssues).toHaveBeenNthCalledWith(1, "audit-1", [
    {
      issueType: "deep-page",
      pageId: "deep",
      pageUrl: `${host}deep`,
      details: { crawlDepth: 5 },
    },
  ]);
  expect(AuditRepository.insertIssues).toHaveBeenNthCalledWith(3, "audit-1", [
    {
      issueType: "deep-page",
      pageId: null,
      pageUrl: `${host}prior`,
      details: { crawlDepth: 7 },
    },
  ]);
  expect(readNavigationRows.mock.calls.map(([cursor]) => cursor)).toEqual([
    0, 1, 1, 4,
  ]);
  expect(AuditRepository.savePageDepths).toHaveBeenCalledBefore(
    vi.mocked(AuditRepository.completeAudit),
  );
});
