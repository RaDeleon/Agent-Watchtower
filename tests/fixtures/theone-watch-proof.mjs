#!/usr/bin/env node
// theone-watch-proof.mjs -- the numeric proof for TheOneOS's retire-claude-watch
// spec §7.3: the Claude Code tab's Watchtower readers equal Watchtower's own.
//
// Run by hand, never by `npm test` (vitest collects *.test.ts only):
//
//   node tests/fixtures/theone-watch-proof.mjs <db-copy> [--all]
//
//   <db-copy>      a `sqlite3 .backup` COPY that rollup.sh has run over, in this TZ
//   --all          slide `now` back 30 days at a time to the first request day
//   THEONE_BEFORE  TheOneOS checkout at main (default ../.worktrees/theoneos-main-proof)
//   THEONE_AFTER   the retire-claude-watch checkout (default ../.worktrees/theoneos-retire-claude-watch)
//
// The branch's SQL constants are read from SOURCE TEXT and run with
// `sqlite3 -readonly -json`. The rows go to the branch's own builders, loaded
// with node's type stripping. Nothing of TheOneOS's is reimplemented.
//
// Checks:
//   (a) 7d and 30d: every model's cost at API prices (usd within 1e-9 relative, priced,
//       unpriced), requests (= priced + unpriced), share, response n/median/p90 and
//       median tok/s equal Watchtower's readPerformance on the same range;
//   (b) Today: the same per-model figures (share aside) equal latencyByModel and
//       API_COST_SQL restricted to day = today;
//   (c) every day bucket's four token counters equal claude_daily_rollups exactly, and
//       its cost equals cost_table_usd / priced_requests / unpriced_requests; a day with
//       no rollup row is an all-zero bucket;
//   (d) the profile equals Watchtower's readProfile (day, ladder, Matrix, the ten cards
//       with their evidence), and every label string appears verbatim, in order, in
//       lib/render/profile.ts;
//   (e) nothing moved: the Hours payload (buildClaudeHours) on the branch is deep-equal
//       to main's on the same copy.
// Exit 0 when every check holds at every `now`; 1 otherwise; 2 on bad usage.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SIBLING = (rel) => path.resolve(REPO, "..", rel);
const ROOTS = {
  before: path.resolve(process.env.THEONE_BEFORE ?? SIBLING(".worktrees/theoneos-main-proof")),
  after: path.resolve(process.env.THEONE_AFTER ?? SIBLING(".worktrees/theoneos-retire-claude-watch")),
};
const EPS = 1e-9;
const DAY = 86400;

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith("--"));
const ALL = args.includes("--all");
if (!DB || !existsSync(DB)) {
  console.error("usage: node tests/fixtures/theone-watch-proof.mjs <db-copy> [--all]");
  process.exit(2);
}
if (!existsSync(path.join(ROOTS.after, "lib", "watchtower", "requests.ts"))) {
  console.error(`theone-watch-proof: no retire-claude-watch checkout at ${ROOTS.after} (set THEONE_AFTER)`);
  process.exit(2);
}
if (!existsSync(path.join(ROOTS.before, "lib", "claude-hours", "hours.ts"))) {
  console.error(`theone-watch-proof: no TheOneOS main checkout at ${ROOTS.before} (set THEONE_BEFORE)`);
  process.exit(2);
}

// theone-token-proof.mjs's loader: "@/" resolves inside the importer's own
// checkout; "server-only" is stubbed; every .ts is type-stripped.
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
    if (!root) throw new Error("theone-watch-proof: " + specifier + " imported from outside both roots: " + parent);
    const base = root + "/" + specifier.slice(2);
    for (const f of [base + ".ts", base + "/index.ts"]) {
      if (existsSync(f)) return { url: pathToFileURL(f).href, shortCircuit: true };
    }
    throw new Error("theone-watch-proof: cannot resolve " + specifier + " in " + root);
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("wt-stub:")) return { format: "module", source: "export {};", shortCircuit: true };
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
/** Substitute `:name` parameters with SQL literals (numbers bare, strings quoted). */
function bind(sql, params) {
  return sql.replace(/:([a-z][a-z0-9_]*)/gi, (_, k) => {
    if (!(k in params)) throw new Error(`theone-watch-proof: no value for :${k}`);
    const v = params[k];
    return typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
  });
}
function sqlConst(file, name) {
  const m = readFileSync(file, "utf8").match(new RegExp(`const ${name} = \`([^\`]*)\`;`));
  if (!m) throw new Error(`theone-watch-proof: no ${name} template in ${file}`);
  if (m[1].includes("${")) throw new Error(`theone-watch-proof: ${name} interpolates; the proof needs it verbatim`);
  return m[1];
}
const close = (a, b) =>
  a === b ||
  (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)));
