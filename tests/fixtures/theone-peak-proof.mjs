#!/usr/bin/env node
// theone-peak-proof.mjs -- Stage 4B Task 4's numeric proof against TheOne
// (spec 4B §7): the peak-context lockstep.
//
// Watchtower's rollup stopped COALESCE-ing a session's peak context to 0 when
// it has no status-line snapshot, and TheOne's lib/claude-hours moved with it.
// This runs BOTH TheOne checkouts -- before (main) and after (the lockstep
// branch) -- on the same DB copy this branch's rollup has processed, and
// checks the three things the change must and must not do. Run by hand, never
// by `npm test` (vitest collects *.test.ts only):
//
//   node tests/fixtures/theone-peak-proof.mjs <db-copy> [--all]
//
//   <db-copy>    a `sqlite3 .backup` COPY this branch's rollup.sh has run over,
//                in the same TZ as this run (both bucket by LOCAL day). -readonly.
//   --all        every day in the copy, not only TheOne's 30-day span ending now:
//                slides TheOne's `now` back 30 calendar days at a time. A day's
//                daily[] and contextTrend[] entries depend only on that day's
//                rows, never on `now`, so every window gives the same values.
//   THEONE_BEFORE a TheOneOS checkout at main   (default: sibling TheOneOS-4b-before)
//   THEONE_AFTER  the lockstep checkout          (default: sibling TheOneOS-4b)
//
// For each checkout the script extracts PER_SESSION_SQL from that checkout's
// hours.ts SOURCE TEXT, runs it with `sqlite3 -readonly -json`, and feeds the
// rows to that checkout's own buildClaudeHours(rows, now). Nothing of TheOne's
// is modified or reimplemented here. The loader is theone-lockstep.mjs's
// node:module hook, taught two roots: an "@/" import resolves inside the
// checkout its importer lives in.
//
// Checks:
//   (a) after's contextTrend[].peakCtx equals Watchtower's peak_context_pct on
//       every day both have, and is null exactly where Watchtower's is NULL;
//   (b) before and after daily[].hygiene are identical on every day with a peak;
//   (c) daily[].totalMs and activeMs are identical before and after.
// Exit 0 when all three hold on every day checked; 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIBLING = (name) => path.resolve(HERE, "..", "..", "..", name);
const ROOTS = {
  before: path.resolve(process.env.THEONE_BEFORE ?? SIBLING("TheOneOS-4b-before")),
  after: path.resolve(process.env.THEONE_AFTER ?? SIBLING("TheOneOS-4b")),
};

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith("--"));
const ALL = args.includes("--all");
if (!DB || !existsSync(DB)) {
  console.error("usage: node tests/fixtures/theone-peak-proof.mjs <db-copy> [--all]");
  process.exit(2);
}
for (const [side, root] of Object.entries(ROOTS)) {
  if (!existsSync(path.join(root, "lib", "claude-hours", "hours.ts"))) {
    console.error(`theone-peak-proof: no TheOneOS checkout for "${side}" at ${root} (set THEONE_${side.toUpperCase()})`);
    process.exit(2);
  }
}

