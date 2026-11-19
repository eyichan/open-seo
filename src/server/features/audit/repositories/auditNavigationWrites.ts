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
          ({ id, crawlDepth }) => sql`SELECT CAST(${id} AS TEXT) AS page_id,
                                              CAST(${crawlDepth} AS INTEGER) AS depth`,
        ),
        sql` UNION ALL `,
      );
      return tx
        .update(auditPages)
        .set({ crawlDepth: sql`navigation_updates.depth` })
        .from(sql`(${values}) AS navigation_updates`)
        .where(
          and(
            eq(auditPages.auditId, auditId),
            sql`${auditPages.id} = navigation_updates.page_id`,
            sql`${auditPages.crawlDepth} IS DISTINCT FROM navigation_updates.depth`,
          ),
        );
    }),
  );
}