const gitHead = (root) => {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "?"; }
};

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 40) console.error("FAIL " + msg);
};

const A = ROOTS.after;
const RQ = path.join(A, "lib/watchtower/requests.ts");
const PF = path.join(A, "lib/watchtower/profile.ts");
const SQL = {
  BOUNDS: sqlConst(RQ, "BOUNDS_SQL"),
  REQUESTS: sqlConst(RQ, "REQUESTS_SQL"),
  CACHE: sqlConst(RQ, "CACHE_SQL"),
  PROFILE_DAY: sqlConst(PF, "PROFILE_DAY_SQL"),
  DISCIPLINES: sqlConst(PF, "DISCIPLINES_SQL"),
};
const req = await import(pathToFileURL(RQ).href);
const prof = await import(pathToFileURL(PF).href);
const labels = await import(pathToFileURL(path.join(A, "lib/watchtower/profile-labels.ts")).href);
const perf = await import(pathToFileURL(path.join(REPO, "lib/read/perf.ts")).href);
const wtProfile = await import(pathToFileURL(path.join(REPO, "lib/read/profile.ts")).href);

function statsAt(now) {
  const [bounds] = q(bind(SQL.BOUNDS, { now }));
  const span = { from: bounds.from30, to: bounds.today };
  const rows = q(bind(SQL.REQUESTS, span));
  const cache = q(bind(SQL.CACHE, span));
  // errors: [] -- API errors (ruling 7) have no per-range counterpart in perf.ts or profile.ts to prove against
  return req.buildStats({ bounds, rows, recent: [], errors: [], cache, dataThrough: null });
}

function checkModels(label, ours, theirs, withShare) {
  if (ours.length !== theirs.length) fail(`${label}: ${ours.length} models vs Watchtower's ${theirs.length}`);
  const byModel = new Map(ours.map((m) => [m.model, m]));
  for (const t of theirs) {
    const o = byModel.get(t.model);
    if (!o) { fail(`${label}: ${t.model} missing`); continue; }
    const tag = `${label} ${t.model}`;
    if (!close(o.cost.usd, t.cost.usd)) fail(`${tag}: usd ${o.cost.usd} vs ${t.cost.usd}`);
    if (o.cost.priced !== t.cost.priced || o.cost.unpriced !== t.cost.unpriced)
      fail(`${tag}: priced/unpriced ${o.cost.priced}/${o.cost.unpriced} vs ${t.cost.priced}/${t.cost.unpriced}`);
    if (o.requests !== t.cost.priced + t.cost.unpriced) fail(`${tag}: requests ${o.requests} vs ${t.cost.priced + t.cost.unpriced}`);
    if (withShare && !close(o.share, t.share)) fail(`${tag}: share ${o.share} vs ${t.share}`);
    if (!isDeepStrictEqual(o.response, t.response)) fail(`${tag}: response ${JSON.stringify(o.response)} vs ${JSON.stringify(t.response)}`);
    if (!close(o.tokPerSMedian, t.tokPerSMedian)) fail(`${tag}: tok/s ${o.tokPerSMedian} vs ${t.tokPerSMedian}`);
  }
}

const rollups = new Map(
  q(`SELECT day, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cost_table_usd,
            priced_requests, unpriced_requests FROM claude_daily_rollups;`).map((r) => [r.day, r])
);
const checkedDays = new Set();

