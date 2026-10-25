#!/usr/bin/env node
// theone-token-proof.mjs -- the numeric proof for Stage 2 spec §7 step 7:
// TheOne's lib/claude-hours takes tokens from claude_requests, not snapshots.
//
// TheOne used to read a session's tokens from its LAST status-line snapshot,
// which only ever sees context-window occupancy -- the defect Stage 2 exists to
// fix. The token-source branch reads them per local day from claude_requests
// with PER_DAY_TOKENS_SQL (Watchtower's _dtok, verbatim), and hygiene's cache
// term with them. This runs BOTH TheOne checkouts -- before (main) and after
// (the token-source branch) -- on the same DB copy Watchtower's rollup has
// processed. Run by hand, never by `npm test` (vitest collects *.test.ts only):
//
//   node tests/fixtures/theone-token-proof.mjs <db-copy> [--all]
//
//   <db-copy>    a `sqlite3 .backup` COPY rollup.sh has run over, in the same TZ
//                as this run (both bucket by LOCAL day). Opened -readonly.
//   --all        every day in the copy, not only TheOne's 30-day span ending now:
//                slides TheOne's `now` back 30 calendar days at a time. A day's
//                daily[] entry depends only on that day's rows, never on `now`.
//   THEONE_BEFORE a TheOneOS checkout at main    (default: sibling TheOneOS-step7-before)
//   THEONE_AFTER  the token-source checkout      (default: sibling TheOneOS-step7)
//
// For each checkout the script extracts PER_SESSION_SQL (and, for after,
// PER_DAY_TOKENS_SQL) from that checkout's hours.ts SOURCE TEXT, runs it with
// `sqlite3 -readonly -json`, and feeds the rows to that checkout's own
// buildClaudeHours. Nothing of TheOne's is modified or reimplemented here. The
// loader is theone-peak-proof.mjs's two-root node:module hook.
//
// Checks:
//   (a) after's daily[].tokensIn/tokensOut equal claude_daily_rollups.tokens_in/
//       tokens_out on every day, and are 0 on a day with no rollup row;
//   (b) after's daily[].hygiene equals hygiene_score (|diff| <= 1e-9, NaN fails) on
//       every day with sessions, and is 0 on a day without;|diff| <= 1e-9) on every
//       day with sessions, and is 0 on a day without;
//   (c) after's 30-day tokens card equals the rollup's sums over the same 30
//       days, and its lifetime card equals the sums over every day -- all four
//       counters exactly, cache-hit within 1e-9;
//   (d) nothing else moved: before and after are deep-equal in every window
//       once the token fields, hygiene and what hygiene feeds (xp) are set
//       aside. Hours, rank, cost, context, repos, models, streak all identical.
// Exit 0 when all four hold on every day and window checked; 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIBLING = (name) => path.resolve(HERE, "..", "..", "..", name);
const ROOTS = {
  before: path.resolve(process.env.THEONE_BEFORE ?? SIBLING("TheOneOS-step7-before")),
  after: path.resolve(process.env.THEONE_AFTER ?? SIBLING("TheOneOS-step7")),
};
const EPS = 1e-9;

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith("--"));
const ALL = args.includes("--all");
if (!DB || !existsSync(DB)) {
  console.error("usage: node tests/fixtures/theone-token-proof.mjs <db-copy> [--all]");
  process.exit(2);
}
for (const [side, root] of Object.entries(ROOTS)) {
  if (!existsSync(path.join(root, "lib", "claude-hours", "hours.ts"))) {
    console.error(`theone-token-proof: no TheOneOS checkout for "${side}" at ${root} (set THEONE_${side.toUpperCase()})`);
    process.exit(2);
  }
}

