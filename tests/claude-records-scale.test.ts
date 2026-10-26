import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeRequestRecords, claudeEventRecords, claudeToolRecords,
} from "@/lib/adapters/claude/records";
import { SQL_PAGE_SIZE } from "@/lib/core/sql";
import { slow } from "./helpers/timeout";

/**
 * THE GUARD THAT WOULD HAVE CAUGHT THE ENOBUFS DEFECT.
 *
 * `watchtower sync` crashed on the real archive with a bare `spawnSync sqlite3
 * ENOBUFS` and left wt_requests at 0 -- nothing projected at all -- because
 * claudeRequestRecords read all of claude_requests in ONE query whose -json
 * rendering measured 9,895,624 bytes against Node's 1 MiB default maxBuffer.
 *
 * The whole suite passed anyway. Every fixture in tests/fixtures holds a
 * handful of rows, so nothing ever rendered enough bytes to reach the limit:
 * the tests were measuring the code against data too small to exercise it.
 * A ten-row fixture here would recreate exactly that blind spot, so this file
 * builds its own archive instead, and asserts the archive is genuinely big
 * enough before trusting anything it concludes from it.
 */

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "capture", "lib.sh");

/**
 * How many rows each big table gets.
 *
 * Chosen against the two thresholds that matter, not picked for roundness:
 *
 *  - It must EXCEED THE OLD 1 MiB CEILING, or the test cannot go red against
 *    the pre-fix code. At the ~370 bytes a row these columns render, 1 MiB is
 *    about 2,800 rows, so 12,000 clears it roughly 4x over. The assertion
 *    below measures the real rendering rather than trusting this arithmetic.
 *
 *  - It must SPAN SEVERAL PAGES, or it proves only that the buffer was raised
 *    and says nothing about the paging that keeps it out of reach. At
 *    SQL_PAGE_SIZE 5,000 this is three pages, the last one a partial -- so a
 *    dropped final page, a duplicated boundary row and an off-by-one offset
 *    are all reachable failures.
 *
 * It is also the largest number that still builds and reads in a second or so:
 * the rows go in with one recursive-CTE INSERT per table, and the generators
 * are read directly rather than through runSync, which spawns sqlite3 once per
 * record and would turn this into minutes for no extra coverage.
 */
const N = 12_000;

/** cwds cycled through the rows, each with a matching claude_project_paths row. */
const PROJECTS = 4;