function checkTraffic(stats) {
  for (const b of stats.ranges["30d"].buckets) {
    if (checkedDays.has(b.key)) continue;
    checkedDays.add(b.key);
    const r = rollups.get(b.key);
    const want = r
      ? { input: r.tokens_in, output: r.tokens_out, cacheRead: r.tokens_cache_read, cacheWrite: r.tokens_cache_creation }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (!isDeepStrictEqual(b.tokens, want)) fail(`(c) ${b.key}: tokens ${JSON.stringify(b.tokens)} vs rollup ${JSON.stringify(want)}`);
    const usd = r?.cost_table_usd ?? 0;
    if (!close(b.cost.usd, usd)) fail(`(c) ${b.key}: usd ${b.cost.usd} vs ${usd}`);
    if (b.cost.priced !== (r?.priced_requests ?? 0) || b.cost.unpriced !== (r?.unpriced_requests ?? 0))
      fail(`(c) ${b.key}: priced/unpriced ${b.cost.priced}/${b.cost.unpriced} vs ${r?.priced_requests ?? 0}/${r?.unpriced_requests ?? 0}`);
  }
}

function checkProfile(now) {
  const [day] = q(bind(SQL.PROFILE_DAY, { now }));
  const rows = day ? q(bind(SQL.DISCIPLINES, { day: day.day })) : [];
  const ours = prof.buildProfile(day, rows);
  const theirs = wtProfile.readProfile(DB, { now });
  const L = theirs.latest;
  if (L === null) {
    if (ours.state !== "none") fail(`(d) ${now}: Watchtower has no profile, ours is ${ours.state}`);
    return;
  }
  if (L.total === null) {
    if (ours.state !== "collecting" || ours.day !== L.day) fail(`(d) ${now}: Watchtower collecting on ${L.day}, ours ${ours.state}`);
    return;
  }
  if (ours.state !== "ok") { fail(`(d) ${now}: ours is ${ours.state}, Watchtower scored ${L.day}`); return; }
  const pairs = [
    ["day", ours.day, L.day],
    ["eventCovered", ours.eventCovered, theirs.eventCovered],
    ["total", ours.ladder.total, L.total],
    ["tierIndex", ours.ladder.tierIndex, L.tierIndex ?? 0],
    ["pointsToNext", ours.ladder.pointsToNext, L.tierPointsToNext],
    ["wow", ours.ladder.wow, L.totalWow],
    ["measured", ours.ladder.measured, L.measured],
    ["matrix", ours.matrix?.score ?? null, L.matrixScore],
    ["matrixTier", ours.matrix?.tier ?? null, L.matrixScore === null ? null : L.matrixTier ?? 0],
    ["matrixNext", ours.matrix?.pointsToNext ?? null, L.matrixScore === null ? null : L.matrixPointsToNext],
    ["matrix7d", ours.matrix?.sevenDay ?? null, L.matrixScore === null ? null : L.matrix7d],
    ["matrixWow", ours.matrix?.wow ?? null, L.matrixScore === null ? null : L.matrixWow],
  ];
  for (const [k, o, t] of pairs) if (o !== t) fail(`(d) ${L.day} ${k}: ${o} vs ${t}`);
  const oc = ours.disciplines.map((d) => [d.id, d.score, d.status, d.definition, d.evidence]);
  // Watchtower keeps evidence as a record; TheOneOS shows it as [label, value] text. Only
  // TheOneOS's text rule is applied here (`_` -> space, null -> "—"), never its parsing.
  const evidenceText = (e) => Object.entries(e).map(([k, v]) => [k.replace(/_/g, " "), v === null ? "—" : String(v)]);
  const tc = theirs.disciplines.map((d) => [d.id, d.score, d.status, d.definition, evidenceText(d.evidence)]);
  if (!isDeepStrictEqual(oc, tc)) fail(`(d) ${L.day} cards: ${JSON.stringify(oc)} vs ${JSON.stringify(tc)}`);
}

