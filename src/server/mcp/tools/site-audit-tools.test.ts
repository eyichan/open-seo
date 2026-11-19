/* eslint-disable max-lines -- site-audit tool cases share the project and workflow fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  hasPaidPlanMock,
  workflowCreateMock,
  captureEventMock,
  latestAuditMock,
  issueGroupsMock,
  listIssuesMock,
  lighthouseResultsMock,
  projectAccessMock,
  projectAuditMock,
  reserveAuditMock,
  claimLaunchMock,
  getWorkflowMock,
  frontierManifestMock,
} = vi.hoisted(() => ({
  hasPaidPlanMock: vi.fn(),
  workflowCreateMock:
    vi.fn<
      (options: { params: { config: { maxPages: number } } }) => Promise<void>
    >(),
  captureEventMock:
    vi.fn<(event: { properties: Record<string, unknown> }) => Promise<void>>(),
  latestAuditMock: vi.fn(),
  issueGroupsMock: vi.fn(),
  listIssuesMock: vi.fn(),
  lighthouseResultsMock: vi.fn(),
  projectAccessMock: vi.fn(),
  projectAuditMock: vi.fn(),
  reserveAuditMock: vi.fn(),
  claimLaunchMock: vi.fn(),
  getWorkflowMock: vi.fn(),
  frontierManifestMock: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    SITE_AUDIT_WORKFLOW: { create: workflowCreateMock, get: getWorkflowMock },
  },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn().mockResolvedValue(true),
  getOptionalEnvValue: vi.fn(),
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: captureEventMock,
}));
vi.mock("@/server/email/onboarding-drip", () => ({
  markOnboardingMilestone: vi.fn(),
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasPaidPlan: hasPaidPlanMock,
  getOrCreateOrganizationCustomer: vi.fn(),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: projectAccessMock,
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    createAudit: reserveAuditMock,
    getAuditUsageForOrganization: vi
      .fn()
      .mockResolvedValue({ runningCount: 1, capacityUnits: 0 }),
    getLatestAuditForProject: latestAuditMock,
    getAuditForProject: projectAuditMock,
    countRunningForProject: vi.fn().mockResolvedValue(1),
    claimContinuationLaunch: claimLaunchMock,
    getPageLimitIssue: vi.fn().mockResolvedValue({
      detailsJson: '{"pagesCrawled":10,"urlsNotCrawled":2,"frontierParts":1}',
    }),
  },
}));
vi.mock("@/server/features/audit/repositories/auditResultsQueries", () => ({
  getAuditIssueGroups: issueGroupsMock,
  listAuditIssues: listIssuesMock,
  listAuditLighthouseResults: lighthouseResultsMock,
  listAuditPages: vi.fn(),
}));
// A stored report is named by its key, so a test can tell which one was read.
vi.mock("@/server/lib/r2", () => ({
  getJsonFromR2: async (key: string) => key,
  getOptionalJsonFromR2: frontierManifestMock,
}));
vi.mock("@/server/lib/lighthousePayload", () => ({
  readStoredLighthousePayload: (report: string) => ({
    report: {
      hasIssueDetails: true,
      issues: [
        {
          severity: "critical",
          title: `Issue in ${report}`,
          category: "performance",
          items: [],
        },
      ],
    },
  }),
}));
vi.mock(
  "@/server/features/audit/repositories/CrawlerCredentialRepository",
  () => ({
    CrawlerCredentialRepository: {
      findForOrganizationAndHost: vi.fn().mockResolvedValue([]),
    },
  }),
);
vi.mock("@/server/features/audit/AuditScratchpad", () => ({
  getAuditScratchpad: vi.fn(),
}));
vi.mock("@/server/lib/audit/progress-kv", () => ({ AuditProgressKV: {} }));

import {
  getAuditIssuesTool,
  getAuditLighthouseTool,
  runSiteAuditTool,
} from "@/server/mcp/tools/site-audit-tools";
import {
  continueSiteAuditTool,
  getAuditFrontierTool,
} from "./site-audit-frontier-tools";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

function runAudit(maxPages: number) {
  return runSiteAuditTool.handler(
    { projectId: "project-1", url: "https://example.com", maxPages },
    makeToolContext(),
  );
}

beforeEach(() => {
  projectAccessMock.mockResolvedValue({
    id: "project-1",
    domain: "example.com",
  });
  projectAuditMock.mockResolvedValue(null);
  reserveAuditMock.mockResolvedValue(true);
  claimLaunchMock.mockResolvedValue(true);
  frontierManifestMock.mockResolvedValue(null);
});

describe("site audit frontier tools", () => {
  const projectId = "10f6e911-00a1-427f-b48a-cf07d5dbbc23";
  const auditId = "da9cb7ed-2835-4adf-b939-8e8802e6d374";
  const args = { projectId, auditId };
  const ctx = makeToolContext();
  const parent = {
    id: auditId,
    projectId,
    status: "completed",
    startUrl: "https://example.com/",
    pagesCrawled: 10,
    config: '{"maxPages":10,"lighthouseStrategy":"none"}',
  };

  it("reads terminal depth diagnoses through the persisted manifest contract", async () => {
    projectAuditMock.mockResolvedValueOnce({
      ...parent,
      config: '{"maxPages":10,"lighthouseStrategy":"none","coverageVersion":2}',
    });
    const coverage = {
      method: "captured-navigation-v1",
      firstIncompleteDepth: 1,
      cohortKnownPages: 8,
      segmentKnownPages: 8,
      knownPagesWithUnknownHtmlEligibility: 0,
      firstIncomplete: {
        affectedSources: 1,
        samples: [
          {
            source: parent.startUrl,
            sourcePageId: "root",
            target: `${parent.startUrl}?…`,
            reason: "robots-excluded",
          },
        ],
      },
      incompleteCapture: {
        affectedPages: 1,
        samples: [
          {
            source: `${parent.startUrl}…`,
            sourcePageId: "chart",
            reason: "html-byte-limit",
          },
        ],
      },
    };
    frontierManifestMock.mockResolvedValueOnce(
      JSON.stringify({
        version: 2,
        auditId,
        projectId,
        parentAuditId: null,
        startUrl: parent.startUrl,
        cohortId: auditId,
        segmentPages: parent.pagesCrawled,
        cumulativeVisited: parent.pagesCrawled,
        pendingCount: 0,
        unreadPages: 0,
        discoveryGaps: [],
        graphComplete: false,
        depthCoverage: coverage,
        stop: "exhausted",
        robotsText: null,
        pendingParts: [],
        visitedParts: [],
      }),
    );
    const result = await getAuditFrontierTool.handler(args, ctx);
    expect(result.structuredContent).toMatchObject({
      coverage: { depthCoverage: coverage },
    });
  });

  it("rejects another tenant before audit lookup and rejects an audit outside the authorized project", async () => {
    projectAccessMock.mockResolvedValueOnce(null);
    await expect(getAuditFrontierTool.handler(args, ctx)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    expect(projectAuditMock).not.toHaveBeenCalled();
    await expect(getAuditFrontierTool.handler(args, ctx)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(projectAuditMock).toHaveBeenCalledWith(auditId, projectId);
  });

  it("dispatches a successor once, and a replay reads the already observed instance", async () => {
    let successor: {
      id: string;
      config: string;
      status: string;
      workflowInstanceId: string | null;
    } | null = null;
    projectAuditMock.mockImplementation(async (id: string) =>
      id === auditId ? parent : successor,
    );
    reserveAuditMock.mockImplementation(
      async (row: { id: string; config: object }) => {
        if (successor) return false;
        successor = {
          id: row.id,
          config: JSON.stringify(row.config),
          status: "running",
          workflowInstanceId: null,
        };
        return true;
      },
    );
    claimLaunchMock.mockImplementation(async (id: string) => {
      if (!successor || successor.workflowInstanceId !== null) return false;
      successor.workflowInstanceId = id;
      return true;
    });
    workflowCreateMock.mockResolvedValue(undefined);
    getWorkflowMock.mockResolvedValue({
      status: async () => ({ status: "running" }),
    });
    const launchArgs = { ...args, maxPages: 10 };
    const [first, replay] = await Promise.all([
      continueSiteAuditTool.handler(launchArgs, ctx),
      continueSiteAuditTool.handler(launchArgs, ctx),
    ]);
    expect(
      [first, replay].some(
        (reply) => reply.structuredContent?.["dispatch"] === "accepted",
      ),
    ).toBe(true);
    expect(workflowCreateMock).toHaveBeenCalledTimes(1);
    await expect(
      continueSiteAuditTool.handler(launchArgs, ctx),
    ).resolves.toMatchObject({
      structuredContent: { dispatch: "accepted" },
    });
    await expect(
      continueSiteAuditTool.handler({ ...launchArgs, maxPages: 11 }, ctx),
    ).resolves.toMatchObject({
      structuredContent: {
        dispatch: "not-sent",
        reason: "VALIDATION_ERROR",
        projectId,
        parentAuditId: auditId,
        maxPages: 11,
      },
    });
    expect(workflowCreateMock).toHaveBeenCalledTimes(1);
  });

  it("recovers only a matching unclaimed reservation and never resends an unknown launch", async () => {
    const reservationId = "45e026b9-a7e9-4ea8-93ac-a1af93106953";
    const reservation = {
      ...parent,
      id: "e1ab2ab3-d319-8f16-86a0-6c3bb49cc79a",
      status: "running",
      workflowInstanceId: null as string | null,
      config: JSON.stringify({
        maxPages: 10,
        lighthouseStrategy: "none",
        continuationFrom: auditId,
        continuationReservation: reservationId,
      }),
    };
    projectAuditMock.mockImplementation(async (id: string) =>
      id === auditId
        ? parent
        : {
            ...reservation,
            id,
          },
    );
    claimLaunchMock.mockImplementation(async (id: string) => {
      if (reservation.workflowInstanceId !== null) return false;
      reservation.workflowInstanceId = id;
      return true;
    });
    workflowCreateMock.mockRejectedValueOnce(
      new Error("Workflow transport lost acknowledgment"),
    );
    getWorkflowMock.mockRejectedValue(new Error("Instance not found"));
    const recovery = {
      ...args,
      maxPages: 10,
      recoverReservationId: reservationId,
    };
    for (const request of [recovery, recovery, { ...args, maxPages: 10 }]) {
      await expect(
        continueSiteAuditTool.handler(request, ctx),
      ).resolves.toMatchObject({
        structuredContent: { dispatch: "unknown" },
      });
    }
    expect(workflowCreateMock).toHaveBeenCalledTimes(1);
    expect(reserveAuditMock).not.toHaveBeenCalled();
  });

  it("refuses when a replacement reservation appears between recovery read and claim", async () => {
    const before = "45e026b9-a7e9-4ea8-93ac-a1af93106953";
    const after = "d874bc32-a6e1-400f-a18a-8030ac5d102f";
    const config = (nonce: string) =>
      JSON.stringify({
        maxPages: 10,
        lighthouseStrategy: "none",
        continuationFrom: auditId,
        continuationReservation: nonce,
      });
    let stored = config(before);
    projectAuditMock.mockImplementation(async (id: string) =>
      id === auditId
        ? parent
        : {
            ...parent,
            id,
            status: "running",
            workflowInstanceId: null,
            config: stored,
          },
    );
    claimLaunchMock.mockImplementation(
      async (_id: string, _project: string, expected: string) => {
        stored = config(after);
        return stored === expected;
      },
    );
    await expect(
      continueSiteAuditTool.handler(
        {
          ...args,
          maxPages: 10,
          recoverReservationId: before,
        },
        ctx,
      ),
    ).resolves.toMatchObject({ structuredContent: { dispatch: "not-sent" } });
    expect(claimLaunchMock).toHaveBeenCalledWith(
      expect.any(String),
      projectId,
      config(before),
    );
    expect(workflowCreateMock).not.toHaveBeenCalled();
  });
});

describe("run_site_audit page budget", () => {
  beforeEach(() => {
    // The start URL check resolves the host over DNS-over-HTTPS.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ Status: 0, Answer: [] }, { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a free plan's oversized audit at the plan limit and says so", async () => {
    hasPaidPlanMock.mockResolvedValue(false);

    const result = await runAudit(500);

    expect(workflowCreateMock.mock.calls[0][0].params.config.maxPages).toBe(50);
    expect(textContent(result)).toContain(
      "Free plan audits are limited to 50 pages",
    );
    expect(textContent(result)).toContain("https://open-seo.test/billing");
    expect(captureEventMock.mock.calls[0][0].properties).toMatchObject({
      max_pages: 50,
      requested_max_pages: 500,
    });
  });

  it("keeps a paid plan's page budget", async () => {
    hasPaidPlanMock.mockResolvedValue(true);

    const result = await runAudit(500);

    expect(workflowCreateMock.mock.calls[0][0].params.config.maxPages).toBe(
      500,
    );
    expect(textContent(result)).not.toContain("limited to");
  });
});

describe("get_audit_issues", () => {
  beforeEach(() => {
    latestAuditMock.mockResolvedValue({
      id: "audit-1",
      startUrl: "https://example.com",
      status: "failed",
      pagesCrawled: 0,
    });
    issueGroupsMock.mockResolvedValue([]);
    listIssuesMock.mockResolvedValue([]);
  });

  it("doesn't report an audit that failed before crawling as clean", async () => {
    const result = await getAuditIssuesTool.handler(
      { projectId: "project-1" },
      makeToolContext(),
    );

    expect(textContent(result)).toContain("failed before crawling any pages");
    expect(textContent(result)).not.toContain("found no issues");
  });

  it("counts every matching issue and points to the next page", async () => {
    latestAuditMock.mockResolvedValue({
      id: "audit-1",
      startUrl: "https://example.com",
      status: "completed",
      pagesCrawled: 500,
    });
    issueGroupsMock.mockResolvedValue([
      { issueType: "thin-content", severity: "warning", count: 450 },
    ]);
    listIssuesMock.mockResolvedValue([
      {
        id: "issue-1",
        pageUrl: "https://example.com/a",
        issueType: "thin-content",
        severity: "warning",
        detailsJson: null,
      },
    ]);

    const result = await getAuditIssuesTool.handler(
      { projectId: "project-1", limit: 1 },
      makeToolContext(),
    );

    expect(textContent(result)).toContain("450 issues");
    expect(textContent(result)).toContain("call again with page 2");
  });
});

describe("get_audit_lighthouse", () => {
  beforeEach(() => {
    latestAuditMock.mockResolvedValue({
      id: "audit-1",
      startUrl: "https://example.com",
      lighthouseTotal: 2,
    });
    lighthouseResultsMock.mockResolvedValue(
      (["desktop", "mobile"] as const).map((strategy) => ({
        pageUrl: "https://example.com/",
        strategy,
        r2Key: `${strategy}-report`,
      })),
    );
  });

  it("says an audit ran without Lighthouse instead of returning nothing", async () => {
    latestAuditMock.mockResolvedValue({ id: "audit-1", lighthouseTotal: 0 });
    lighthouseResultsMock.mockResolvedValue([]);

    const result = await getAuditLighthouseTool.handler(
      { projectId: "project-1" },
      makeToolContext(),
    );

    expect(textContent(result)).toContain("ran without Lighthouse");
  });

  it("lists a page's mobile issues unless another device is asked for", async () => {
    const result = await getAuditLighthouseTool.handler(
      { projectId: "project-1", url: "https://example.com/" },
      makeToolContext(),
    );

    expect(textContent(result)).toContain("Issue in mobile-report");
    expect(textContent(result)).not.toContain("desktop-report");
  });
});