// ---- load each checkout's buildClaudeHours -------------------------------------
// theone-peak-proof.mjs's hook: an "@/" import resolves inside the checkout its
// importer lives in; "server-only" is stubbed (throwing if called).
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
    if (!root) throw new Error("theone-token-proof: " + specifier + " imported from outside both roots: " + parent);
    const base = root + "/" + specifier.slice(2);
    for (const f of [base + ".ts", base + "/index.ts"]) {
      if (existsSync(f)) return { url: pathToFileURL(f).href, shortCircuit: true };
    }
    throw new Error("theone-token-proof: cannot resolve " + specifier + " in " + root);
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("wt-stub:")) {
    const spec = url.slice("wt-stub:".length);
    const src = stubs[spec].map((n) =>
      "export function " + n + "() { throw new Error('theone-token-proof: stubbed " + spec + "#" + n + " was called'); }"
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
function sqlConst(src, name, side, required) {
  const m = src.match(new RegExp(`const ${name} = \`([^\`]*)\`;`));
  if (!m) {
    if (required) throw new Error(`theone-token-proof: no ${name} template in ${side}'s hours.ts`);
    return null;
  }
  if (m[1].includes("${")) throw new Error(`theone-token-proof: ${side}'s ${name} interpolates; run it through TheOne instead`);
  return m[1];
}

const side = {};
for (const [name, root] of Object.entries(ROOTS)) {
  const src = readFileSync(path.join(root, "lib", "claude-hours", "hours.ts"), "utf8");
  const perSession = sqlConst(src, "PER_SESSION_SQL", name, true);
  const perDayTokens = sqlConst(src, "PER_DAY_TOKENS_SQL", name, name === "after");
  const { buildClaudeHours } = await import(pathToFileURL(path.join(root, "lib", "claude-hours", "build.ts")).href);
  side[name] = {
    root, head: gitHead(root), build: buildClaudeHours,
    rows: q(perSession),
    tokenDays: perDayTokens === null ? null : q(perDayTokens),
    snapshotTokens: /\btin\b/.test(perSession),
  };
}
if (side.after.snapshotTokens) throw new Error("theone-token-proof: after's PER_SESSION_SQL still selects tin -- is THEONE_AFTER the token-source branch?");
const run = (name, now) => (side[name].tokenDays === null
  ? side[name].build(side[name].rows, now)
  : side[name].build(side[name].rows, now, side[name].tokenDays));

// ---- Watchtower's side -----------------------------------------------------------
const wt = new Map(
  q(`SELECT day, sessions_count, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, hygiene_score
     FROM claude_daily_rollups ORDER BY day;`).map((r) => [r.day, r]),
);
if (wt.size === 0) {
  console.error("theone-token-proof: claude_daily_rollups is empty (has the rollup run?)");
  process.exit(2);
}
const wtDays = [...wt.keys()];
const rank = q("SELECT lifetime_tokens_in, lifetime_tokens_out, hygiene_score, rank_name FROM claude_rank_progress WHERE id = 1;")[0] ?? null;
const sumOver = (days) => {
  const s = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const d of days) {
    const w = wt.get(d);
    if (!w) continue;
    s.input += w.tokens_in; s.output += w.tokens_out; s.cacheRead += w.tokens_cache_read; s.cacheCreation += w.tokens_cache_creation;
  }
  s.cacheHitPct = s.cacheRead + s.cacheCreation > 0 ? (100 * s.cacheRead) / (s.cacheRead + s.cacheCreation) : 0;
  return s;
};
const lifeWt = sumOver(wtDays);

// ---- TheOne's windows --------------------------------------------------------------
const noon = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d, 12).getTime(); };
const back30 = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y, m - 1, d - 30, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const nows = [Date.now()];
if (ALL) for (let end = wtDays[wtDays.length - 1]; end >= wtDays[0]; end = back30(end)) nows.push(noon(end));

const problems = { a: [], b: [], c: [], d: [] };
/** day -> { before: DailyPoint, after: DailyPoint }, from every window. */
const byDay = new Map();
let live = null;
const MOVES = ["tokens", "lifetimeTokens", "hygiene", "xp", "daily"];
const DAILY_MOVES = ["tokensIn", "tokensOut", "hygiene"];
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const close = (x, y) => Math.abs(x - y) <= EPS;

