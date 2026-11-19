import { and, eq, sql } from "drizzle-orm";
import { chunk } from "remeda";
import { db } from "@/db";
import { DB_BATCH_SIZE, runBatch } from "@/db/runBatch";
import { auditIssues, auditPages } from "@/db/schema";

export async function clearDepthIssues(auditId: string) {
  await db
    .delete(auditIssues)
    .where(
      and(
        eq(auditIssues.auditId, auditId),
        eq(auditIssues.issueType, "deep-page"),
      ),
    );
}

export async function savePageDepths(
  auditId: string,
  rows: Array<{ id: string; crawlDepth: number | null }>,
) {
  // Two parameters per row and the audit ID fit under D1's statement limit.
  const groups = chunk(rows, Math.floor((DB_BATCH_SIZE - 1) / 2));
  await runBatch((tx) =>
    groups.map((group) => {
      const values = sql.join(
        group.map(
          ({ id, crawlDepth }) =>
            sql`(CAST(${id} AS TEXT), CAST(${crawlDepth} AS INTEGER))`,
        ),
        sql`, `,
      );
      return tx
        .update(auditPages)
        .set({ crawlDepth: sql`navigation_updates.column2` })
        .from(sql`(VALUES ${values}) AS navigation_updates`)
        .where(
          and(
            // Keep D1's join driven by the batch's primary keys rather than
            // scanning the entire audit once for each batch.
            sql`CAST(${auditPages.auditId} AS TEXT) = ${auditId}`,
            sql`${auditPages.id} = navigation_updates.column1`,
            sql`${auditPages.crawlDepth} IS DISTINCT FROM navigation_updates.column2`,
          ),
        );
    }),
  );
}
