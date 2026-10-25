#!/usr/bin/env node
// theone-lockstep.mjs -- Stage 4A's numeric proof against TheOne (spec 7).
//
// Feeds TheOne's OWN, UNMODIFIED pure functions the same window rollup.sh
// scored, and diffs the two. Run by hand, never by `npm test` (vitest collects
// *.test.ts only), because it imports TheOne's source from a TheOneOS checkout:
//
//   node --experimental-strip-types tests/fixtures/theone-lockstep.mjs <db-copy> [--day YYYY-MM-DD | --all]
//
//   <db-copy>   a `sqlite3 .backup` COPY the rollup has already run over, in the
//               same TZ as this run (both bucket by LOCAL day). Opened -readonly.
//   --day       one ungated day (default: the latest ungated day)
//   --all       every ungated day; full detail for the latest and any mismatch
//   THEONE_ROOT the TheOneOS checkout (default: its sibling of this repo). Read only.
//
// What is TheOne's code and what is not. Everything that SCORES is TheOne's:
// buildSessionStats, computeHygieneScore, tierForScore, pointsToNextTier and
// buildUsageProfile (lib/ccflare/profile.ts); metricsFromSources and
// calculateUsageProfile (lib/ccflare/usage-profile.ts); summarizeSession
// (lib/claude-code/transcript.ts) and buildWindow (lib/claude-code/usage.ts),
// which assemble TheOne's Claude Code activity window, top-8 lists and all.
// This script only turns Watchtower rows into TheOne's input records.
//
// profile.ts imports "server-only" and seven fs/network server modules; so does
// usage.ts. A node:module resolve/load hook maps TheOne's "@/" alias to the
// checkout, strips types itself (TheOneOS has no "type": "module", so Node
// would not otherwise load its ESM .ts as ESM), and replaces "server-only" and
// every server module the pure path never calls with a stub whose exports
// THROW if called -- if TheOne's pure path ever starts calling one, this proof
// fails loudly instead of scoring a silent no-op.
//
// Exit 0: the Matrix score, its four factors and tier, and disciplines 1-6, 8
// and 10 match exactly on every day checked, where every difference from
// TheOne's raw output is one of spec 4.4's named departures and vanishes once
// that departure is applied. Exit 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEONE_ROOT = process.env.THEONE_ROOT ?? path.resolve(HERE, "..", "..", "..", "TheOneOS");

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith("--") && !/^\d{4}-\d{2}-\d{2}$/.test(a));
const ALL = args.includes("--all");
const DAY_ARG = args.includes("--day") ? args[args.indexOf("--day") + 1] : undefined;
if (!DB || !existsSync(DB)) {
  console.error("usage: node --experimental-strip-types tests/fixtures/theone-lockstep.mjs <db-copy> [--day YYYY-MM-DD | --all]");
  process.exit(2);
}
if (!existsSync(path.join(THEONE_ROOT, "lib", "ccflare", "usage-profile.ts"))) {
  console.error(`theone-lockstep: no TheOneOS checkout at ${THEONE_ROOT} (set THEONE_ROOT)`);
  process.exit(2);
}