for (const now of nows) {
  const res = { before: run("before", now), after: run("after", now) };
  const span = res.after.daily.map((d) => d.day);
  if (!live) live = { now, res, span };
  const tag = new Date(now).toISOString().slice(0, 10);

  // (c) the two token cards
  for (const [card, want] of [["tokens", sumOver(span)], ["lifetimeTokens", lifeWt]]) {
    const got = res.after[card];
    for (const k of ["input", "output", "cacheRead", "cacheCreation"]) {
      if (got[k] !== want[k]) problems.c.push(`window ${tag} ${card}.${k}: TheOne ${got[k]}, Watchtower ${want[k]}`);
    }
    if (!close(got.cacheHitPct, want.cacheHitPct)) problems.c.push(`window ${tag} ${card}.cacheHitPct: TheOne ${got.cacheHitPct}, Watchtower ${want.cacheHitPct}`);
  }

  // (d) everything outside the token path, whole-object
  if (!isDeepStrictEqual(omit(res.before, MOVES), omit(res.after, MOVES))) {
    for (const k of Object.keys(omit(res.after, MOVES))) {
      if (!isDeepStrictEqual(res.before[k], res.after[k])) problems.d.push(`window ${tag}: ${k} differs`);
    }
  }
  if (res.before.daily.length !== res.after.daily.length) problems.d.push(`window ${tag}: daily length ${res.before.daily.length} vs ${res.after.daily.length}`);

  res.after.daily.forEach((d, i) => {
    const b = res.before.daily[i];
    if (!b || b.day !== d.day) throw new Error(`theone-token-proof: window arrays misaligned at ${d.day}`);
    if (!isDeepStrictEqual(omit(b, DAILY_MOVES), omit(d, DAILY_MOVES))) problems.d.push(`${d.day}: a daily field outside tokens/hygiene differs`);
    const e = { before: b, after: d };
    const prev = byDay.get(d.day);
    if (prev && !isDeepStrictEqual(prev, e)) throw new Error(`theone-token-proof: ${d.day} differs between two windows`);
    byDay.set(d.day, e);
  });
}

// ---- per-day checks -------------------------------------------------------------------
let aDays = 0, bDays = 0, bExact = 0, bMaxDiff = 0, bZero = 0;
const moved = [];
for (const [day, e] of [...byDay].sort(([x], [y]) => (x < y ? -1 : 1))) {
  const w = wt.get(day);
  const d = e.after;
  // (a)
  aDays += 1;
  const wantIn = w ? w.tokens_in : 0, wantOut = w ? w.tokens_out : 0;
  if (d.tokensIn !== wantIn || d.tokensOut !== wantOut) {
    problems.a.push(`${day}: TheOne ${d.tokensIn}/${d.tokensOut}, Watchtower ${w ? `${wantIn}/${wantOut}` : "(no row)"}`);
  }
  // (b)
  if (w && w.sessions_count > 0) {
    bDays += 1;
    const diff = Math.abs(d.hygiene - w.hygiene_score);
    if (diff === 0) bExact += 1;
    bMaxDiff = Math.max(bMaxDiff, diff);
    if (!(diff <= EPS)) problems.b.push(`${day}: TheOne ${d.hygiene}, Watchtower ${w.hygiene_score} (sessions ${w.sessions_count})`);
  } else {
    bZero += 1;
    if (d.hygiene !== 0) problems.b.push(`${day}: no sessions in Watchtower, TheOne hygiene ${d.hygiene}`);
  }
  if (e.before.hygiene !== d.hygiene) moved.push({ day, e, w });
}
const wtUncovered = wtDays.filter((d) => !byDay.has(d));

