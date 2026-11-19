import { env } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { CrawlerCredentialService } from "@/server/features/audit/services/CrawlerCredentialService";
import {
  AUDIT_LIMITS,
  type AuditLimitTier,
} from "@/server/features/audit/services/audit-capacity";
import {
  frontierPartCount,
  getAuditFrontier,
  type AuditRow,
} from "./AuditFrontier";
import { sha256Hex } from "@/server/lib/audit/ids";
import { parseAuditConfig, type AuditConfig } from "@/server/lib/audit/types";
import { AppError } from "@/server/lib/errors";
import { readWorkflowStatus } from "@/server/lib/startWorkflow";

type ContinuationInput = {
  actorUserId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  projectDomain: string | null;
  parentAuditId: string;
  maxPages: number;
  limitTier: AuditLimitTier;
  recoverReservationId?: string;
};

export async function startAuditContinuation(input: ContinuationInput) {
  let preparation;
  try {
    preparation = await prepareContinuation(input);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // This catch covers only preparation. The create call below must never
    // turn an uncertain dispatch into an authoritative refusal.
    return { dispatch: "not-sent" as const, reason: error.code };
  }
  if (preparation.params) {
    try {
      await env.SITE_AUDIT_WORKFLOW.create({
        id: preparation.auditId,
        params: preparation.params,
      });
    } catch {
      const status = await readWorkflowStatus(
        env.SITE_AUDIT_WORKFLOW,
        preparation.auditId,
      );
      // A missing instance can be a lost acknowledgement or an expired
      // instance. Never return a pre-dispatch refusal or replay here.
      if (status === null || status === "missing") {
        return { dispatch: "unknown" as const, auditId: preparation.auditId };
      }
    }
  }
  if ("unknown" in preparation && preparation.unknown)
    return { dispatch: "unknown" as const, auditId: preparation.auditId };
  return { dispatch: "accepted" as const, auditId: preparation.auditId };
}

async function prepareContinuation(input: ContinuationInput) {
  const { projectId, maxPages, billingCustomer } = input;
  const limits = AUDIT_LIMITS[input.limitTier];
  if (maxPages > limits.maxPagesPerAudit)
    throw new AppError("AUDIT_PAGE_LIMIT_EXCEEDED");
  const parent = await AuditRepository.getAuditForProject(
    input.parentAuditId,
    projectId,
  );
  if (!parent)
    throw new AppError("NOT_FOUND", "Parent audit not found in this project.");
  const projectHost = normalizeAuditHost(input.projectDomain ?? "");
  if (!projectHost || projectHost !== normalizeAuditHost(parent.startUrl)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The parent start URL is outside this project.",
    );
  }
  const auditId = await successorId(projectId, parent.id);
  const existing = await AuditRepository.getAuditForProject(auditId, projectId);
  if (input.recoverReservationId) {
    if (
      !existing ||
      requireSameRequest(existing, parent.id, maxPages)
        .continuationReservation !== input.recoverReservationId
    ) {
      throw new AppError(
        "AUDIT_ALREADY_RUNNING",
        "No matching unsent reservation is available to recover.",
      );
    }
    if (existing.status !== "running" || existing.workflowInstanceId !== null) {
      return existingSuccessor(existing, parent.id, maxPages);
    }
  } else if (existing) {
    return existingSuccessor(existing, parent.id, maxPages);
  }
  const parentConfig = parseAuditConfig(parent.config);
  if (!parentConfig || parentConfig.renderJavaScript) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only plain page crawls can continue without paid tools.",
    );
  }
  const frontier = await getAuditFrontier(parent);
  if (!frontier || !frontierPartCount(frontier)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Parent audit does not have a resumable frontier.",
    );
  }
  const credential = await CrawlerCredentialService.resolveCrawlerAccess(
    billingCustomer.organizationId,
    projectId,
    new URL(parent.startUrl).hostname,
  );
  if (parentConfig.crawlerCredentialId !== credential?.id) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The crawler credential changed since the parent audit.",
    );
  }
  const config: AuditConfig = {
    maxPages,
    lighthouseStrategy: "none",
    renderJavaScript: false,
    sitePlatform: parentConfig.sitePlatform,
    crawlerCredentialId: credential?.id,
    coverageVersion: 2,
    continuationFrom: parent.id,
    continuationReservation: input.recoverReservationId ?? crypto.randomUUID(),
  };
  const expectedConfig = existing?.config ?? JSON.stringify(config);
  const created =
    existing ||
    (await AuditRepository.createAudit({
      id: auditId,
      projectId,
      startedByUserId: input.actorUserId,
      startUrl: parent.startUrl,
      workflowInstanceId: null,
      config,
      pagesTotal: maxPages,
      lighthouseTotal: 0,
    }));
  if (!created) {
    return existingSuccessor(
      await AuditRepository.getAuditForProject(auditId, projectId),
      parent.id,
      maxPages,
    );
  }
  try {
    const usage = await AuditRepository.getAuditUsageForOrganization(
      billingCustomer.organizationId,
    );
    if (
      usage.runningCount > limits.maxRunningAudits ||
      (await AuditRepository.countRunningForProject(projectId)) > 1
    ) {
      throw new AppError("AUDIT_ALREADY_RUNNING");
    }
    if (usage.capacityUnits > limits.maxCapacityUnits)
      throw new AppError("AUDIT_CAPACITY_REACHED");
  } catch (error) {
    // The winning reservation has not dispatched. Release only its own row.
    if (!existing)
      await AuditRepository.releaseUnsentContinuation(
        auditId,
        projectId,
        expectedConfig,
      );
    throw error;
  }
  if (
    !(await AuditRepository.claimContinuationLaunch(
      auditId,
      projectId,
      expectedConfig,
    ))
  ) {
    const latest = await AuditRepository.getAuditForProject(auditId, projectId);
    if (latest?.config !== expectedConfig) {
      throw new AppError(
        "AUDIT_ALREADY_RUNNING",
        "The successor reservation changed. Read the audit history.",
      );
    }
    return existingSuccessor(latest, parent.id, maxPages);
  }
  return {
    auditId,
    params: {
      auditId,
      billingCustomer,
      projectId,
      startUrl: parent.startUrl,
      config,
      access: credential?.sealed,
    },
  };
}

async function existingSuccessor(
  audit: AuditRow | null | undefined,
  parentId: string,
  maxPages: number,
) {
  if (!audit)
    throw new AppError(
      "AUDIT_ALREADY_RUNNING",
      "The successor reservation changed. Read the audit history.",
    );
  requireSameRequest(audit, parentId, maxPages);
  if (audit.workflowInstanceId === null) {
    throw new AppError(
      "AUDIT_ALREADY_RUNNING",
      "The successor is reserved but no launch has been claimed.",
    );
  }
  if (audit.status === "running") {
    const status = await readWorkflowStatus(env.SITE_AUDIT_WORKFLOW, audit.id);
    if (status === null || status === "missing") {
      return { auditId: audit.id, params: null, unknown: true };
    }
  }
  if (audit.errorCode === "instance_lost")
    return { auditId: audit.id, params: null, unknown: true };
  return { auditId: audit.id, params: null };
}

function requireSameRequest(
  audit: AuditRow,
  parentId: string,
  maxPages: number,
) {
  const config = parseAuditConfig(audit.config);
  if (config?.continuationFrom !== parentId || config.maxPages !== maxPages) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This audit already has a successor with a different request.",
    );
  }
  return config;
}

function normalizeAuditHost(url: string) {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function successorId(projectId: string, parentAuditId: string) {
  const hash = await sha256Hex(`audit-successor:${projectId}:${parentAuditId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