// ---- load each checkout's buildClaudeHours -------------------------------------
// theone-lockstep.mjs's hook, with the root chosen by the importer's URL. The
// claude-hours builder imports no server module today; "server-only" is still
// stubbed (throwing if called) so a future import fails loudly, not silently.
const STUBS = { "server-only": [] };
const HOOKS = `
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
let roots, stubs;
export async function initialize(data) { roots = data.roots; stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(stubs, specifier)) return { url: "wt-stub:" + specifier, shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : "";
    const root = roots.find((r) => parent.startsWith(r + "/"));
    if (!root) throw new Error("theone-peak-proof: " + specifier + " imported from outside both roots: " + parent);
    const base = root + "/" + specifier.slice(2);
    for (const f of [base + ".ts", base + "/index.ts"]) {
      if (existsSync(f)) return { url: pathToFileURL(f).href, shortCircuit: true };
    }
    throw new Error("theone-peak-proof: cannot resolve " + specifier + " in " + root);
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("wt-stub:")) {
    const spec = url.slice("wt-stub:".length);
    const src = stubs[spec].map((n) =>
      "export function " + n + "() { throw new Error('theone-peak-proof: stubbed " + spec + "#" + n + " was called'); }"
    ).join("\\n");
    return { format: "module", source: src || "export {};", shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")), shortCircuit: true };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, { data: { roots: Object.values(ROOTS), stubs: STUBS } });

function q(sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", DB, sql], { encoding: "utf8", maxBuffer: 1 << 28 });
  return out.trim() === "" ? [] : JSON.parse(out);
}
const gitHead = (root) => {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "?"; }
};

const side = {};
for (const [name, root] of Object.entries(ROOTS)) {
  const src = readFileSync(path.join(root, "lib", "claude-hours", "hours.ts"), "utf8");
  const m = src.match(/const PER_SESSION_SQL = `([^`]*)`;/);
  if (!m) throw new Error(`theone-peak-proof: no PER_SESSION_SQL template in ${name}'s hours.ts`);
  if (m[1].includes("${")) throw new Error(`theone-peak-proof: ${name}'s PER_SESSION_SQL interpolates; run it through TheOne instead`);
  const { buildClaudeHours } = await import(pathToFileURL(path.join(root, "lib", "claude-hours", "build.ts")).href);
  side[name] = { root, head: gitHead(root), rows: q(m[1]), build: buildClaudeHours, coalesced: /COALESCE\(c\.peakctx/.test(m[1]) };
}

// ---- Watchtower's side -----------------------------------------------------------
const wt = new Map(
  q("SELECT day, sessions_count, peak_context_pct, hygiene_score FROM claude_daily_rollups ORDER BY day;").map((r) => [r.day, r]),
);
if (wt.size === 0) {
  console.error("theone-peak-proof: claude_daily_rollups is empty (has the rollup run?)");
  process.exit(2);
}
const wtDays = [...wt.keys()];

// ---- TheOne's windows --------------------------------------------------------------
// `now` for a window ending on local day D is D at local noon; the live span
// ends at the real Date.now().
const noon = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d, 12).getTime(); };
const back30 = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y, m - 1, d - 30, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const nows = [Date.now()];
if (ALL) for (let end = wtDays[wtDays.length - 1]; end >= wtDays[0]; end = back30(end)) nows.push(noon(end));

/** day -> { before: {daily, trend}, after: {daily, trend} }, from every window. */
const byDay = new Map();
let liveSpan = null;
for (const now of nows) {
  const res = {};
  for (const name of ["before", "after"]) res[name] = side[name].build(side[name].rows, now);
  if (!liveSpan) liveSpan = res.after.daily.map((d) => d.day);
  res.after.daily.forEach((d, i) => {
    const e = {
      before: { daily: res.before.daily[i], trend: res.before.contextTrend[i] },
      after: { daily: d, trend: res.after.contextTrend[i] },
    };
    if (e.before.daily.day !== d.day || e.after.trend.day !== d.day || e.before.trend.day !== d.day) {
      throw new Error(`theone-peak-proof: window arrays misaligned at ${d.day}`);
    }
    const prev = byDay.get(d.day);
    if (prev && JSON.stringify(prev) !== JSON.stringify(e)) throw new Error(`theone-peak-proof: ${d.day} differs between two windows`);
    byDay.set(d.day, e);
  });
}

// ---- checks ---------------------------------------------------------------------------
const problems = { a: [], b: [], c: [] };
let aBoth = 0, aNull = 0, aTheOneOnly = 0, bChecked = 0, cChecked = 0;
const hygieneMoved = [];
for (const [day, e] of [...byDay].sort(([x], [y]) => (x < y ? -1 : 1))) {
  const w = wt.get(day);
  const peak = e.after.trend.peakCtx;
  // (a)
  if (w) {
    aBoth += 1;
    if (w.peak_context_pct === null) {
      aNull += 1;
      if (peak !== null) problems.a.push(`${day}: Watchtower NULL, TheOne after ${peak}`);
    } else if (peak !== w.peak_context_pct) {
      problems.a.push(`${day}: Watchtower ${w.peak_context_pct}, TheOne after ${peak}`);
    }
  } else if (peak !== null) {
    aTheOneOnly += 1;
    problems.a.push(`${day}: no Watchtower row, TheOne after ${peak}`);
  }
  // (b)
  if (peak !== null) {
    bChecked += 1;
    if (!Object.is(e.before.daily.hygiene, e.after.daily.hygiene)) {
      problems.b.push(`${day}: peak ${peak}, hygiene before ${e.before.daily.hygiene}, after ${e.after.daily.hygiene}`);
    }
  } else if (!Object.is(e.before.daily.hygiene, e.after.daily.hygiene)) {
    hygieneMoved.push({ day, e, w });
  }
  // (c)
  cChecked += 1;
  for (const k of ["totalMs", "activeMs"]) {
    if (e.before.daily[k] !== e.after.daily[k]) problems.c.push(`${day}: ${k} before ${e.before.daily[k]}, after ${e.after.daily[k]}`);
  }
}
const wtUncovered = wtDays.filter((d) => !byDay.has(d));