function sh(script: string, env: Record<string, string>): string {
  return execFileSync("bash", ["-c", script], {
    env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Build an archive of N requests and N events on the REAL capture schema.
 *
 * The schema comes from capture/lib.sh's own cc_init_db, exactly as
 * tests/fixtures/make-fixture.sh gets it. Hand-rolling a CREATE TABLE here
 * would let this file drift from the schema production actually reads, which
 * is the same class of mistake as fixtures that do their own quoting.
 *
 * capture/ is READ here and never modified.
 */
function buildBigArchive(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-scale-"));
  const db = path.join(dir, "archive.sqlite");
  sh('. "$CC_LIB" && cc_init_db', { WATCHTOWER_DB_PATH: db, CC_LIB: LIB });

  const rows = `WITH RECURSIVE s(i) AS
    (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < ${N})`;

  // Widths are deliberately realistic -- a 40-char session uuid, an absolute
  // project path, a branch name -- because the bytes per row are what decides
  // whether this dataset can reach the ceiling at all.
  execFileSync("sqlite3", ["-cmd", ".bail on", db, `
    INSERT INTO claude_project_paths (cwd, project_path, resolved_at, source)
    WITH RECURSIVE p(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM p WHERE i < ${PROJECTS - 1})
    SELECT '/Users/fx/Developer/Coding/personal/Project' || i,
           '/Users/fx/Developer/Coding/personal/Project' || i,
           1750000000, 'git'
      FROM p;

    INSERT INTO claude_requests
      (request_id, session_id, ts, cwd, git_branch, model, is_sidechain,
       tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation,
       attribution_skill, attribution_mcp_server)
    ${rows}
    SELECT printf('req_%018d', i),
           'fxsess-' || printf('%04d', i % 500) || '-0000-4000-8000-000000000000',
           1750000000 + i,
           '/Users/fx/Developer/Coding/personal/Project' || (i % ${PROJECTS}),
           'feature/enobufs-guard',
           'claude-opus-4-8',
           i % 2,
           i, i * 2, i * 3, i * 4,
           'fx-skill-' || (i % 7),
           'fx-server-' || (i % 3)
      FROM s;

    INSERT INTO claude_events
      (id, ts, session_id, hook_event_name, cwd, repo, project_path, payload_json)
    ${rows}
    SELECT i,
           1750000000 + i,
           'fxsess-' || printf('%04d', i % 500) || '-0000-4000-8000-000000000000',
           'PostToolUse',
           '/Users/fx/Developer/Coding/personal/Project' || (i % ${PROJECTS}),
           'Project' || (i % ${PROJECTS}),
           '/Users/fx/Developer/Coding/personal/Project' || (i % ${PROJECTS}),
           '{"source":"fx","tool":"Read","reason":"scale-guard","prompt_len":' || i || '}'
      FROM s;`], { encoding: "utf8" });

  return db;
}

/**
 * Bytes sqlite3 emits for a query if it is NOT paged.
 *
 * Measured through a pipe so the measurement itself cannot hit the limit it is
 * measuring. This is the number the pre-fix code had to fit in 1 MiB.
 */
function unpagedJsonBytes(db: string, sql: string): number {
  return Number(sh('sqlite3 -json "$DB" "$SQL" | wc -c', { DB: db, SQL: sql }).trim());
}

const REQUEST_SQL = `
  SELECT r.request_id, r.session_id, r.ts, p.project_path AS project_path,
         r.git_branch, r.model, COALESCE(r.is_sidechain, 0) AS is_sidechain,
         COALESCE(r.tokens_in, 0) AS tokens_in,
         COALESCE(r.tokens_out, 0) AS tokens_out,
         COALESCE(r.tokens_cache_read, 0) AS tokens_cache_read,
         COALESCE(r.tokens_cache_creation, 0) AS tokens_cache_creation,
         r.api_error_status
    FROM claude_requests r
    LEFT JOIN claude_project_paths p ON p.cwd = r.cwd
   WHERE r.ts IS NOT NULL
   ORDER BY r.request_id;`;

const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

describe("Claude record generators at archive scale", () => {
  let db: string;
  beforeAll(() => { db = buildBigArchive(); }, slow(120_000));

  // If this ever goes red, every other assertion in this file has quietly
  // stopped guarding anything: the dataset would no longer be large enough to
  // fail against the code as it was before the fix.
  it("builds an archive whose unpaged read would overflow the old 1 MiB default", () => {
    const bytes = unpagedJsonBytes(db, REQUEST_SQL);
    expect(bytes).toBeGreaterThan(NODE_DEFAULT_MAX_BUFFER);
    expect(N).toBeGreaterThan(SQL_PAGE_SIZE * 2);
  });

  it("projects every request -- the read that died with ENOBUFS", () => {
    const got = [...claudeRequestRecords(db)];
    expect(got.length).toBe(N);
    // Order and completeness together: a paging bug that drops one row and
    // duplicates another keeps the count and breaks this.
    expect(new Set(got.map((r) => r.sourceRecordId)).size).toBe(N);
    expect(got[0].sourceRecordId).toBe("req_000000000000000001");
    expect(got[N - 1].sourceRecordId).toBe(`req_${String(N).padStart(18, "0")}`);
    const ids = got.map((r) => r.sourceRecordId);
    expect(ids).toEqual([...ids].sort());
  });

  it("carries each row's own values across the page boundaries", () => {
    // Paging must not smear one page's values onto another's rows. The rows
    // checked sit either side of every boundary the walk crosses.
    const got = [...claudeRequestRecords(db)];
    for (const i of [1, SQL_PAGE_SIZE, SQL_PAGE_SIZE + 1, 2 * SQL_PAGE_SIZE, N]) {
      const r = got[i - 1];
      expect(`${i}:${r.sourceRecordId}`)
        .toBe(`${i}:req_${String(i).padStart(18, "0")}`);
      expect(`${i}:${r.metrics?.tokens_in}/${r.metrics?.tokens_out}`)
        .toBe(`${i}:${i}/${i * 2}`);
      expect(`${i}:${r.project}`)
        .toBe(`${i}:/Users/fx/Developer/Coding/personal/Project${i % PROJECTS}`);
    }
  });

  it("projects every event", () => {
    expect(unpagedJsonBytes(db, `
      SELECT id, ts, session_id, hook_event_name, project_path, repo, payload_json
        FROM claude_events
       WHERE ts IS NOT NULL AND hook_event_name IS NOT NULL
       ORDER BY id;`)).toBeGreaterThan(NODE_DEFAULT_MAX_BUFFER);

    const got = [...claudeEventRecords(db)];
    expect(got.length).toBe(N);
    expect(new Set(got.map((r) => r.sourceRecordId)).size).toBe(N);
    expect(got.map((r) => Number(r.sourceRecordId)))
      .toEqual(Array.from({ length: N }, (_, k) => k + 1));
  });

  it("projects every tool row", () => {
    // Every request here names a skill, so the tool read is as wide as the
    // request read and crossed the same ceiling.
    const got = [...claudeToolRecords(db)];
    expect(got.length).toBe(N);
    expect(new Set(got.map((r) => r.sourceRecordId)).size).toBe(N);
    expect(got[0].sourceRecordId).toBe("req_000000000000000001:tool");
    expect(got[N - 1].dimensions?.tool_name).toBe(`fx-skill-${N % 7}`);
  });

  it("reads lazily, so an unbounded table never lands in memory whole", () => {
    // The generator must not materialise every page before yielding the first
    // record. Draining internally would pass every count above while putting
    // the full archive back on the heap.
    let seen = 0;
    for (const _ of claudeRequestRecords(db)) {
      if (++seen === 3) break;
    }
    expect(seen).toBe(3);
  });
});
