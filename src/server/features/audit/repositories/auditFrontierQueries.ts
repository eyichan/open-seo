import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { audits, auditIssues, auditPages } from "@/db/schema";

export async function getPageLimitIssue(auditId: string) {
  return db.query.auditIssues.findFirst({
    where: and(
      eq(auditIssues.auditId, auditId),
      eq(auditIssues.issueType, "crawl-page-limit"),
    ),
    columns: { detailsJson: true },
  });
}

export async function readLegacyVisited(
  auditId: string,
  afterUrl: string,
  limit: number,
) {
  const orderedUrl =
    getDatabaseProvider() === "postgres"
      ? sql<string>`${auditPages.url} COLLATE "C"`
      : sql<string>`${auditPages.url}`;
  return db
    .select({
      url: auditPages.url,
      pageId: auditPages.id,
      depth: auditPages.crawlDepth,
      inSitemap: auditPages.inSitemap,
      statusCode: auditPages.statusCode,
      fetchClass: auditPages.fetchClass,
      redirectUrl: auditPages.redirectUrl,
    })
    .from(auditPages)
    .where(and(eq(auditPages.auditId, auditId), gt(orderedUrl, afterUrl)))
    .orderBy(orderedUrl)
    .limit(limit);
}

export async function countRunningForProject(projectId: string) {
  const [result] = await db
    .select({ value: count() })
    .from(audits)
    .where(and(eq(audits.projectId, projectId), eq(audits.status, "running")));
  return result.value;
}

function unsentReservation(
  auditId: string,
  projectId: string,
  expectedConfig: string,
) {
  return and(
    eq(audits.id, auditId),
    eq(audits.projectId, projectId),
    eq(audits.config, expectedConfig),
    eq(audits.status, "running"),
    isNull(audits.workflowInstanceId),
  );
}

export async function claimContinuationLaunch(
  auditId: string,
  projectId: string,
  expectedConfig: string,
) {
  const rows = await db
    .update(audits)
    .set({ workflowInstanceId: auditId })
    .where(unsentReservation(auditId, projectId, expectedConfig))
    .returning({ id: audits.id });
  return rows.length === 1;
}

export async function releaseUnsentContinuation(
  auditId: string,
  projectId: string,
  expectedConfig: string,
) {
  await db
    .delete(audits)
    .where(unsentReservation(auditId, projectId, expectedConfig));
}