// ---- report -------------------------------------------------------------------------------
const fmt = (x) => (x === null || x === undefined ? "null" : String(x));
console.log(`theone-peak-proof: ${DB}`);
for (const [name, s] of Object.entries(side)) {
  console.log(`TheOne ${name.padEnd(6)}  ${s.root} (git ${s.head}), ${s.rows.length} session rows, PER_SESSION_SQL ${s.coalesced ? "COALESCEs" : "does not COALESCE"} the peak`);
}
console.log(`local TZ:           ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
console.log(`Watchtower days:    ${wt.size} (${wtDays[0]} .. ${wtDays[wtDays.length - 1]}); with a NULL peak: ${[...wt.values()].filter((r) => r.peak_context_pct === null).length}` +
  ` (${[...wt.values()].filter((r) => r.peak_context_pct === null && r.sessions_count > 0).length} of them with sessions)`);
console.log(`TheOne days seen:   ${byDay.size} across ${nows.length} window(s)${ALL ? "" : " (live span only; --all for every day)"}` +
  (ALL ? `; Watchtower days outside every window: ${wtUncovered.length ? wtUncovered.join(", ") : "none"}` : ""));
console.log("");
console.log(`== TheOne's 30-day span ending now (${liveSpan[0]} .. ${liveSpan[liveSpan.length - 1]})`);
console.log("   day         WT peak             after peakCtx       before peakCtx  hygiene before       hygiene after        totalMs      activeMs");
for (const day of liveSpan) {
  const e = byDay.get(day);
  const w = wt.get(day);
  console.log(`   ${day}  ${fmt(w ? w.peak_context_pct : "(no row)").padEnd(19)} ${fmt(e.after.trend.peakCtx).padEnd(19)} ${fmt(e.before.trend.peakCtx).padEnd(15)} ` +
    `${fmt(e.before.daily.hygiene).padEnd(20)} ${fmt(e.after.daily.hygiene).padEnd(20)} ${String(e.after.daily.totalMs).padEnd(12)} ${e.after.daily.activeMs}`);
}
console.log("");
console.log(`== days whose TheOne hygiene moved (every one has no peak): ${hygieneMoved.length}`);
for (const { day, e, w } of hygieneMoved) {
  console.log(`   ${day}  before peakCtx ${fmt(e.before.trend.peakCtx)} -> after ${fmt(e.after.trend.peakCtx)}   hygiene ${e.before.daily.hygiene} -> ${e.after.daily.hygiene}` +
    `   (Watchtower: sessions ${w ? w.sessions_count : "-"}, peak ${w ? fmt(w.peak_context_pct) : "-"}, hygiene ${w ? w.hygiene_score : "-"})`);
}
console.log("");
const verdict = (k, text) => console.log(`(${k}) ${problems[k].length === 0 ? "PASS" : "FAIL"}  ${text}`);
verdict("a", `after's peakCtx = Watchtower's peak_context_pct on all ${aBoth} days both have (${aNull} of them NULL on both sides); TheOne-only days with a peak: ${aTheOneOnly}`);
for (const p of problems.a) console.log(`    !! ${p}`);
verdict("b", `before and after hygiene identical on all ${bChecked} days with a peak`);
for (const p of problems.b) console.log(`    !! ${p}`);
verdict("c", `totalMs and activeMs identical before and after on all ${cChecked} days`);
for (const p of problems.c) console.log(`    !! ${p}`);
const bad = problems.a.length + problems.b.length + problems.c.length + (ALL ? wtUncovered.length : 0);
console.log("");
console.log(bad === 0 ? "RESULT: PASS -- (a), (b) and (c) hold on every day checked" : "RESULT: FAIL");
process.exit(bad === 0 ? 0 : 1);