// ---- load TheOne's modules ---------------------------------------------------
const STUBS = {
  "server-only": [],
  "@/lib/ccflare/usage-store": ["captureCcflareUsage", "loadUsageRecords", "usageStoreBytes"],
  "@/lib/ccflare/manage": ["getCcflareSetupStatus", "isCcflareEnabled"],
  "@/lib/ccflare/audits": ["listCcflareAudits"],
  "@/lib/headless-claude/orchestrator": ["listHeadlessRuns"],
  "@/lib/agency/runs": ["listRuns"],
  "@/lib/writeback/proposals": ["listProposals"],
  "@/lib/claude-code/store": ["captureClaudeCodeUsage", "loadSessionSummaries"],
};
const HOOKS = `
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
let root, stubs;
export async function initialize(data) { root = data.root; stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(stubs, specifier)) return { url: "wt-stub:" + specifier, shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const base = root + "/" + specifier.slice(2);
    for (const f of [base + ".ts", base + "/index.ts"]) {
      if (existsSync(f)) return { url: pathToFileURL(f).href, shortCircuit: true };
    }
    throw new Error("theone-lockstep: cannot resolve " + specifier);
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("wt-stub:")) {
    const spec = url.slice("wt-stub:".length);
    const src = stubs[spec].map((n) =>
      "export function " + n + "() { throw new Error('theone-lockstep: stubbed " + spec + "#" + n + " was called'); }"
    ).join("\\n");
    return { format: "module", source: src || "export {};", shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")), shortCircuit: true };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, { data: { root: THEONE_ROOT, stubs: STUBS } });
const theone = (rel) => import(pathToFileURL(path.join(THEONE_ROOT, rel)).href);
const UP = await theone("lib/ccflare/usage-profile.ts");
const PR = await theone("lib/ccflare/profile.ts");
const CU = await theone("lib/claude-code/usage.ts");
const TR = await theone("lib/claude-code/transcript.ts");

// ---- read the copy ----------------------------------------------------------
function q(sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", DB, sql], { encoding: "utf8", maxBuffer: 1 << 28 });
  return out.trim() === "" ? [] : JSON.parse(out);
}
const localDay = (col) => `strftime('%Y-%m-%d', ${col}, 'unixepoch', 'localtime')`;

const days = q("SELECT day FROM claude_profile_daily WHERE window_requests >= 20 ORDER BY day;").map((r) => r.day);
if (days.length === 0) {
  console.error("theone-lockstep: no ungated day in this copy (has the rollup run?)");
  process.exit(2);
}
const latest = days[days.length - 1];
const toCheck = ALL ? days : [DAY_ARG ?? latest];

const DAY_MS = 86_400_000;
const TIER_ID = { coppertop: 0, operator: 1, "the-one": 2 };
const FACTOR = { context: "f_context", compaction: "f_compaction", sessionLength: "f_session_length", efficiency: "f_efficiency" };
const PORTED = ["prompt-hygiene", "context-hygiene", "session-hygiene", "model-routing", "cost-discipline", "verification", "reuse", "output-quality"];
const WATCHTOWER = { automation: "Watchtower definition (decision 2): headless sdk-* sessions + Task/Agent launches, not TheOne's headless/agency run records", security: "Watchtower definition (decision 2): share of prompts in bypassPermissions, not TheOne's shell-routing flag / write-back approvals" };
const INSPECTION = ["Read", "Grep", "Glob"];

/** A TheOne TranscriptRecord with every field TheOne's parser would default. */
function trec(fields) {
  return {
    type: "user", subtype: null, ts: null, sessionId: null, requestId: null, model: null, usage: null,
    toolUses: [], toolErrors: 0, slashCommands: [], isCompactBoundary: false, durationMs: null, hasThinking: false,
    ...fields,
  };
}

function checkDay(day) {
  const [p] = q(`SELECT * FROM claude_profile_daily WHERE day = '${day}';`);
  if (!p || p.window_requests < 20) throw new Error(`${day} is not an ungated day in this copy`);
  const ours = Object.fromEntries(
    q(`SELECT discipline, score, status, evidence_json FROM claude_discipline_scores WHERE day = '${day}';`)
      .map((r) => [r.discipline, { score: r.score, status: r.status, evidence: JSON.parse(r.evidence_json) }]),
  );
  const [{ lo }] = q(`SELECT date('${day}', '-29 day') AS lo;`);
  const inW = (col) => `${localDay(col)} BETWEEN '${lo}' AND '${day}'`;

  // TheOne's CcflareUsageRecord[] for the window: every request, sidechain
  // included (spec 4.1), in (ts, request_id) order -- TheOne's session sort is
  // a STABLE sort on ts, so ties keep this order, which is the rollup's.
  // '<synthetic>' is not a model (spec 4.4): it goes in with model = null, the
  // way TheOne treats a record with no model -- still a request, still in
  // every denominator. Cost is not scored (evidence only), so it is 0.
  const records = q(`SELECT request_id, session_id, ts, model, tokens_in, tokens_out, tokens_cache_read,
                            tokens_cache_creation, api_error_status
                     FROM claude_requests WHERE ts IS NOT NULL AND ${inW("ts")} ORDER BY ts, request_id;`)
    .map((r) => ({
      id: r.request_id,
      ts: r.ts * 1000,
      model: r.model && r.model !== "<synthetic>" ? r.model : null,
      session: r.session_id ? r.session_id : null,
      input: r.tokens_in ?? 0,
      output: r.tokens_out ?? 0,
      cacheRead: r.tokens_cache_read ?? 0,
      cacheWrite: r.tokens_cache_creation ?? 0,
      cost: 0,
      ok: !r.api_error_status,
      rtMs: null,
    }));

  // TheOne's Claude Code activity window, from the SAME main-thread tool and
  // slash rows: one TranscriptRecord per tool_use, per errored tool_result, per
  // slash command and per compaction (a PreCompact hook row stands in for a
  // compact_boundary line -- spec 4.4's third departure is a SOURCE change, fed
  // identically here), folded by TheOne's summarizeSession and buildWindow. A
  // window that is not tool-covered (spec 3.3) has no activity data at all:
  // cc = null, which is TheOne's own "no transcripts" state.
  const tools = q(`SELECT ts, tool_name, is_error FROM claude_tool_calls
                   WHERE is_sidechain = 0 AND tool_name IS NOT NULL AND ts IS NOT NULL AND ${inW("ts")};`);
  const slash = q(`SELECT ts, command FROM claude_slash_commands WHERE ts IS NOT NULL AND ${inW("ts")};`);
  const compacts = q(`SELECT ts FROM claude_events WHERE hook_event_name = 'PreCompact' AND ${inW("ts")};`);
  const allTs = [...records.map((r) => r.ts), ...tools.map((t) => t.ts * 1000), ...slash.map((s) => s.ts * 1000), ...compacts.map((e) => e.ts * 1000)];
  // TheOne's windows keep rows with ts >= now - 30 days and have no upper
  // bound, so this `now` keeps EXACTLY the rows selected above (whatever DST
  // did to the local calendar). Asserted below.
  const now = Math.min(...allTs) + 30 * DAY_MS;

  let cc = null;
  let summary = null;
  if (p.tool_covered === 1) {
    const trs = [
      ...tools.map((t) => trec({ type: "assistant", ts: t.ts * 1000, toolUses: [t.tool_name] })),
      ...tools.filter((t) => t.is_error === 1).map((t) => trec({ type: "user", ts: t.ts * 1000, toolErrors: 1 })),
      ...slash.map((s) => trec({ type: "user", ts: s.ts * 1000, slashCommands: [s.command] })),
      ...compacts.map((e) => trec({ type: "system", subtype: "compact_boundary", ts: e.ts * 1000, isCompactBoundary: true })),
    ];
    summary = TR.summarizeSession(trs, { sessionId: "watchtower-window", projectSlug: "watchtower" });
    cc = CU.buildWindow([summary], 30, now);
  }

  // ---- TheOne, exactly as the brief lays it out --------------------------------
  const sessions = PR.buildSessionStats(records).filter((s) => s.id !== "unattributed");
  const totalCacheRead = records.reduce((s, r) => s + r.cacheRead, 0);
  const totalFresh = records.reduce((s, r) => s + r.input + r.output, 0);
  const hyg = PR.computeHygieneScore({ sessions, totalCacheRead, totalFresh });
  const successRate = records.length ? records.filter((r) => r.ok).length / records.length : null;
  // TheOne's own end-to-end assembly, for its 30-day UsageWindow (buildWindow in
  // profile.ts is not exported) and as a cross-check of the direct calls.
  const full = PR.buildUsageProfile(records, now, 0, { cc });
  const window = full.window30;
  const metrics = UP.metricsFromSources({ window, factors: hyg.factors, successRate, cc });
  const raw = UP.calculateUsageProfile(metrics);

  const problems = [];
  if (window.requests !== records.length) problems.push(`window30 kept ${window.requests} of ${records.length} records`);
  if (cc && summary.toolCalls !== tools.length) problems.push(`activity window lost tool calls (${summary.toolCalls} of ${tools.length})`);
  if (full.hygieneScore !== hyg.score || !isDeepStrictEqual(full.watchProfile, raw)) {
    problems.push("TheOne's buildUsageProfile disagrees with its own direct calls (proof harness bug)");
  }

  // ---- spec 4.4's departures, applied to TheOne's metrics bag -------------------
  // Each is applied only where it changes an input. The verdict requires OURS
  // to equal TheOne-with-departures EXACTLY, and every difference from TheOne's
  // raw output to be accounted for by a departure listed here.
  const neutral = { ...metrics };
  const applied = [];
  if (cc && cc.toolCalls === 0 && metrics.toolErrorRate !== undefined) {
    delete neutral.toolErrorRate;
    applied.push("spec 4.4 departure 1 (no-tool-calls rate): TheOne scores 0 tool calls as a 0% error rate (L = 100); Watchtower leaves it undefined -> verification needs-data, output-quality from success only");
  }
  if (cc && cc.toolCalls > 0) {
    const all = Object.entries(summary.toolCounts).filter(([n]) => INSPECTION.includes(n)).reduce((s, [, c]) => s + c, 0);
    const share = all / cc.toolCalls;
    if (share !== metrics.inspectionShare) {
      neutral.inspectionShare = share;
      applied.push(`spec 4.4 departure 2 (inspection share over ALL tools): TheOne counts Read/Grep/Glob only within its top-8 tool list -> ${metrics.inspectionShare}; over all tools ${share}`);
    }
  }
  if (!cc) {
    // Not tool-covered: TheOne, with no transcripts, has no compaction count;
    // Watchtower's comes from PreCompact hook rows, which do not depend on
    // transcript coverage (spec 4.4 gives the part no dagger).
    neutral.realCompactions = compacts.length;
    applied.push(`spec 4.4 departure 3 (real compactions from PreCompact hook events): measured without transcript coverage here (${compacts.length}); TheOne without transcripts has no compaction part`);
  }
  const adj = UP.calculateUsageProfile(neutral);

  // ---- compare -------------------------------------------------------------------
  const lines = [];
  const tierIdx = TIER_ID[PR.tierForScore(hyg.score).id];
  const next = PR.pointsToNextTier(hyg.score, PR.tierForScore(hyg.score).id);
  const f = Object.fromEntries(hyg.factors.map((x) => [x.key, x.score]));
  const matrixOk =
    p.matrix_score === hyg.score && p.matrix_tier === tierIdx && p.matrix_points_to_next === (next ? next.points : null) &&
    Object.entries(FACTOR).every(([k, col]) => p[col] === f[k]);
  if (!matrixOk) problems.push("Matrix score / factors / tier differ");
  lines.push(`Matrix score   ours ${p.matrix_score}  TheOne ${hyg.score}   tier ${p.matrix_tier}/${tierIdx}   points to next ${p.matrix_points_to_next}/${next ? next.points : null}   ${matrixOk ? "MATCH" : "MISMATCH"}`);
  lines.push(`  factors      ${Object.entries(FACTOR).map(([k, col]) => `${k} ${p[col]}/${f[k]}`).join("   ")}`);
  lines.push("");
  lines.push("  #  discipline        ours             TheOne (raw)     TheOne (departures applied)  verdict");
  let oursPorted = 0;
  let theirsPorted = 0;
  let adjPorted = 0;
  UP.AI_DISCIPLINES.forEach((def, i) => {
    const o = ours[def.id];
    const r = raw.disciplines.find((d) => d.id === def.id);
    const a = adj.disciplines.find((d) => d.id === def.id);
    const cell = (x) => `${String(x.score).padStart(2)} ${x.status}`.padEnd(17);
    let verdict;
    if (WATCHTOWER[def.id]) {
      verdict = `by design -- ${WATCHTOWER[def.id]}; not compared`;
    } else {
      oursPorted += o.score;
      theirsPorted += r.score;
      adjPorted += a.score;
      const exactRaw = o.score === r.score && o.status === r.status;
      const exactAdj = o.score === a.score && o.status === a.status;
      if (exactRaw) verdict = "MATCH";
      else if (exactAdj) verdict = "MATCH once departures applied (by design)";
      else {
        verdict = "MISMATCH";
        problems.push(`${def.id}: ours ${o.score} ${o.status}, TheOne ${r.score} ${r.status} (with departures ${a.score} ${a.status})`);
      }
    }
    lines.push(`  ${String(i + 1).padStart(2)} ${def.id.padEnd(17)} ${cell(o)}${cell(r)}${cell(a).padEnd(29)}${verdict}`);
  });
  lines.push(`     eight ported disciplines: ours ${oursPorted}, TheOne raw ${theirsPorted}, TheOne with departures applied ${adjPorted}`);
  lines.push(`     total: ours ${p.total} (${p.measured} of 10 measured, tier ${p.tier_index}); TheOne raw ${raw.totalScore} (tier ${raw.tierIndex}).` +
    ` The ten-way totals differ by the two Watchtower definitions${theirsPorted !== adjPorted ? " and the departures applied above" : ""}.`);

  // Inputs side by side, where TheOne has the same quantity.
  const ev = (id, k) => ours[id].evidence[k];
  const pairs = [
    ["requests", ev("output-quality", "requests"), records.length],
    ["success rate", ev("output-quality", "success"), successRate],
    ["models (distinct, excl. <synthetic>)", ev("model-routing", "models"), window.distinctModels],
    ["top model share, rounded %", ev("model-routing", "top_pct"), window.modelMix[0]?.pct ?? null],
    ["cache : fresh ratio", p.cache_fresh_ratio, totalFresh > 0 ? totalCacheRead / totalFresh : 0],
    ["tool calls", ev("verification", "tool_calls"), cc ? cc.toolCalls : null],
    ["tool-error rate", ev("verification", "tool_error_rate"), cc ? cc.toolErrorRate : null],
    ["inspection share", ev("verification", "inspect_share"), metrics.inspectionShare ?? null],
    ["MCP calls", ev("automation", "mcp_calls"), cc ? cc.mcpCalls : null],
    ["MCP servers", ev("reuse", "mcp_servers"), cc ? cc.mcpServers.length : null],
    ["slash kinds", ev("prompt-hygiene", "slash_kinds"), cc ? cc.slashCommands.length : null],
    ["slash max repeat", ev("reuse", "slash_max_repeat"), metrics.slashCommandMaxRepeat ?? null],
    ["compactions", ev("session-hygiene", "compactions"), cc ? cc.compactions : null],
  ];
  lines.push("");
  lines.push("  inputs          ours (evidence)          TheOne");
  const notes = [];
  for (const [name, o, t] of pairs) {
    const same = o === t || (typeof o === "number" && typeof t === "number" && Math.abs(o - t) < 1e-12);
    lines.push(`    ${name.padEnd(38)} ${String(o).padEnd(22)} ${String(t).padEnd(22)} ${same ? "=" : "differs"}`);
    if (!same && name === "slash kinds" && o > 8 && t === 8) {
      notes.push(`slash kinds ${o} vs 8: TheOne's activity window keeps only its top-8 command list; score-neutral (clamp(k x 20) is 100 for any k >= 5)`);
    } else if (!same && name === "tool-error rate" && t === 0 && o === null) {
      notes.push("tool-error rate: spec 4.4 departure 1 (see above)");
    } else if (!same && name === "inspection share") {
      notes.push("inspection share: spec 4.4 departure 2 (see above)");
    } else if (!same && ["tool calls", "tool-error rate", "MCP calls", "MCP servers", "slash kinds", "slash max repeat", "compactions"].includes(name) && !cc) {
      notes.push(`${name}: window not tool-covered (spec 3.3) -- TheOne gets no activity data`);
    } else if (!same) {
      problems.push(`input ${name}: ours ${o}, TheOne ${t}`);
    }
  }
  notes.push(`cost per session: ours ${ev("cost-discipline", "cost_per_session")} (status line, MAX per session) -- evidence only; TheOne's is ccflare's per-request estimate, which Watchtower does not have. Not a score input.`);
  return { day, lo, p, lines, applied, notes, problems: [...new Set(problems)] };
}

