import { z } from "zod";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  frontierPartCount,
  getAuditFrontier,
  readFrontierPart,
} from "@/server/features/audit/services/AuditFrontier";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { startAuditContinuation } from "@/server/features/audit/services/startAuditContinuation";
import { AppError } from "@/server/lib/errors";
import { parseAuditConfig } from "@/server/lib/audit/types";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";

const auditScope = {
  projectId: z.uuid().describe("Exact project ID from list_projects."),
  auditId: z.uuid().describe("Exact audit ID from list_site_audits."),
};

export const getAuditFrontierTool = {
  name: "get_audit_frontier",
  config: {
    title: "Get site audit frontier",
    description:
      "Read a site's exact audit coverage and optionally one numbered part of its saved pending URL queue. A completed job may have incomplete coverage. No crawl or credits are started.",
    inputSchema: {
      ...auditScope,
      part: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "1-based pending queue part. Omit for coverage and the total part count.",
        ),
    },
    outputSchema: looseObjectOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(
    async (args: { projectId: string; auditId: string; part?: number }) => {
      const audit = await AuditRepository.getAuditForProject(
        args.auditId,
        args.projectId,
      );
      if (!audit)
        throw new AppError("NOT_FOUND", "Audit not found in this project.");
      const frontier = await getAuditFrontier(audit);
      if (args.part !== undefined && !frontier) {
        throw new AppError(
          "VALIDATION_ERROR",
          "This audit has no saved frontier.",
        );
      }
      const partCount = frontier ? frontierPartCount(frontier) : 0;
      const coverage = frontier
        ? {
            version: frontier.version,
            cohortId: frontier.cohortId,
            parentAuditId: frontier.parentAuditId,
            segmentPages: frontier.segmentPages,
            cumulativeVisited: frontier.cumulativeVisited,
            pendingCount: frontier.pendingCount,
            unreadPages: frontier.unreadPages,
            graphComplete: frontier.graphComplete,
            discoveryGaps: frontier.discoveryGaps,
            stop: frontier.stop,
            partCount,
            complete:
              frontier.stop === "exhausted" &&
              frontier.pendingCount === 0 &&
              frontier.cumulativeVisited > 0 &&
              frontier.unreadPages === 0 &&
              frontier.discoveryGaps.length === 0 &&
              frontier.graphComplete,
          }
        : null;
      const rows =
        args.part !== undefined && frontier
          ? await readFrontierPart(audit, frontier, args.part)
          : undefined;
      const reservedId =
        audit.status === "running" && audit.workflowInstanceId === null
          ? parseAuditConfig(audit.config)?.continuationReservation
          : undefined;

      return mcpResponse({
        text: coverage
          ? `Audit ${audit.id}: ${coverage.cumulativeVisited} visited across the cohort, ${coverage.pendingCount} pending, ${partCount} saved parts. Stop: ${coverage.stop}.`
          : `Audit ${audit.id} is ${audit.status}; saved frontier coverage is unavailable.`,
        structuredContent: {
          projectId: audit.projectId,
          auditId: audit.id,
          startUrl: audit.startUrl,
          status: audit.status,
          ...(reservedId
            ? { launchState: "reserved", launchReservationId: reservedId }
            : {}),
          coverage,
          ...(rows ? { part: args.part, rows } : {}),
        },
      });
    },
  ),
};

export const continueSiteAuditTool = {
  name: "continue_site_audit",
  config: {
    title: "Continue site audit",
    description:
      "Start the single successor to a completed capped audit. Reuse its visited URLs and queue without re-reading the sitemap. Runs a plain crawl without Lighthouse. Poll the returned audit ID.",
    inputSchema: {
      ...auditScope,
      maxPages: z
        .number()
        .int()
        .min(10)
        .max(10_000)
        .describe("Maximum new pages to crawl in this segment."),
      recoverReservationId: z
        .uuid()
        .optional()
        .describe("Claim an existing reservation proven never dispatched."),
    },
    outputSchema: looseObjectOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(
    async (
      args: {
        projectId: string;
        auditId: string;
        maxPages: number;
        recoverReservationId?: string;
      },
      context,
    ) => {
      const reply = await startAuditContinuation({
        actorUserId: context.auth.userId,
        billingCustomer: context.billing,
        projectId: args.projectId,
        parentAuditId: args.auditId,
        projectDomain: context.project.domain,
        maxPages: args.maxPages,
        recoverReservationId: args.recoverReservationId,
        limitTier: await AuditService.resolveAuditLimitTier(context.billing),
      });
      return mcpResponse({
        text:
          reply.dispatch === "accepted"
            ? `Successor audit ${reply.auditId} for ${args.auditId}. Read its status before taking another action.`
            : reply.dispatch === "unknown"
              ? `The launch status of successor audit ${reply.auditId} is unknown. Read audit history before taking another action.`
              : `Continuation was refused before this request dispatched a workflow (${reply.reason}).`,
        structuredContent: {
          projectId: args.projectId,
          parentAuditId: args.auditId,
          maxPages: args.maxPages,
          recoverReservationId: args.recoverReservationId ?? null,
          ...reply,
        },
      });
    },
  ),
};