// ---- report -------------------------------------------------------------------------------
const fmt = (x) => (x === null || x === undefined ? "null" : typeof x === "number" && !Number.isInteger(x) ? x.toFixed(4) : String(x));
const n = (x) => x.toLocaleString("en-US");
console.log(`theone-token-proof: ${DB}`);
for (const [name, s] of Object.entries(side)) {
  console.log(`TheOne ${name.padEnd(6)}  ${s.root} (git ${s.head}), ${s.rows.length} session rows, ` +
    (s.tokenDays === null ? `tokens from ${s.snapshotTokens ? "snapshots (PER_SESSION_SQL)" : "?"}` : `${s.tokenDays.length} token days from PER_DAY_TOKENS_SQL`));
}
console.log(`local TZ:           ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
console.log(`Watchtower days:    ${wt.size} (${wtDays[0]} .. ${wtDays[wtDays.length - 1]}), ${[...wt.values()].filter((r) => r.sessions_count > 0).length} with sessions`);
console.log(`TheOne days seen:   ${byDay.size} across ${nows.length} window(s)${ALL ? "" : " (live span only; --all for every day)"}` +
  (ALL ? `; Watchtower days outside every window: ${wtUncovered.length ? wtUncovered.join(", ") : "none"}` : ""));
console.log("");
const { res, span } = live;
console.log(`== TheOne's 30-day span ending now (${span[0]} .. ${span[span.length - 1]})`);
console.log("   day         tokens in/out before       tokens in/out after        WT tokens in/out           hygiene before  after     WT hygiene");
for (const day of span) {
  const { before: b, after: a } = byDay.get(day);
  const w = wt.get(day);
  console.log(`   ${day}  ${`${n(b.tokensIn)}/${n(b.tokensOut)}`.padEnd(26)} ${`${n(a.tokensIn)}/${n(a.tokensOut)}`.padEnd(26)} ` +
    `${(w ? `${n(w.tokens_in)}/${n(w.tokens_out)}` : "(no row)").padEnd(26)} ${fmt(b.hygiene).padEnd(15)} ${fmt(a.hygiene).padEnd(9)} ${w ? fmt(w.hygiene_score) : "-"}`);
}
console.log("");
const card = (label, b, a, w) => console.log(`   ${label.padEnd(16)} before ${n(b)}  ->  after ${n(a)}   (Watchtower ${n(w)})`);
const mo = sumOver(span);
console.log("== 30-day tokens card");
card("input", res.before.tokens.input, res.after.tokens.input, mo.input);
card("output", res.before.tokens.output, res.after.tokens.output, mo.output);
card("cache read", res.before.tokens.cacheRead, res.after.tokens.cacheRead, mo.cacheRead);
card("cache creation", res.before.tokens.cacheCreation, res.after.tokens.cacheCreation, mo.cacheCreation);
console.log(`   cache hit %      before ${fmt(res.before.tokens.cacheHitPct)}  ->  after ${fmt(res.after.tokens.cacheHitPct)}   (Watchtower ${fmt(mo.cacheHitPct)})`);
console.log("== lifetime tokens card");
card("input", res.before.lifetimeTokens.input, res.after.lifetimeTokens.input, lifeWt.input);
card("output", res.before.lifetimeTokens.output, res.after.lifetimeTokens.output, lifeWt.output);
card("cache read", res.before.lifetimeTokens.cacheRead, res.after.lifetimeTokens.cacheRead, lifeWt.cacheRead);
card("cache creation", res.before.lifetimeTokens.cacheCreation, res.after.lifetimeTokens.cacheCreation, lifeWt.cacheCreation);
console.log(`   cache hit %      before ${fmt(res.before.lifetimeTokens.cacheHitPct)}  ->  after ${fmt(res.after.lifetimeTokens.cacheHitPct)}   (Watchtower ${fmt(lifeWt.cacheHitPct)})`);
if (rank) console.log(`   (claude_rank_progress lifetime_tokens_in/out: ${n(rank.lifetime_tokens_in)}/${n(rank.lifetime_tokens_out)})`);
console.log("== what hygiene feeds");
console.log(`   30-day hygiene   before ${fmt(res.before.hygiene.score)} (${res.before.hygiene.label})  ->  after ${fmt(res.after.hygiene.score)} (${res.after.hygiene.label})` +
  (rank ? `   (Watchtower rank hygiene ${fmt(rank.hygiene_score)})` : ""));
console.log(`   xp               before ${fmt(res.before.xp)}  ->  after ${fmt(res.after.xp)}`);
console.log(`   rank             before ${res.before.rank.name ?? JSON.stringify(res.before.rank)}  ->  after ${res.after.rank.name ?? JSON.stringify(res.after.rank)}` +
  (rank ? `   (Watchtower ${rank.rank_name})` : ""));
console.log("");
console.log(`== days whose TheOne hygiene moved: ${moved.length} of ${byDay.size}`);
console.log("");
const verdict = (k, text) => console.log(`(${k}) ${problems[k].length === 0 ? "PASS" : "FAIL"}  ${text}`);
const show = (k) => { for (const p of problems[k].slice(0, 20)) console.log(`    !! ${p}`); if (problems[k].length > 20) console.log(`    !! ... ${problems[k].length - 20} more`); };
verdict("a", `daily tokensIn/tokensOut = Watchtower tokens_in/tokens_out on all ${aDays} days`);
show("a");
verdict("b", `daily hygiene = hygiene_score on all ${bDays} days with sessions (${bExact} bit-identical, max |diff| ${bMaxDiff.toExponential(2)}); 0 on all ${bZero} days without`);
show("b");
verdict("c", `30-day and lifetime token cards = Watchtower's sums in all ${nows.length} window(s)`);
show("c");
verdict("d", `before and after deep-equal outside tokens, hygiene and xp in all ${nows.length} window(s)`);
show("d");
const bad = problems.a.length + problems.b.length + problems.c.length + problems.d.length + (ALL ? wtUncovered.length : 0);
console.log("");
console.log(bad === 0 ? "RESULT: PASS -- (a), (b), (c) and (d) hold on every day and window checked" : "RESULT: FAIL");
process.exit(bad === 0 ? 0 : 1);