// ---- run -----------------------------------------------------------------------
console.log(`theone-lockstep: ${DB}`);
console.log(`TheOne source:    ${THEONE_ROOT} (git ${(() => {
  try { return execFileSync("git", ["-C", THEONE_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "?"; }
})()}), unmodified`);
console.log(`local TZ:         ${Intl.DateTimeFormat().resolvedOptions().timeZone}   ungated days in copy: ${days.length} (${days[0]} .. ${latest})`);
console.log("");

let bad = 0;
const summaryRows = [];
for (const day of toCheck) {
  const r = checkDay(day);
  const ok = r.problems.length === 0;
  if (!ok) bad += 1;
  summaryRows.push(`  ${day}  requests ${String(r.p.window_requests).padStart(5)}  covered ${r.p.tool_covered}  Matrix ${String(r.p.matrix_score).padStart(3)}  total ${String(r.p.total).padStart(3)}  departures ${r.applied.length}  ${ok ? "MATCH" : "MISMATCH"}`);
  if (!ALL || !ok || day === latest) {
    console.log(`== ${day}   window ${r.lo} .. ${day}   ${r.p.window_requests} requests   tool_covered ${r.p.tool_covered}`);
    for (const l of r.lines) console.log(l);
    console.log("");
    console.log(r.applied.length ? "  departures applied:" : "  departures applied: none (TheOne's raw output is compared directly)");
    for (const a of r.applied) console.log(`    - ${a}`);
    console.log("  notes:");
    for (const n of r.notes) console.log(`    - ${n}`);
    if (!ok) for (const pr of r.problems) console.log(`  !! ${pr}`);
    console.log("");
  }
}
if (ALL) {
  console.log("== every ungated day");
  for (const s of summaryRows) console.log(s);
  console.log("");
}
console.log(bad === 0
  ? `RESULT: MATCH -- Matrix score, 4 factors, tier and disciplines 1-6, 8, 10 on ${toCheck.length} day(s)`
  : `RESULT: MISMATCH on ${bad} of ${toCheck.length} day(s)`);
process.exit(bad === 0 ? 0 : 1);
