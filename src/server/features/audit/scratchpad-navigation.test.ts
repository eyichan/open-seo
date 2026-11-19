import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { LinkCaptureReason } from "@/server/lib/audit/frontier-checkpoint";
import { readCaptureCoverage } from "./scratchpad-depth-diagnostics";
import {
  advanceNavigation,
  readNavigationCoverage,
  readNavigationRows,
} from "@/server/features/audit/scratchpad-navigation";
import {
  FRONTIER_CLAIM_SQL,
  FRONTIER_DISCOVER_SQL,
  SCRATCHPAD_SCHEMA_SQL,
  serializeLinkCapture,
} from "./scratchpad-sql";

const START = "https://site.test/";

let db: DatabaseSync;

function addPage(
  pageId: string,
  url: string,
  opts: {
    status?: number;
    fetchClass?: string;
    redirectUrl?: string | null;
  } = {},
) {
  db.prepare(
    `INSERT INTO page_mirror (page_id, url, status_code, fetch_class, redirect_url)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    pageId,
    url,
    opts.status ?? 200,
    opts.fetchClass ?? "ok",
    opts.redirectUrl ?? null,
  );
}

function addLinks(
  pageId: string,
  url: string,
  targets: Array<
    | string
    | boolean
    | {
        html: boolean;
        unqueuedFrom: number;
        unqueuedRedirect: boolean;
        robotsExcludedFrom?: number;
        captureReason?: LinkCaptureReason;
      }
  >,
) {
  db.prepare(
    `INSERT OR REPLACE INTO page_links (page_id, url, targets_json) VALUES (?, ?, ?)`,
  ).run(pageId, url, JSON.stringify(targets));
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCRATCHPAD_SCHEMA_SQL);
});

// eslint-disable-next-line max-lines-per-function -- The navigation cases share the same SQLite crawl fixtures.
describe("navigation depth", () => {
  const url = (path: string) => new URL(path, START).href;

  function seed(paths: string[]) {
    for (const path of paths) {
      db.prepare(
        `INSERT INTO frontier (url, depth, source, in_sitemap) VALUES (?, ?, ?, 1)`,
      ).run(
        url(path),
        path === "/" ? 0 : null,
        path === "/" ? "link" : "sitemap",
      );
    }
  }

  function capture(
    path: string,
    targets: string[],
    options: {
      prior?: boolean;
      status?: number;
      redirect?: string;
      html?: boolean;
      incomplete?: boolean;
      unqueuedFrom?: number;
      robotsExcludedFrom?: number;
      captureReason?: LinkCaptureReason;
    } = {},
  ) {
    const source = url(path);
    addPage(path, source, {
      status: options.status,
      redirectUrl: options.redirect ? url(options.redirect) : null,
    });
    addLinks(path, source, [
      ...targets.map(url),
      {
        html: options.html ?? true,
        unqueuedFrom: options.unqueuedFrom ?? targets.length,
        unqueuedRedirect: false,
        robotsExcludedFrom: options.robotsExcludedFrom,
        captureReason: options.captureReason,
      },
      !options.incomplete,
    ]);
    db.prepare("UPDATE frontier SET state = ? WHERE url = ?").run(
      options.prior ? "prior" : "crawled",
      source,
    );
  }

  // Node's real SQLite runs the production statements. This is the small
  // adapter for the Cloudflare cursor and transaction interfaces.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const storage = {
    get sql() {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return {
        exec(query: string, ...params: Array<number | string | null>) {
          const rows = db.prepare(query).all(...params);
          return { toArray: () => rows, one: () => rows[0] };
        },
      } as unknown as SqlStorage;
    },
    transactionSync<T>(run: () => T) {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as DurableObjectStorage;

  function finish(sitePlatform?: "shopify") {
    let batches = 1;
    while (!advanceNavigation(storage, START, sitePlatform)) batches++;
    const coverage = readNavigationCoverage(storage.sql, START);
    let cursor = 0;
    const rows: ReturnType<typeof readNavigationRows> = [];
    for (;;) {
      const page = readNavigationRows(
        storage.sql,
        cursor,
        coverage.firstIncompleteDepth,
      );
      if (!page.length) break;
      rows.push(...page);
      cursor = page[page.length - 1].cursor;
    }
    return { batches, coverage, rows };
  }

  it("recomputes the same 200 sitemap leases, including pages recorded before their parents", () => {
    const paths = [
      "/",
      ...Array.from({ length: 199 }, (_, i) => `/?page=${i + 2}`),
    ];
    seed(paths);
    const claimed = db.prepare(FRONTIER_CLAIM_SQL).all(0, 200);
    expect(claimed.filter((row) => row.depth === null)).toHaveLength(199);
    db.exec("UPDATE frontier SET state = 'leased', chunk_no = 0");
    for (let i = 0; i < paths.length; i++) {
      const target = paths[i + 1];
      if (target) db.prepare(FRONTIER_DISCOVER_SQL).run(url(target), i + 1);
    }
    for (let i = paths.length - 1; i >= 0; i--) {
      const next = paths[i + 1];
      capture(paths[i], next ? [next] : ["/"]);
    }
    seed(["/resource"]);
    capture("/resource", [], { html: false });
    const first = finish();
    expect(first.batches).toBeGreaterThan(1);
    expect(first.coverage).toMatchObject({
      firstIncompleteDepth: null,
      segmentKnownPages: 200,
    });
    expect(
      Object.fromEntries(first.rows.map((row) => [row.id, row.crawlDepth])),
    ).toEqual(
      Object.fromEntries([
        ...paths.map((path, i) => [path, i]),
        ["/resource", null],
      ]),
    );
    expect(finish().rows).toEqual(first.rows);
  });

  it("traverses inherited anchors and lowers a queued path through a zero-cost redirect", () => {
    seed([
      "/",
      "/one",
      "/alias",
      "/target",
      "/child",
      "/loop",
      "/later",
      "/isolated",
    ]);
    capture("/one", ["/target"], { prior: true });
    capture("/", ["/one", "/alias"], { prior: true });
    capture("/alias", [], {
      status: 302,
      redirect: "/target",
      html: false,
      prior: true,
    });
    capture("/target", ["/child"], { prior: true });
    capture("/child", ["/loop"]);
    capture("/loop", [], { status: 302, redirect: "/child", html: false });
    capture("/isolated", ["/later"]);
    capture("/later", ["/isolated"]);
    db.prepare("UPDATE frontier SET depth = 8 WHERE url IN (?, ?)").run(
      url("/target"),
      url("/child"),
    );
    const { rows, coverage } = finish();
    expect(
      Object.fromEntries(rows.map(({ id, crawlDepth }) => [id, crawlDepth])),
    ).toEqual({
      "/": 0,
      "/one": 1,
      "/alias": 1,
      "/target": 1,
      "/child": 2,
      "/loop": 3,
      "/later": null,
      "/isolated": null,
    });
    expect(rows.find(({ id }) => id === "/alias")).toMatchObject({
      current: 0,
      html: 0,
    });
    expect(coverage).toMatchObject({
      cohortKnownPages: 6,
      segmentKnownPages: 2,
    });
  });

  it("leaves depths beyond a reachable evidence gap unset and ignores a legacy provisional depth", () => {
    seed(["/", "/omitted", "/route", "/child", "/grandchild", "/old"]);
    capture("/", ["/omitted", "/route"]);
    capture("/route", ["/child"]);
    capture("/child", ["/grandchild"]);
    capture("/grandchild", []);
    capture("/old", [], { prior: true });
    db.prepare("DELETE FROM page_links WHERE page_id = '/old'").run();
    db.prepare("UPDATE frontier SET depth = 7 WHERE url = ?").run(url("/old"));
    const { rows, coverage } = finish();
    expect(
      new Set(
        rows
          .filter(({ crawlDepth }) => crawlDepth === null)
          .map(({ id }) => id),
      ),
    ).toEqual(new Set(["/child", "/grandchild", "/old"]));
    expect(coverage).toMatchObject({
      firstIncompleteDepth: 1,
      cohortKnownPages: 2,
    });
  });

  it("keeps exact depth five when a 2xx capture gap at depth four could only open a path at five", () => {
    const paths = ["/", "/one", "/two", "/three", "/four", "/five", "/six"];
    seed(paths);
    for (const [i, path] of paths.entries()) {
      capture(path, paths[i + 1] ? [paths[i + 1]] : [], {
        incomplete: i === 4,
      });
    }
    const { rows, coverage } = finish();
    expect(coverage.firstIncompleteDepth).toBe(5);
    expect(rows.at(-2)?.crawlDepth).toBe(5);
    expect(rows.at(-1)?.crawlDepth).toBeNull();
  });

  it("reports a late source-level gap and resolves it when the successor captures the omitted target", () => {
    const paths = ["/", "/one", "/two", "/three", "/four", "/five", "/six"];
    seed(paths);
    for (const [i, path] of paths.entries()) {
      if (path === "/five")
        capture(path, ["/six", "/omitted"], { unqueuedFrom: 1 });
      else capture(path, paths[i + 1] ? [paths[i + 1]] : []);
    }
    db.exec("INSERT INTO coverage_flags VALUES ('link-discovery-limited')");
    expect(finish().coverage).toMatchObject({
      firstIncompleteDepth: 6,
      cohortKnownPages: 7,
    });
    // The successor has restored observations, plus a new capture.
    db.exec(
      "DELETE FROM navigation_depth; UPDATE frontier SET state = 'prior'",
    );
    seed(["/omitted"]);
    capture("/omitted", []);
    expect(finish().coverage).toMatchObject({
      firstIncompleteDepth: null,
      cohortKnownPages: 8,
    });
  });

  it("keeps verified HTML eligibility while discarding edges at the storage cap", () => {
    seed(["/", "/page"]);
    capture("/", ["/page"]);
    capture("/page", ["/ignored"]);
    db.prepare(
      "UPDATE page_links SET targets_json = ? WHERE page_id = '/page'",
    ).run(
      serializeLinkCapture(
        {
          pageId: "/page",
          url: url("/page"),
          targets: [url("/ignored")],
          isHtml: true,
        },
        false,
      ),
    );
    const { rows, coverage } = finish();
    expect(coverage.firstIncompleteDepth).toBe(2);
    expect(rows.find(({ id }) => id === "/page")).toMatchObject({
      crawlDepth: 1,
      html: 1,
    });
  });

  it.each([
    ["https://outside.test/", null],
    ["/discount/code", null],
    ["/unread", 1],
  ])(
    "classifies a legacy redirect to %s using the audit scope",
    (redirect, gap) => {
      seed(["/", "/alias"]);
      capture("/", ["/alias"]);
      capture("/alias", [], { status: 302, redirect, prior: true });
      addLinks("/alias", url("/alias"), [true]);
      expect(finish("shopify").coverage.firstIncompleteDepth).toBe(gap);
    },
  );

  it("treats a robots-excluded shortcut as unread and never enqueues a large unvisited fanout", () => {
    const pending = Array.from({ length: 5000 }, (_, i) => `/pending-${i}`);
    seed(["/", "/visible", "/deeper", ...pending]);
    capture("/", ["/visible", ...pending, "/blocked"], {
      unqueuedFrom: 1,
      robotsExcludedFrom: pending.length + 1,
    });
    capture("/visible", ["/deeper"]);
    capture("/deeper", []);
    const { rows, coverage, batches } = finish();
    expect(batches).toBe(1);
    expect(coverage.firstIncompleteDepth).toBe(1);
    expect(
      coverage.firstIncomplete?.samples.map(({ reason }) => reason),
    ).toEqual(["pending-target", "robots-excluded"]);
    expect(rows.map(({ crawlDepth }) => crawlDepth)).toEqual([0, 1, null]);
    expect(
      db.prepare("SELECT count(*) AS n FROM navigation_depth").get()?.n,
    ).toBe(2);
  });

  it("retains the earliest blocked anchors and samples a separate body cap", () => {
    seed(["/", "/chart"]);
    capture("/", ["/chart", "/?secret", "/pkey"], {
      unqueuedFrom: 1,
      robotsExcludedFrom: 1,
    });
    capture("/chart", [], {
      incomplete: true,
      captureReason: "html-byte-limit",
    });
    const { coverage } = finish();
    expect(coverage.firstIncompleteDepth).toBe(1);
    expect(coverage.firstIncomplete).toEqual({
      affectedSources: 1,
      samples: [`${START}?…`, `${START}…`].map((target) => ({
        source: START,
        sourcePageId: "/",
        reason: "robots-excluded",
        target,
      })),
    });
    expect(readCaptureCoverage(storage.sql, true).incompleteCapture).toEqual({
      affectedPages: 1,
      samples: [
        {
          source: `${START}…`,
          sourcePageId: "/chart",
          reason: "html-byte-limit",
        },
      ],
    });
  });

  it("counts every earliest source while limiting the saved witness rows", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/source-${i}`);
    seed(["/", ...paths]);
    capture("/", paths);
    for (const path of paths) {
      capture(path, ["/unfetched"], { unqueuedFrom: 0, robotsExcludedFrom: 1 });
    }
    const { coverage } = finish();
    expect(coverage.firstIncompleteDepth).toBe(2);
    expect(coverage.firstIncomplete?.affectedSources).toBe(12);
    expect(coverage.firstIncomplete?.samples).toHaveLength(8);
    expect(coverage.firstIncomplete?.samples[0]).toMatchObject({
      reason: "discovery-limit",
      source: `${START}…`,
      target: `${START}…`,
    });
  });
});
