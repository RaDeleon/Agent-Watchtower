import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import {
  claudeRequestRecords, epochToRfc3339, claudeEventRecords, claudeToolRecords,
  claudeSessionMetricRecords,
} from "@/lib/adapters/claude/records";
import { validateRecord } from "@/lib/core/records";

describe("claudeRequestRecords", () => {
  it("emits one record per claude_requests row, including rows with no session", () => {
    // orphan-request-tokens exists precisely because 22.4% of requests have no
    // claude_sessions row. A projection that joins through sessions drops them.
    const db = buildAndRoll("orphan-request-tokens");
    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_requests;")[0].n;
    const got = [...claudeRequestRecords(db)];
    expect(got.length).toBe(src);
    expect(src).toBeGreaterThan(0);
  });

  it("emits records the Stage 3A validator accepts unchanged", () => {
    const db = buildAndRoll("orphan-request-tokens");
    // Counted, because a for-of over an empty generator asserts nothing. The
    // sibling test above pins the same fixture's row count, but CLAUDE.md
    // documents `npx vitest run -t "<name>"` as a standard workflow -- which
    // is exactly when the sibling does not run.
    let seen = 0;
    for (const r of claudeRequestRecords(db)) {
      seen++;
      expect(() => validateRecord(r)).not.toThrow();
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("carries the token columns as metrics and nothing from snapshots", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const byId = new Map([...claudeRequestRecords(db)].map((r) => [r.sourceRecordId, r]));
    const src = rows<{ request_id: string; tokens_in: number; tokens_out: number }>(
      db, "SELECT request_id, tokens_in, tokens_out FROM claude_requests;");
    expect(src.length).toBeGreaterThan(0);
    for (const row of src) {
      const rec = byId.get(row.request_id)!;
      expect(`${row.request_id}:${rec.metrics?.tokens_in}`)
        .toBe(`${row.request_id}:${row.tokens_in}`);
      expect(`${row.request_id}:${rec.metrics?.tokens_out}`)
        .toBe(`${row.request_id}:${row.tokens_out}`);
      // Cost is NOT a request metric -- see Task 1.
      expect(rec.metrics?.cost_usd).toBeUndefined();
    }
  });

  it("maps is_sidechain onto is_subagent", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const byId = new Map([...claudeRequestRecords(db)].map((r) => [r.sourceRecordId, r]));
    const src = rows<{ request_id: string; is_sidechain: number }>(
      db, "SELECT request_id, COALESCE(is_sidechain,0) AS is_sidechain FROM claude_requests;");
    expect(src.length).toBeGreaterThan(0);
    for (const row of src) {
      expect(`${row.request_id}:${byId.get(row.request_id)!.dimensions?.is_subagent}`)
        .toBe(`${row.request_id}:${row.is_sidechain === 1}`);
    }
  });

  it("resolves project through claude_project_paths, not from a column", () => {
    // NOTE: the brief names "four-projects" here, but that fixture (built for
    // Task 2's session-identity tests) inserts zero claude_requests rows, so
    // `expect(src.length).toBeGreaterThan(0)` below could never pass -- a
    // guard that can never go red is not a guard. "mixed-projects-one-day"
    // has four requests across four cwds with the same resolution outcomes
    // (two real repos, one unfiled, one excluded), which is what this test
    // actually needs.
    const db = buildAndRoll("mixed-projects-one-day");
    const byId = new Map([...claudeRequestRecords(db)].map((r) => [r.sourceRecordId, r]));
    const src = rows<{ request_id: string; project_path: string | null }>(db, `
      SELECT r.request_id, p.project_path
        FROM claude_requests r
        LEFT JOIN claude_project_paths p ON p.cwd = r.cwd;`);
    expect(src.length).toBeGreaterThan(0);
    for (const row of src) {
      expect(`${row.request_id}:${byId.get(row.request_id)!.project ?? null}`)
        .toBe(`${row.request_id}:${row.project_path ?? null}`);
    }
  });

  it("declares itself authoritative", () => {
    const db = buildAndRoll("orphan-request-tokens");
    let seen = 0;
    for (const r of claudeRequestRecords(db)) {
      seen++;
      expect(r.authority).toBe("authoritative");
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("epochToRfc3339", () => {
  it("emits an explicit UTC offset, which the validator requires", () => {
    expect(epochToRfc3339(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(epochToRfc3339(1757894400).endsWith("Z")).toBe(true);
  });
});

describe("claudeEventRecords", () => {
  it("emits one record per claude_events row", () => {
    const db = buildAndRoll("two-sessions-day");
    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_events;")[0].n;
    expect([...claudeEventRecords(db)].length).toBe(src);
    expect(src).toBeGreaterThan(0);
  });

  it("puts the hook name in dimensions, and keeps kind inside RECORD_KINDS", () => {
    const db = buildAndRoll("two-sessions-day");
    const recs = [...claudeEventRecords(db)];
    expect(recs.length).toBeGreaterThan(0);
    const names = new Set(rows<{ n: string }>(db,
      "SELECT DISTINCT hook_event_name AS n FROM claude_events;").map((r) => r.n));
    for (const r of recs) {
      expect(r.kind).toBe("event");                     // NOT "SessionStart"
      expect(names.has(String(r.dimensions?.hook_event_name))).toBe(true);
      expect(() => validateRecord(r)).not.toThrow();
    }
  });
});

describe("claudeToolRecords", () => {
  it("emits a tool record only where an attribution column is present", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const expected = rows<{ n: number }>(db, `
      SELECT COUNT(*) AS n FROM claude_requests
       WHERE COALESCE(attribution_skill, attribution_mcp_tool,
                      attribution_plugin) IS NOT NULL;`)[0].n;
    // The fixture must actually plant an attributed row -- otherwise this
    // assertion passes at 0 == 0 whether or not the generator's WHERE clause
    // works at all.
    expect(expected).toBeGreaterThan(0);
    expect([...claudeToolRecords(db)].length).toBe(expected);
  });

  it("always carries tool_name, which wt_tools requires NOT NULL", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const recs = [...claudeToolRecords(db)];
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(typeof r.dimensions?.tool_name).toBe("string");
      expect(r.dimensions?.tool_name).not.toBe("");
      expect(() => validateRecord(r)).not.toThrow();
    }
  });
});

describe("claudeSessionMetricRecords", () => {
  /** The three figures this generator draws from claude_status_snapshots. */
  const METRICS = ["cost_usd", "lines_added", "lines_removed"] as const;

  /**
   * What the source says, reduced with a BARE MAX and no COALESCE.
   *
   * This is rollup.sh:423's own reduction (`MAX(total_cost_usd)`), and the
   * difference is the whole point: SQL MAX ignores NULLs, so a session that
   * reported a figure once keeps it, and the group reduces to NULL only when
   * NO row ever carried one. The previous version of this expectation wrapped
   * each column in COALESCE(...,0) -- the same defect the generator had -- so
   * it was green by construction and could never have caught it.
   */
  function sourceMax(db: string) {
    return rows<{
      session_id: string;
      cost_usd: number | null; lines_added: number | null; lines_removed: number | null;
    }>(db, `
      SELECT session_id,
             MAX(total_cost_usd)       AS cost_usd,
             MAX(total_lines_added)    AS lines_added,
             MAX(total_lines_removed)  AS lines_removed
        FROM claude_status_snapshots
       WHERE session_id IS NOT NULL
       GROUP BY session_id;`);
  }

  it("takes MAX per session, never SUM — the 281.7x defect", () => {
    // dup-snapshot exists because this is the failure mode: several snapshot
    // rows per session, each carrying a running total. Its two rows carry
    // 1/100 lines_added and 0.5/1.5 cost, so MAX is 100/1.5 and SUM is 101/2.0.
    const db = buildAndRoll("dup-snapshot");
    const recs = [...claudeSessionMetricRecords(db)];
    const expected = sourceMax(db);
    expect(recs.length).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);

    const byId = new Map(recs.map((r) => [r.sourceRecordId, r]));
    for (const e of expected) {
      const got = byId.get(e.session_id)!;
      expect(`${e.session_id}:cost:${got.metrics?.cost_usd}`)
        .toBe(`${e.session_id}:cost:${e.cost_usd}`);
      expect(`${e.session_id}:added:${got.metrics?.lines_added}`)
        .toBe(`${e.session_id}:added:${e.lines_added}`);
    }
  });

  /**
   * "Do not assert a measurement where there is none" (CLAUDE.md), on the one
   * table where the absence is routine.
   *
   * total_lines_added and total_lines_removed are INTEGER with NO DEFAULT and
   * total_cost_usd is a nullable REAL, so a NULL means the status line never
   * reported that figure. Emitting 0 for it would tell Stage 3C's chart that
   * every session predating the line counters -- the historical majority --
   * measurably changed zero lines.
   *
   * BOTH cases are exercised, and the test refuses to pass without both:
   * make-fixture.sh's snap() takes lines-added/lines-removed as OPTIONAL
   * trailing arguments defaulting to NULL, and dup-snapshot is the only
   * scenario that passes them -- every other fixture, two-sessions-day
   * included, leaves both columns NULL while still reporting a cost.
   */
  it("omits an unmeasured figure instead of asserting 0", () => {
    let measured = 0;
    let absent = 0;

    for (const scenario of ["dup-snapshot", "two-sessions-day"]) {
      const db = buildAndRoll(scenario);
      const recs = [...claudeSessionMetricRecords(db)];
      const expected = sourceMax(db);
      expect(`${scenario}: ${recs.length}`).toBe(`${scenario}: ${expected.length}`);
      expect(`${scenario}: ${expected.length > 0}`).toBe(`${scenario}: true`);

      const byId = new Map(recs.map((r) => [r.sourceRecordId, r]));
      for (const e of expected) {
        const got = byId.get(e.session_id)!;
        for (const metric of METRICS) {
          const src = e[metric];
          const tag = `${scenario}/${e.session_id}/${metric}`;
          if (src === null) {
            absent++;
            // Absent, not 0 and not null: validateRecord rejects a null metric,
            // and 0 is the fabrication this test exists to forbid.
            expect(`${tag}: ${got.metrics?.[metric]}`).toBe(`${tag}: undefined`);
            expect(`${tag}: ${Object.keys(got.metrics ?? {}).includes(metric)}`)
              .toBe(`${tag}: false`);
          } else {
            measured++;
            expect(`${tag}: ${got.metrics?.[metric]}`).toBe(`${tag}: ${src}`);
          }
        }
      }
    }

    // Neither half may be vacuous: without a measured figure this proves
    // nothing about the values, and without an absent one it proves nothing
    // about the COALESCE.
    expect(`measured: ${measured > 0}`).toBe("measured: true");
    expect(`absent: ${absent > 0}`).toBe("absent: true");
  });

  it("carries no token metric at all — tokens come from claude_requests", () => {
    const db = buildAndRoll("dup-snapshot");
    let seen = 0;
    for (const r of claudeSessionMetricRecords(db)) {
      seen++;
      for (const key of Object.keys(r.metrics ?? {})) {
        expect(key.startsWith("tokens")).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("emits kind 'session' records the validator accepts", () => {
    const db = buildAndRoll("dup-snapshot");
    let seen = 0;
    for (const r of claudeSessionMetricRecords(db)) {
      seen++;
      expect(r.kind).toBe("session");
      expect(() => validateRecord(r)).not.toThrow();
    }
    expect(seen).toBeGreaterThan(0);
  });
});
