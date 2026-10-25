import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAndRoll, rerollup, ROLLUP, rows } from "./helpers/fixture-db";

interface ProfileRow {
  day: string;
  window_requests: number;
  tool_covered: number;
  matrix_score: number | null;
  matrix_tier: number | null;
  matrix_points_to_next: number | null;
  f_context: number | null;
  f_compaction: number | null;
  f_session_length: number | null;
  f_efficiency: number | null;
  median_ctx: number | null;
  median_requests: number | null;
  long_sessions: number | null;
  long_with_reset: number | null;
  cache_fresh_ratio: number | null;
  matrix_7d: number | null;
  matrix_wow: number | null;
  event_covered: number;
  total: number | null;
  measured: number | null;
  tier_index: number | null;
  tier_points_to_next: number | null;
  total_wow: number | null;
}

function day(db: string, d: string): ProfileRow | undefined {
  return rows<ProfileRow>(db, `SELECT * FROM claude_profile_daily WHERE day='${d}';`)[0];
}

describe("Stage 4A profile: windows, session stats, the Matrix score", () => {
  it("scores a single day from two sessions, TheOne's exact arithmetic order (spec 4.2/4.3)", () => {
    // session A: 12 requests, cache_read 205000/each, in 10, out 90
    // session B:  8 requests, cache_read  20000/each, in 10, out 90
    // median ctx  = (205000+20000)/2 = 112500
    //   context = round(100*(1-(112500-60000)/290000)) = 82
    // median n    = (12+8)/2 = 10 -> sessionLength = 100 (v <= good)
    // no long sessions -> compaction = 90
    // ratio = 2,620,000/2,000 = 1310 -> efficiency = 0 (v >= bad)
    // matrix = round(0.3*82+0.25*90+0.2*100+0.25*0) = round(67.1) = 67
    // tier: 45<=67<75 -> Operator(1), points to next = 75-67 = 8
    const db = buildAndRoll("profile-basic");
    const r = day(db, "2026-09-10");
    expect(r).toBeTruthy();
    expect(r!.window_requests).toBe(20);
    expect(r!.median_ctx).toBe(112500);
    expect(r!.f_context).toBe(82);
    expect(r!.median_requests).toBe(10);
    expect(r!.f_session_length).toBe(100);
    expect(r!.long_sessions).toBe(0);
    expect(r!.f_compaction).toBe(90);
    expect(r!.cache_fresh_ratio).toBe(1310);
    expect(r!.f_efficiency).toBe(0);
    expect(r!.matrix_score).toBe(67);
    expect(r!.matrix_tier).toBe(1);
    expect(r!.matrix_points_to_next).toBe(8);
    // (total / measured / tier / total_wow: see the ten-disciplines block below.)
    // Neither week has 20 requests to be gated on -- but the prior week has
    // NO data at all, so week-over-week is NULL, not a fabricated 0.
    expect(r!.matrix_7d).toBe(67);
    expect(r!.matrix_wow).toBeNull();
  });

  it("gates a day with 19 requests: the row exists, every score is NULL, window_requests is not", () => {
    const db = buildAndRoll("profile-gate");
    const r = day(db, "2026-09-10");
    expect(r).toBeTruthy();
    expect(r!.window_requests).toBe(19);
    expect(r!.matrix_score).toBeNull();
    expect(r!.f_context).toBeNull();
    expect(r!.f_compaction).toBeNull();
    expect(r!.f_session_length).toBeNull();
    expect(r!.f_efficiency).toBeNull();
    expect(r!.median_ctx).toBeNull();
    expect(r!.matrix_tier).toBeNull();
    expect(r!.matrix_points_to_next).toBeNull();
    // The '7'/'7p' windows get NO gate (spec 4.5): the same 19 requests, all in
    // one day, still produce a real (non-NULL) matrix_7d.
    expect(r!.matrix_7d).not.toBeNull();
    // Spec 4.6: a gated day has NULL totals and NO discipline rows at all.
    expect(r!.total).toBeNull();
    expect(r!.measured).toBeNull();
    expect(r!.tier_index).toBeNull();
    expect(r!.tier_points_to_next).toBeNull();
    expect(r!.total_wow).toBeNull();
    expect(rows(db, "SELECT * FROM claude_discipline_scores;")).toEqual([]);
  });

  it("flags a reset: cache_read climbing past 80k then dropping below half of it", () => {
    // 30-request session (n>=30 -> "long"): 29 requests at cache_read 90000,
    // then one at 40000. 90000 > 80000 and 40000*2 = 80000 < 90000 -> reset.
    const db = buildAndRoll("profile-reset-hit");
    const r = day(db, "2026-06-15");
    expect(r).toBeTruthy();
    expect(r!.long_sessions).toBe(1);
    expect(r!.long_with_reset).toBe(1);
    expect(r!.f_compaction).toBe(100);
    // (matrix_score itself, 72, is deliberately not pinned here: it would also
    // move under a defect that swaps the context/compaction weights, which is
    // exercised precisely by the "scores a single day" test above.)
  });

  it("does not flag a reset when the peak never exceeds 80,000", () => {
    // Same shape, but the peak (70000) stays under the 80000 floor a reset
    // requires -- dropping to 30000 afterward does not count.
    const db = buildAndRoll("profile-reset-miss");
    const r = day(db, "2026-06-15");
    expect(r).toBeTruthy();
    expect(r!.long_sessions).toBe(1);
    expect(r!.long_with_reset).toBe(0);
    expect(r!.f_compaction).toBe(0);
    // (matrix_score, 49, is deliberately not pinned here for the same reason
    // as the reset-hit test above.)
  });

  it("counts a 45-minute, 5-request session as long by SPAN, not just by count", () => {
    const db = buildAndRoll("profile-long-span");
    const r = day(db, "2026-09-10");
    expect(r).toBeTruthy();
    expect(r!.window_requests).toBe(25);
    expect(r!.long_sessions).toBe(1);
    expect(r!.long_with_reset).toBe(0);
  });

  it("idle day: a day with no requests of its own still gets a row with the same '30' inputs", () => {
    // Review Focus 4. 2026-09-11 has no request of its own, but its 30-day
    // window ([8/13..9/11]) still fully contains 2026-09-10's session A+B.
    const db = buildAndRoll("profile-basic");
    const r0 = day(db, "2026-09-10");
    const r1 = day(db, "2026-09-11");
    expect(r1).toBeTruthy();
    expect(r1!.window_requests).toBe(r0!.window_requests);
    expect(r1!.matrix_score).toBe(r0!.matrix_score);
    expect(r1!.median_ctx).toBe(r0!.median_ctx);
    expect(r1!.f_context).toBe(r0!.f_context);
    expect(r1!.f_compaction).toBe(r0!.f_compaction);
    expect(r1!.f_session_length).toBe(r0!.f_session_length);
    expect(r1!.f_efficiency).toBe(r0!.f_efficiency);
  });

  it("Matrix week-over-week: NULL with no prior week, the difference once both weeks have data", () => {
    // Day A (2026-09-10): a single 20-request session, cache_read 89000, in
    // 10, out 90 each -> f_context = f_compaction = 90 (deliberately equal,
    // so this scenario is unmoved by a defect that swaps their weights) ->
    // matrix_7d = round(0.3*90+0.25*90+0.2*100+0.25*0) = 70.
    // No prior week at all -> matrix_wow = NULL.
    // Day B (2026-09-20): a single 20-request session, cache_read 89000, in
    // 1000, out 8000 each -> matrix_7d = round(0.3*90+0.25*90+0.2*100+0.25*100)
    // = 95. B's prior week ([9/07..9/13]) contains ALL of day A's requests and
    // nothing else, so that week's Matrix score is the same 70 -> matrix_wow
    // = 95 - 70 = 25.
    const db = buildAndRoll("profile-wow");
    const a = day(db, "2026-09-10");
    const b = day(db, "2026-09-20");
    expect(a!.matrix_7d).toBe(70);
    expect(a!.matrix_wow).toBeNull();
    expect(b!.matrix_7d).toBe(95);
    expect(b!.matrix_wow).toBe(25);
  });

  it("buckets a request by its LOCAL day, not UTC (Review Focus 3)", () => {
    // A request at 2026-09-11T03:00Z is 2026-09-10T20:00 in America/Los_Angeles
    // (UTC-7 in September) -- it must land in 2026-09-10's window, giving 20
    // requests, not 19.
    const db = buildAndRoll("profile-tz", { TZ: "America/Los_Angeles" });
    const r = day(db, "2026-09-10");
    expect(r).toBeTruthy();
    expect(r!.window_requests).toBe(20);
  });

  it("leaves an empty session_id out of session stats but still counts its tokens", () => {
    // 20 requests with an empty session_id: no session stats exist (median_ctx
    // / median_requests / f_context / f_session_length are all NULL, since
    // there is no session to measure), but the cache/fresh totals still cover
    // every request -- efficiency is defined and NOT the needs-data default.
    const db = buildAndRoll("profile-no-session");
    const r = day(db, "2026-09-10");
    expect(r).toBeTruthy();
    expect(r!.window_requests).toBe(25);
    expect(r!.f_context).toBeNull();
    expect(r!.f_session_length).toBeNull();
    expect(r!.median_ctx).toBeNull();
    expect(r!.long_sessions).toBe(0);
    // ratio = (1000*25) / ((10+90)*25) = 25000/2500 = 10 -> efficiency L(10,10,45) = 100
    expect(r!.cache_fresh_ratio).toBe(10);
    expect(r!.f_efficiency).toBe(100);
    // The Matrix score itself is NULL: context/sessionLength are undefined.
    expect(r!.matrix_score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3: the ten disciplines, the 600 total, the ladder (spec 4.2, 4.4-4.6).
// Every expected number below is hand arithmetic over the fixture, written out
// in the comments with TheOne's helpers:
//   H(v, lo, hi)    = v <= lo -> 0,   v >= hi  -> 100, else round(100*((v-lo)/(hi-lo)))
//   L(v, good, bad) = v <= good -> 100, v >= bad -> 0, else round(100*(1-(v-good)/(bad-good)))
//   clamp(v) to [0, 100]; a discipline = mean of its DEFINED parts;
//   0-60 score = round(mean/100*60); no defined part -> needs-data, 0.
// ---------------------------------------------------------------------------

const IDS = [
  "prompt-hygiene", "context-hygiene", "session-hygiene", "model-routing", "cost-discipline",
  "verification", "automation", "reuse", "security", "output-quality",
];

interface Disc {
  score: number;
  status: string;
  definition: string;
  evidence: Record<string, unknown>;
}

function disciplines(db: string, d: string): Record<string, Disc> {
  const out: Record<string, Disc> = {};
  const rs = rows<{ discipline: string; score: number; status: string; definition: string; evidence_json: string }>(
    db,
    `SELECT discipline, score, status, definition, evidence_json FROM claude_discipline_scores WHERE day='${d}';`,
  );
  for (const r of rs) {
    out[r.discipline] = { score: r.score, status: r.status, definition: r.definition, evidence: JSON.parse(r.evidence_json) };
  }
  return out;
}

describe("Stage 4A profile: the ten disciplines, the total and the ladder", () => {
  it("profile-basic: every discipline hand-computed, and its evidence recomputed from the raw tables", () => {
    const db = buildAndRoll("profile-basic");
    const d = disciplines(db, "2026-09-10");
    expect(Object.keys(d).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const want = id === "automation" || id === "security" ? "watchtower" : "theone";
      expect(`${id}: ${d[id].definition}`).toBe(`${id}: ${want}`);
    }

    // 1 prompt-hygiene: clamp(3 kinds x 20) = 60 -> round(0.6*60) = 36, ok
    expect(d["prompt-hygiene"]).toMatchObject({ score: 36, status: "ok" });
    expect(d["prompt-hygiene"].evidence).toEqual({ slash_kinds: 3 });

    // 2 context-hygiene: Matrix context factor 82 -> round(0.82*60) = round(49.2) = 49, strong
    expect(d["context-hygiene"]).toMatchObject({ score: 49, status: "strong" });
    expect(d["context-hygiene"].evidence).toEqual({ median_ctx: 112500, factor: 82 });

    // 3 session-hygiene: sessionLength 100; compaction 90 (no long session);
    //   clamp(2 PreCompact x 20) = 40 -> mean 76.67 -> round(46.0) = 46, strong
    expect(d["session-hygiene"]).toMatchObject({ score: 46, status: "strong" });
    expect(d["session-hygiene"].evidence).toEqual({
      median_requests: 10, long_sessions: 0, long_with_reset: 0, compactions: 2,
      f_session_length: 100, f_compaction: 90, event_covered: 1,
    });

    // 4 model-routing: 3 models (<synthetic> excluded) -> clamp(2 x 45) = 90;
    //   top_pct = round(14/20*100) = 70 -> H(1-0.70, 0, 0.35) = round(85.71) = 86
    //   -> mean 88 -> round(52.8) = 53, strong
    expect(d["model-routing"]).toMatchObject({ score: 53, status: "strong" });
    expect(d["model-routing"].evidence).toEqual({ models: 3, top_model: "claude-opus-5", top_pct: 70 });

    // 5 cost-discipline: Matrix efficiency factor 0 -> 0, needs-work (MEASURED, not needs-data)
    //   cost/session = mean(MAX(0.50, 1.25), 0.75) = 1.00
    expect(d["cost-discipline"]).toMatchObject({ score: 0, status: "needs-work" });
    expect(d["cost-discipline"].evidence).toEqual({ cache_fresh_ratio: 1310, factor: 0, cost_per_session: 1 });

    // 6 verification: 20 main-thread calls, 8 inspect -> H(0.4, 0.1, 0.5) = 75;
    //   3 errors -> L(0.15, 0.05, 0.4) = round(71.43) = 71 -> mean 73 -> round(43.8) = 44, ok
    // Review Focus 1: the Write whose result never came is ONE OF THE 20 CALLS
    // and NOT an error (3/20, not 3/19 or 4/20); the four sidechain calls and
    // the name-less result-only row are not counted at all.
    expect(d.verification).toMatchObject({ score: 44, status: "ok" });
    expect(d.verification.evidence).toEqual({ tool_calls: 20, inspect_share: 0.4, tool_error_rate: 0.15 });
    expect(rows(db, "SELECT tool_name, is_error, is_sidechain FROM claude_tool_calls WHERE tool_use_id='TPF19';"))
      .toEqual([{ tool_name: "Write", is_error: null, is_sidechain: 0 }]);

    // 7 automation (Watchtower): runs = 1 headless session (B is sdk-ts; A is
    //   cli and does NOT count) + 2 subagent launches (Task, Agent) = 3
    //   -> clamp(3 x 20) = 60; 3 MCP calls -> clamp(20 + 2 x 3) = 26
    //   -> mean 43 -> round(25.8) = 26, needs-work
    expect(d.automation).toMatchObject({ score: 26, status: "needs-work" });
    expect(d.automation.evidence).toEqual({ headless_sessions: 1, subagent_launches: 2, mcp_calls: 3 });

    // 8 reuse: /compact x4 -> H(4, 1, 8) = round(42.86) = 43; 2 MCP servers
    //   -> clamp(2 x 33) = 66 -> mean 54.5 -> round(32.7) = 33, ok
    expect(d.reuse).toMatchObject({ score: 33, status: "ok" });
    expect(d.reuse.evidence).toEqual({ slash_max_repeat: 4, top_command: "/compact", mcp_servers: 2 });

    // 9 security (Watchtower): 10 prompts with a mode, 1 bypass -> 0.10
    //   -> L(0.10, 0.02, 0.25) = round(100*(1 - 0.08/0.23)) = round(65.2) = 65
    //   -> round(39.0) = 39, ok. The two prompts with no mode do not count.
    expect(d.security).toMatchObject({ score: 39, status: "ok" });
    expect(d.security.evidence).toEqual({ prompts_with_mode: 10, bypass_prompts: 1, bypass_share: 0.1, event_covered: 1 });

    // 10 output-quality: success 19/20 = 0.95 -> H(0.95, 0.9, 1) = 50;
    //   tool errors L(0.15) = 71 -> mean 60.5 -> round(36.3) = 36, ok
    expect(d["output-quality"]).toMatchObject({ score: 36, status: "ok" });
    expect(d["output-quality"].evidence).toEqual({ requests: 20, api_errors: 1, success: 0.95, tool_error_rate: 0.15 });

    // Total = 36+49+46+53+0+44+26+33+39+36 = 362 -> Operator (3), 38 to Architect.
    const p = day(db, "2026-09-10")!;
    // Hook data starts 2026-08-01 (S_PF_OLD's PreCompact), before W's first day.
    expect(p.event_covered).toBe(1);
    expect(p.total).toBe(362);
    expect(p.measured).toBe(10);
    expect(p.tier_index).toBe(3);
    expect(p.tier_points_to_next).toBe(38);
    expect(p.total_wow).toBeNull(); // 2026-09-03 has no row at all

    // Reconciliation (spec 6): every evidence number again, straight from the
    // raw tables with an independent query -- no helper shared with rollup.sh.
    const LO = "2026-08-12";
    const HI = "2026-09-10";
    const inW = (col: string) => `strftime('%Y-%m-%d', ${col}, 'unixepoch', 'localtime') BETWEEN '${LO}' AND '${HI}'`;
    const TC = `FROM claude_tool_calls WHERE is_sidechain = 0 AND tool_name IS NOT NULL AND ${inW("ts")}`;
    const raw = rows<Record<string, number | string | null>>(db, `SELECT
      (SELECT COUNT(DISTINCT command) FROM claude_slash_commands WHERE ${inW("ts")}) AS slash_kinds,
      (SELECT MAX(c) FROM (SELECT COUNT(*) AS c FROM claude_slash_commands WHERE ${inW("ts")} GROUP BY command)) AS slash_max_repeat,
      (SELECT command FROM claude_slash_commands WHERE ${inW("ts")} GROUP BY command ORDER BY COUNT(*) DESC, command LIMIT 1) AS top_command,
      (SELECT COUNT(*) ${TC}) AS tool_calls,
      (SELECT SUM(tool_name IN ('Read','Grep','Glob')) ${TC}) AS inspect,
      (SELECT SUM(is_error = 1) ${TC}) AS errors,
      (SELECT SUM(tool_name IN ('Task','Agent')) ${TC}) AS subagent_launches,
      (SELECT SUM(substr(tool_name, 1, 5) = 'mcp__') ${TC}) AS mcp_calls,
      (SELECT COUNT(DISTINCT mcp_server) ${TC}) AS mcp_servers,
      (SELECT COUNT(*) FROM claude_events WHERE hook_event_name = 'PreCompact' AND ${inW("ts")}) AS compactions,
      (SELECT COUNT(*) FROM claude_events WHERE hook_event_name = 'UserPromptSubmit' AND ${inW("ts")}
         AND json_extract(payload_json, '$.permission_mode') IS NOT NULL) AS prompts_with_mode,
      (SELECT COUNT(*) FROM claude_events WHERE hook_event_name = 'UserPromptSubmit' AND ${inW("ts")}
         AND json_extract(payload_json, '$.permission_mode') = 'bypassPermissions') AS bypass_prompts,
      (SELECT COUNT(DISTINCT session_id) FROM claude_requests WHERE entrypoint LIKE 'sdk-%' AND ${inW("ts")}) AS headless_sessions,
      (SELECT COUNT(*) FROM claude_requests WHERE ${inW("ts")}) AS requests,
      (SELECT COUNT(*) FROM claude_requests WHERE api_error_status <> '' AND ${inW("ts")}) AS api_errors,
      (SELECT COUNT(DISTINCT model) FROM claude_requests WHERE model <> '<synthetic>' AND model <> '' AND ${inW("ts")}) AS models,
      (SELECT model FROM claude_requests WHERE model <> '<synthetic>' AND ${inW("ts")} GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1) AS top_model,
      (SELECT MAX(c) FROM (SELECT COUNT(*) AS c FROM claude_requests WHERE model <> '<synthetic>' AND ${inW("ts")} GROUP BY model)) AS top_n,
      (SELECT AVG(m) FROM (SELECT MAX(total_cost_usd) AS m FROM claude_status_snapshots WHERE ${inW("ts")} GROUP BY session_id)) AS cost_per_session,
      (SELECT SUM(tokens_cache_read) * 1.0 / SUM(tokens_in + tokens_out) FROM claude_requests WHERE ${inW("ts")}) AS cache_fresh_ratio;`)[0];
    const ctx = rows<{ c: number; n: number }>(db, `SELECT AVG(tokens_cache_read) AS c, COUNT(*) AS n FROM claude_requests
      WHERE session_id <> '' AND ${inW("ts")} GROUP BY session_id ORDER BY c;`);
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const n = raw.tool_calls as number;
    expect(d["prompt-hygiene"].evidence.slash_kinds).toBe(raw.slash_kinds);
    expect(d["context-hygiene"].evidence.median_ctx).toBe(median(ctx.map((r) => r.c)));
    expect(d["context-hygiene"].evidence.factor).toBe(p.f_context);
    expect(d["session-hygiene"].evidence.median_requests).toBe(median(ctx.map((r) => r.n)));
    expect(d["session-hygiene"].evidence.compactions).toBe(raw.compactions);
    expect(d["session-hygiene"].evidence.long_sessions).toBe(p.long_sessions);
    expect(d["session-hygiene"].evidence.long_with_reset).toBe(p.long_with_reset);
    expect(d["session-hygiene"].evidence.f_session_length).toBe(p.f_session_length);
    expect(d["session-hygiene"].evidence.f_compaction).toBe(p.f_compaction);
    expect(d["model-routing"].evidence.models).toBe(raw.models);
    expect(d["model-routing"].evidence.top_model).toBe(raw.top_model);
    expect(d["model-routing"].evidence.top_pct).toBe(Math.round(((raw.top_n as number) / (raw.requests as number)) * 100));
    expect(d["cost-discipline"].evidence.cache_fresh_ratio).toBe(raw.cache_fresh_ratio);
    expect(d["cost-discipline"].evidence.factor).toBe(p.f_efficiency);
    expect(d["cost-discipline"].evidence.cost_per_session).toBeCloseTo(raw.cost_per_session as number, 12);
    expect(d.verification.evidence.tool_calls).toBe(n);
    expect(d.verification.evidence.inspect_share).toBeCloseTo((raw.inspect as number) / n, 12);
    expect(d.verification.evidence.tool_error_rate).toBeCloseTo((raw.errors as number) / n, 12);
    expect(d.automation.evidence.headless_sessions).toBe(raw.headless_sessions);
    expect(d.automation.evidence.subagent_launches).toBe(raw.subagent_launches);
    expect(d.automation.evidence.mcp_calls).toBe(raw.mcp_calls);
    expect(d.reuse.evidence.slash_max_repeat).toBe(raw.slash_max_repeat);
    expect(d.reuse.evidence.top_command).toBe(raw.top_command);
    expect(d.reuse.evidence.mcp_servers).toBe(raw.mcp_servers);
    expect(d.security.evidence.prompts_with_mode).toBe(raw.prompts_with_mode);
    expect(d.security.evidence.bypass_prompts).toBe(raw.bypass_prompts);
    expect(d.security.evidence.bypass_share).toBeCloseTo((raw.bypass_prompts as number) / (raw.prompts_with_mode as number), 12);
    expect(d["output-quality"].evidence.requests).toBe(raw.requests);
    expect(d["output-quality"].evidence.api_errors).toBe(raw.api_errors);
    expect(d["output-quality"].evidence.success).toBeCloseTo(1 - (raw.api_errors as number) / (raw.requests as number), 12);
    expect(d["output-quality"].evidence.tool_error_rate).toBe(d.verification.evidence.tool_error_rate);

    // A week later the window still holds exactly the same rows: same total,
    // total week over week = 362 - 362 = 0.
    const w = day(db, "2026-09-17")!;
    expect(w.total).toBe(362);
    expect(w.total_wow).toBe(0);
  });

  it("no tool rows at all (Review Focus 5): tool-derived parts are needs-data, the rest still scores", () => {
    const db = buildAndRoll("profile-no-tools");
    const p = day(db, "2026-09-10")!;
    expect(p.tool_covered).toBe(0);
    const d = disciplines(db, "2026-09-10");
    expect(Object.keys(d).sort()).toEqual([...IDS].sort());

    // prompt-hygiene, verification, reuse: every part is tool-derived -> needs-data, 0
    expect(d["prompt-hygiene"]).toEqual({ score: 0, status: "needs-data", definition: "theone", evidence: { slash_kinds: null } });
    expect(d.verification).toEqual({
      score: 0, status: "needs-data", definition: "theone",
      evidence: { tool_calls: null, inspect_share: null, tool_error_rate: null },
    });
    expect(d.reuse).toEqual({
      score: 0, status: "needs-data", definition: "theone",
      evidence: { slash_max_repeat: null, top_command: null, mcp_servers: null },
    });
    // automation: runs = 2 headless sessions ONLY (no subagent part without
    //   tool data) -> clamp(2 x 20) = 40; the MCP part is undefined, NOT 0
    //   -> mean(40) = 40 -> 24, needs-work (mean(40, 0) would give 12)
    expect(d.automation).toMatchObject({ score: 24, status: "needs-work" });
    expect(d.automation.evidence).toEqual({ headless_sessions: 2, subagent_launches: null, mcp_calls: null });
    // output-quality from success ONLY: 20/21 -> H(0.9524, 0.9, 1) = round(52.38) = 52
    //   -> round(31.2) = 31, ok (TheOne's tool-error part of 100 would give 46)
    expect(d["output-quality"]).toMatchObject({ score: 31, status: "ok" });
    expect(d["output-quality"].evidence).toMatchObject({ requests: 21, api_errors: 1, tool_error_rate: null });
    expect(d["output-quality"].evidence.success).toBeCloseTo(20 / 21, 12);
    // security: no prompt carries permission_mode (one payload is not even
    //   JSON, and must not break the rebuild) -> needs-data
    expect(d.security).toEqual({
      score: 0, status: "needs-data", definition: "watchtower",
      evidence: { prompts_with_mode: 0, bypass_prompts: 0, bypass_share: null, event_covered: 1 },
    });
    // model-routing: 3 models -> 90; top_pct = round(14/21*100) = round(66.67) = 67
    //   -> H(0.33, 0, 0.35) = round(94.29) = 94 -> mean 92 -> round(55.2) = 55
    expect(d["model-routing"]).toMatchObject({ score: 55, status: "strong" });
    expect(d["model-routing"].evidence).toEqual({ models: 3, top_model: "claude-opus-5", top_pct: 67 });
    // context 100 -> 60; session mean(100, 90, 0) -> 38; cost L(10) = 100 -> 60
    // total = 0 + 60 + 38 + 55 + 60 + 0 + 24 + 0 + 0 + 31 = 268, 6 of 10 measured
    expect(p.total).toBe(268);
    expect(p.measured).toBe(6);
    expect(p.tier_index).toBe(2);
    expect(p.tier_points_to_next).toBe(32);
  });

  it("zero tool calls in a COVERED window: verification is needs-data, not 100 (spec 4.4 departure)", () => {
    const db = buildAndRoll("profile-zero-tools");
    expect(day(db, "2026-09-10")!.tool_covered).toBe(1);
    const d = disciplines(db, "2026-09-10");
    // TheOne sets the tool-error rate to 0 when there are no calls, which
    // scores L(0) = 100. Here both verification parts are undefined.
    expect(d.verification).toEqual({
      score: 0, status: "needs-data", definition: "theone",
      evidence: { tool_calls: 0, inspect_share: null, tool_error_rate: null },
    });
    // output-quality: success 19/20 -> H(0.95) = 50 -> 30, ok; the undefined
    //   error part is left out (TheOne: mean(50, 100) = 75 -> 45).
    expect(d["output-quality"]).toMatchObject({ score: 30, status: "ok" });
    expect(d["output-quality"].evidence).toEqual({ requests: 20, api_errors: 1, success: 0.95, tool_error_rate: null });
    // Covered with nothing in it is a MEASURED zero, as in TheOne: 0 slash kinds
    // and 0 repeats / 0 servers score 0, needs-work -- not needs-data.
    expect(d["prompt-hygiene"]).toMatchObject({ score: 0, status: "needs-work", evidence: { slash_kinds: 0 } });
    expect(d.reuse).toMatchObject({
      score: 0, status: "needs-work",
      evidence: { slash_max_repeat: 0, top_command: null, mcp_servers: 0 },
    });
  });

  it("the ladder from both sides of a boundary, and total week over week", () => {
    const db = buildAndRoll("profile-ladder");
    // Day A: 27 (session) + 0 (model) + 12 (cost) + 0 (automation) + 60 (output) = 99
    const a = day(db, "2026-09-01")!;
    const d = disciplines(db, "2026-09-01");
    expect(d["session-hygiene"]).toMatchObject({ score: 27, status: "needs-work" });
    expect(d["model-routing"]).toMatchObject({ score: 0, status: "needs-work" });
    expect(d["cost-discipline"]).toMatchObject({ score: 12, status: "needs-work" });
    expect(d.automation).toMatchObject({ score: 0, status: "needs-work" });
    expect(d["output-quality"]).toMatchObject({ score: 60, status: "strong" });
    for (const id of ["prompt-hygiene", "context-hygiene", "verification", "reuse", "security"]) {
      expect(`${id}: ${d[id].status} ${d[id].score}`).toBe(`${id}: needs-data 0`);
    }
    expect(a.total).toBe(99);
    expect(a.measured).toBe(5);
    expect(a.tier_index).toBe(0);
    expect(a.tier_points_to_next).toBe(1);
    expect(a.total_wow).toBeNull(); // no row 7 days earlier
    // 2026-09-07: still only day A's rows; its D-7 (2026-08-31) has no row.
    expect(day(db, "2026-09-07")!.total).toBe(99);
    expect(day(db, "2026-09-07")!.total_wow).toBeNull();
    // Day A+7: cost L(37.5) = 21 -> 13, everything else unchanged -> 100.
    const b = day(db, "2026-09-08")!;
    expect(b.total).toBe(100);
    expect(b.tier_index).toBe(1);
    expect(b.tier_points_to_next).toBe(100);
    expect(b.total_wow).toBe(1); // 100 - 99
  });

  // Final review I1. Nothing else in the fixtures sits on either window edge
  // or on the coverage boundary: a 31-day window, or coverage `>` for `>=`,
  // left the whole suite green.
  // Final review M9: every other test runs with TZ=UTC, where 'localtime' is a
  // no-op, so dropping it from any per-day table but the request one stayed
  // green. Same fixture as the request test above, same Los Angeles clock.
  it("buckets tool calls, MCP servers, slash commands, events, snapshots and coverage by LOCAL day too", () => {
    const db = buildAndRoll("profile-tz", { TZ: "America/Los_Angeles" });
    expect(day(db, "2026-09-10")!.tool_covered).toBe(1); // _pf_coverage
    expect(day(db, "2026-09-10")!.event_covered).toBe(1); // _pf_evcov: event_start is local 08-12
    const d = disciplines(db, "2026-09-10");
    expect(d.verification.evidence.tool_calls).toBe(2); // _pf_tcday
    expect(d.automation.evidence.mcp_calls).toBe(1); // _pf_tcday
    expect(d.reuse.evidence.mcp_servers).toBe(1); // _pf_mcpday
    expect(d["prompt-hygiene"].evidence.slash_kinds).toBe(1); // _pf_slday
    expect(d["session-hygiene"].evidence.compactions).toBe(1); // _pf_evday
    expect(d["cost-discipline"].evidence.cost_per_session).toBe(2.5); // _pf_costday
  });

  it("pins both edges of the 30-day window: a row on D-29 counts, one on D-30 does not", () => {
    const db = buildAndRoll("profile-window-edge");
    // W(09-10) = [08-12, 09-10]: the 20 on D plus the D-29 request -- not D-30's.
    expect(day(db, "2026-09-10")!.window_requests).toBe(21);
    // W(09-09) = [08-11, 09-09] holds both edge requests; W(09-11) = [08-13,
    // 09-11] neither.
    expect(day(db, "2026-09-09")!.window_requests).toBe(2);
    expect(day(db, "2026-09-11")!.window_requests).toBe(20);
    // The same edge for hook events: D-29's PreCompact counts, D-30's does not.
    expect(disciplines(db, "2026-09-10")["session-hygiene"].evidence.compactions).toBe(1);
  });

  it("tool coverage starts ON coverage_start: a window whose first day is that day is covered, one a day earlier is not", () => {
    const db = buildAndRoll("profile-window-edge");
    // coverage_start = 2026-08-12 (the only main-thread tool call).
    expect(day(db, "2026-09-10")!.tool_covered).toBe(1); // W starts 08-12
    expect(day(db, "2026-09-09")!.tool_covered).toBe(0); // W starts 08-11
    // Covered, and the D-29 call is inside the window: measured, not NULL.
    expect(disciplines(db, "2026-09-10").verification.evidence.tool_calls).toBe(1);
  });

  // Stage 4B spec 4.5. Hook data (claude_events) starts 2026-08-20, requests
  // earlier. A window that starts before the hooks were installed has no
  // compaction count and no permission modes to read: those inputs are
  // unmeasured, not 0. Both days' windows hold exactly the same rows, so
  // coverage is the only difference between them (make-fixture.sh).
  // THE event_covered PLANT'S TARGET: drop bypass_share's `dw.event_covered = 1`
  // gate in _pf_in and security scores 39 here from prompts it cannot see.
  it("scores neither compactions nor security in a window that starts before the hook data", () => {
    const db = buildAndRoll("profile-event-edge");
    const p = day(db, "2026-09-17")!;
    expect(p.window_requests).toBe(20);
    expect(p.event_covered).toBe(0); // W starts 08-19, a day before event_start
    const d = disciplines(db, "2026-09-17");
    expect(d.security).toEqual({
      score: 0, status: "needs-data", definition: "watchtower",
      evidence: { prompts_with_mode: null, bypass_prompts: null, bypass_share: null, event_covered: 0 },
    });
    // mean(sessionLength 100, compaction 90) = 95 -> round(57.0) = 57: the
    // compactions part is left out, not scored as 0 (mean(100, 90, 0) -> 38).
    expect(d["session-hygiene"]).toEqual({
      score: 57, status: "strong", definition: "theone",
      evidence: {
        median_requests: 20, long_sessions: 0, long_with_reset: 0, compactions: null,
        f_session_length: 100, f_compaction: 90, event_covered: 0,
      },
    });
  });

  it("scores both from the first covered day on, exactly as before", () => {
    const db = buildAndRoll("profile-event-edge");
    const p = day(db, "2026-09-18")!;
    expect(p.window_requests).toBe(20);
    expect(p.event_covered).toBe(1); // W starts 08-20 = event_start
    const d = disciplines(db, "2026-09-18");
    // 1 of 10 prompts in bypassPermissions -> L(0.10, 0.02, 0.25) = 65 -> 39
    expect(d.security).toEqual({
      score: 39, status: "ok", definition: "watchtower",
      evidence: { prompts_with_mode: 10, bypass_prompts: 1, bypass_share: 0.1, event_covered: 1 },
    });
    // mean(100, 90, clamp(2 x 20) = 40) = 76.67 -> round(46.0) = 46
    expect(d["session-hygiene"]).toEqual({
      score: 46, status: "strong", definition: "theone",
      evidence: {
        median_requests: 20, long_sessions: 0, long_with_reset: 0, compactions: 2,
        f_session_length: 100, f_compaction: 90, event_covered: 1,
      },
    });
  });

  it("600 is Master, with no points to a next tier", () => {
    const db = buildAndRoll("profile-ladder-top");
    const d = disciplines(db, "2026-09-10");
    for (const id of IDS) expect(`${id}: ${d[id].score} ${d[id].status}`).toBe(`${id}: 60 strong`);
    const p = day(db, "2026-09-10")!;
    expect(p.matrix_score).toBe(100);
    expect(p.total).toBe(600);
    expect(p.measured).toBe(10);
    expect(p.tier_index).toBe(5);
    expect(p.tier_points_to_next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rebuild's transactions (final review C1 and M1). Every _pf_* temp table
// is built inside a READ transaction -- a WAL reader never blocks a writer --
// and the database write lock is taken only for the DELETE + INSERT-from-temp.
// Held across the temp build, it stalled every concurrent hook write for the
// whole rebuild (2.8 s on the live copy, 10 s at 3x history): past SessionEnd's
// 1.5 s cancel today, past cc_sql's 4 s busy timeout -- a silently dropped
// claude_events row -- within weeks.
// ---------------------------------------------------------------------------

/** The profile heredoc's SQL, `--` comments stripped, one statement per entry. */
function profileStatements(): string[] {
  const src = readFileSync(ROLLUP, "utf8");
  // Ends at the Stage 5 agent section, which follows it with a heredoc of its own.
  const section = src.slice(src.indexOf("# ---- rebuild the Usage Profile"), src.indexOf("# ---- rebuild the agent rollups (Stage 5)"));
  const body = section.slice(section.indexOf("<<'SQL'"), section.lastIndexOf("\nSQL\n"));
  const sql = body.slice(body.indexOf("\n") + 1).replace(/--[^\n]*/g, "");
  return sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s !== "");
}

describe("Stage 4A profile: the rebuild's transactions", () => {
  it("builds every temp table in one read transaction and holds the write lock only for DELETE + INSERT from temp", () => {
    const st = profileStatements();
    const createsTemp = (s: string) => /^CREATE TEMP(ORARY)? TABLE\b/i.test(s);
    // The whole build runs inside ONE read transaction (one consistent snapshot).
    expect(st[0]).toBe("BEGIN DEFERRED");
    const readCommit = st.indexOf("COMMIT");
    const lastTemp = st.map((s, i) => (createsTemp(s) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(lastTemp).toBeGreaterThan(0);
    expect(readCommit).toBeGreaterThan(lastTemp);
    // Exactly one write transaction, after it, holding nothing but the write.
    expect(st.filter((s) => /^BEGIN IMMEDIATE$/i.test(s))).toHaveLength(1);
    const begin = st.indexOf("BEGIN IMMEDIATE");
    const end = st.indexOf("COMMIT", begin);
    expect(begin).toBeGreaterThan(readCommit);
    expect(end).toBe(st.length - 1);
    const write = st.slice(begin + 1, end);
    expect(write.filter(createsTemp)).toEqual([]);
    // Nothing but DELETE and a straight copy from a staged temp table. (That
    // the DELETEs are INSIDE this transaction is the failure test's job below.)
    for (const s of write) {
      expect(s).toMatch(/^(DELETE FROM claude_\w+|INSERT INTO claude_\w+ \([\w, ]+\) SELECT [\w, ]+ FROM _pf_\w+ ORDER BY rowid)$/);
    }
  });

  // N1 (4A re-review): the test above proves every TEMP table is built before
  // the read COMMIT, but not that nothing ELSE is written there. A table
  // created without TEMP lands in main and takes the write lock inside the read
  // transaction, which is exactly the stall the read phase exists to remove.
  it("writes nothing but _pf_ temp tables in the read transaction", () => {
    const st = profileStatements();
    const readCommit = st.indexOf("COMMIT");
    const allowed = [
      /^CREATE TEMP TABLE _pf_/,
      /^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?\w+ ON _pf_/,
      /^DROP TABLE IF EXISTS _pf_/,
      /^INSERT INTO _pf_/,
      /^UPDATE _pf_/,
    ];
    const writes = st.slice(1, readCommit).filter((s) => /^(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i.test(s));
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) {
      expect({ s, allowed: allowed.some((re) => re.test(s)) }).toEqual({ s, allowed: true });
    }
  });

  it("a failed rebuild exits 1, keeps the previous profile intact, and still refreshes rank and the daily rollups", () => {
    const db = buildAndRoll("profile-basic");
    const profile = "SELECT * FROM claude_profile_daily ORDER BY day;";
    const scores = "SELECT * FROM claude_discipline_scores ORDER BY day, discipline;";
    const before = rows(db, profile);
    const beforeScores = rows(db, scores);
    expect(before.length).toBeGreaterThan(0);
    expect(beforeScores.length).toBeGreaterThan(0);
    // Stale what the rollup rebuilds BEFORE the profile, so its refresh shows,
    // then make the profile write itself fail (a trigger stands in for any
    // failure, as in ingest.test.ts's cursor test).
    execFileSync("sqlite3", [db, `DELETE FROM claude_rank_progress; DELETE FROM claude_daily_rollups;
      CREATE TRIGGER planted_failure BEFORE INSERT ON claude_discipline_scores
      BEGIN SELECT RAISE(ABORT, 'planted'); END;`]);

    const r = rerollup(db); // not --quiet: the failure must be reported
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cc-rollup: profile rebuild failed");
    expect(rows(db, profile)).toEqual(before);
    expect(rows(db, scores)).toEqual(beforeScores);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_rank_progress;")[0].n).toBe(1);
    expect(rows<{ day: string }>(db, "SELECT day FROM claude_daily_rollups;")).toEqual([{ day: "2026-09-10" }]);
  });
});

// Stage 10 (spec 4.2): the as-of day's 7-day discipline scores.
describe("Stage 10: 7-day discipline scores", () => {
  const ASOF = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };
  type S = { day: string; discipline: string; score: number; status: string };
  const s30 = (db: string) => rows<S>(db, `SELECT day, discipline, score, status FROM claude_discipline_scores
    WHERE day = '2026-09-30' ORDER BY discipline;`);
  const s7 = (db: string) => rows<S>(db, "SELECT day, discipline, score, status FROM claude_discipline_scores_7d ORDER BY discipline;");
  // profile-7d is built once, for the two tests that read it.
  let p7: string | undefined;
  const profile7d = () => (p7 ??= buildAndRoll("profile-7d", ASOF));

  // Identity: with every input inside the last 7 days, both windows see the
  // same data, so every one of the ten scores the same.
  it("scores the same over 7 days as over 30 when every input is in the last 7", () => {
    const db = profile7d();
    expect(s30(db)).toHaveLength(10);
    expect(s30(db).filter((r) => r.status !== "needs-data").length).toBeGreaterThan(6); // non-vacuity
    expect(s7(db)).toEqual(s30(db));
  });

  // Identity: profile-7d-split is profile-7d plus inputs on 09-10, inside the
  // 30-day window only. Its 7-day scores must be profile-7d's, so a 7-day row
  // that reads a '30' row anywhere (a missed win join, or R1's Matrix inputs
  // taken from the 30-day window) shows here, where the two windows differ.
  it("scores the 7-day window from its own 7 days, apart from the 30-day one", () => {
    const same = s30(profile7d());
    const split = buildAndRoll("profile-7d-split", ASOF);
    expect(s7(split)).toEqual(same);
    const split30 = s30(split);
    expect(split30.map((r) => r.discipline)).toEqual(same.map((r) => r.discipline));
    expect(split30.filter((r, i) => r.score !== same[i].score).length).toBeGreaterThanOrEqual(2); // non-vacuity
  });

  it("writes no 7-day scores when the 7-day window has under 20 requests", () => {
    const db = buildAndRoll("profile-7d-gated", ASOF);
    expect(s30(db)).toHaveLength(10);
    expect(s7(db)).toEqual([]);
  });
});