// Watchtower's tables in lib/render/profile.ts are module-private consts, so
// they are matched in its SOURCE TEXT: each entry verbatim (label AND its
// description/blurb together), tiers in index order. Searching forward from the
// previous match matters: "Operator" is both ladder tier 3 and Matrix tier 1.
function checkLabels() {
  const src = readFileSync(path.join(REPO, "lib/render/profile.ts"), "utf8");
  const lit = (s) => JSON.stringify(s).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const key = (id) => (/^[a-z]+$/.test(id) ? `(?:${id}|"${id}")` : `"${id}"`);
  const endOf = (pattern, from) => {
    const re = new RegExp(pattern, "g");
    re.lastIndex = from;
    const m = re.exec(src);
    return m ? m.index + m[0].length : -1;
  };
  let pos = 0;
  for (const [i, t] of labels.LADDER_TIERS.entries()) {
    const end = endOf(`label: ${lit(t.label)},\\s*description:\\s*${lit(t.description)}`, pos);
    if (end < 0) fail(`(d) ladder tier ${i} (${t.label}) not verbatim, or out of order, in lib/render/profile.ts`);
    else pos = end;
  }
  for (const [i, t] of labels.MATRIX_TIERS.entries()) {
    const end = endOf(`name: ${lit(t.name)},\\s*blurb:\\s*${lit(t.blurb)}`, pos);
    if (end < 0) fail(`(d) Matrix tier ${i} (${t.name}) not verbatim, or out of order, in lib/render/profile.ts`);
    else pos = end;
  }
  for (const id of labels.DISCIPLINE_ORDER) {
    const m = labels.DISCIPLINE_META[id];
    if (endOf(`${key(id)}: \\{\\s*label: ${lit(m.label)},\\s*blurb:\\s*${lit(m.blurb)}`, 0) < 0)
      fail(`(d) discipline ${id} not verbatim in lib/render/profile.ts`);
  }
  for (const [id, text] of Object.entries(labels.STATUS_LABEL)) {
    if (endOf(`${key(id)}: ${lit(text)}`, 0) < 0) fail(`(d) status ${id} not verbatim in lib/render/profile.ts`);
  }
  if (endOf(`const COLLECTING_TEXT = ${lit(labels.COLLECTING_TEXT)};`, 0) < 0) fail("(d) COLLECTING_TEXT differs from Watchtower's");
}

async function hoursOf(root, nowMs) {
  const src = path.join(root, "lib/claude-hours/hours.ts");
  const build = await import(pathToFileURL(path.join(root, "lib/claude-hours/build.ts")).href);
  const rows = q(sqlConst(src, "PER_SESSION_SQL"));
  const text = readFileSync(src, "utf8");
  const tokenDays = text.includes("const PER_DAY_TOKENS_SQL") ? q(sqlConst(src, "PER_DAY_TOKENS_SQL")) : [];
  return build.buildClaudeHours(rows, nowMs, tokenDays);
}

const firstDay = q("SELECT MIN(day) AS d FROM claude_request_metrics;")[0]?.d ?? null;
const now0 = Math.floor(Date.now() / 1000);
const nows = [now0];
if (ALL && firstDay) {
  for (let n = now0 - 30 * DAY; q(`SELECT date(${n}, 'unixepoch', 'localtime') AS d;`)[0].d >= firstDay; n -= 30 * DAY) nows.push(n);
}

for (const now of nows) {
  const stats = statsAt(now);
  for (const range of ["7d", "30d"]) {
    checkModels(`(a) ${stats.today} ${range}`, stats.ranges[range].models, perf.readPerformance(DB, { now, range }).models, true);
  }
  const where = `day = '${stats.today}' AND priced IS NOT NULL`;
  const costs = q(`SELECT ${perf.MODEL_KEY_SQL} AS model, ${perf.API_COST_SQL} FROM claude_request_metrics WHERE ${where} GROUP BY 1;`);
  const lat = perf.latencyByModel(DB, where);
  const todayTheirs = costs.map((r) => {
    const l = lat.get(r.model) ?? perf.NO_LATENCY;
    return { model: r.model, cost: perf.apiCostOf(r), share: null, response: l.response, tokPerSMedian: l.tokPerSMedian };
  });
  checkModels(`(b) ${stats.today} today`, stats.ranges.today.models, todayTheirs, false);
  checkTraffic(stats);
  checkProfile(now);
  const nowMs = now * 1000;
  const [before, after] = [await hoursOf(ROOTS.before, nowMs), await hoursOf(ROOTS.after, nowMs)];
  if (!isDeepStrictEqual(before, after)) fail(`(e) ${stats.today}: the Hours payload moved between main and the branch`);
}
checkLabels();

console.log(
  `theone-watch-proof: before ${gitHead(ROOTS.before)}, after ${gitHead(ROOTS.after)}; ` +
    `${nows.length} now(s), ${checkedDays.size} day buckets; ${failures === 0 ? "ALL CHECKS HOLD" : `${failures} FAILURE(S)`}`
);
process.exit(failures === 0 ? 0 : 1);
