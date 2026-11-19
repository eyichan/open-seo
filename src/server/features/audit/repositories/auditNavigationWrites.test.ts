import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { savePageDepths } from "./auditNavigationWrites";

const { env } = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("cloudflare:workers", () => ({ env }));

it("writes 10,000 page depths in bounded statements and retries without changing other audits", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE audit_pages (
    id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, crawl_depth INTEGER
  );
  CREATE INDEX by_audit ON audit_pages(audit_id);
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
  INSERT INTO audit_pages SELECT CAST(i AS TEXT), 'current', NULL FROM n;
  INSERT INTO audit_pages VALUES ('foreign', 'other', 14);`);

  let statements = 0;
  let changed = 0;
  env.DB = {
    prepare(query: string) {
      // D1 rejected the old compound SELECT at its native statement limit.
      expect(query).not.toMatch(/\bUNION\b/i);
      return {
        bind(...params: SQLInputValue[]) {
          expect(params.length).toBeLessThanOrEqual(100);
          return () => {
            statements++;
            changed += Number(db.prepare(query).run(...params).changes);
            return { success: true, results: [] };
          };
        },
      };
    },
    async batch(queries: Array<() => { success: boolean; results: [] }>) {
      return queries.map((query) => query());
    },
  };

  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    id: String(i + 1),
    crawlDepth: i,
  }));
  rows.push({ id: "foreign", crawlDepth: 7 });
  for (let i = 0; i < rows.length; i += 200) {
    await savePageDepths("current", rows.slice(i, i + 200));
  }
  expect(statements).toBeLessThan(260);
  expect(changed).toBe(10_000);
  expect(
    db
      .prepare("SELECT crawl_depth FROM audit_pages WHERE id = ?")
      .get("foreign"),
  ).toEqual({ crawl_depth: 14 });
  expect(
    db.prepare("SELECT crawl_depth FROM audit_pages WHERE id = ?").get("10000"),
  ).toEqual({ crawl_depth: 9_999 });
  await savePageDepths("current", rows.slice(9_900));
  expect(changed).toBe(10_000);
  await savePageDepths("current", [{ id: "10000", crawlDepth: null }]);
  expect(
    db.prepare("SELECT crawl_depth FROM audit_pages WHERE id = ?").get("10000"),
  ).toEqual({ crawl_depth: null });
});
