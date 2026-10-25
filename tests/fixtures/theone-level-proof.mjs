#!/usr/bin/env node
// theone-level-proof.mjs -- the numeric proof for TheOneOS's claude-hours-level change
// (Stage 5, Task 10): the Hours panel shows Watchtower's stored level, and TheOneOS
// computes none.
//
// Run by hand, never by `npm test` (vitest collects *.test.ts only):
//
//   node tests/fixtures/theone-level-proof.mjs <db-copy>
//
//   <db-copy>      a `sqlite3 .backup` COPY that the branch's rollup.sh has run over (schema v7)
//   THEONE_BEFORE  TheOneOS checkout at main (default ../TheOneOS, read-only)
//   THEONE_AFTER   the claude-hours-level checkout (default ../.worktrees/theoneos-claude-hours-level)
//
// The branch's own getClaudeCodeHours is loaded with node's type stripping and pointed at
// the copy with THEONE_DB_PATH. Nothing of TheOneOS's is reimplemented.
//
// Checks:
//   (a) hours.level deep-equals the copy's `agent_progress` row for source 'claude',
//       mapped as lib/claude-hours/hours.ts maps it;
//   (b) apart from level (branch) and rank, xp (main), the branch's payload is deep-equal
//       to main's on the same copy at the same `now`;
//   (c) no file under the branch's lib/claude-hours/ or the panel contains rankForHours,
//       CLAUDE_RANKS, 13034431 or 9000000: the level math lives only in rollup.sh.
// Exit 0 when every check holds; 1 otherwise; 2 on bad usage.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SIBLING = (rel) => path.resolve(REPO, "..", rel);
const ROOTS = {
  before: path.resolve(process.env.THEONE_BEFORE ?? SIBLING("TheOneOS")),
  after: path.resolve(process.env.THEONE_AFTER ?? SIBLING(".worktrees/theoneos-claude-hours-level")),
};

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith("--"));
if (!DB || !existsSync(DB)) {
  console.error("usage: node tests/fixtures/theone-level-proof.mjs <db-copy>");
  process.exit(2);
}
if (!existsSync(path.join(ROOTS.after, "lib", "claude-hours", "hours.ts"))) {
  console.error(`theone-level-proof: no claude-hours-level checkout at ${ROOTS.after} (set THEONE_AFTER)`);
  process.exit(2);
}
if (!existsSync(path.join(ROOTS.before, "lib", "claude-hours", "hours.ts"))) {
  console.error(`theone-level-proof: no TheOneOS main checkout at ${ROOTS.before} (set THEONE_BEFORE)`);
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
let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 40) console.error("FAIL " + msg);
};
const gitHead = (root) => {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "?"; }
};

process.env.THEONE_DB_PATH = path.resolve(DB);
const NOW = Date.now();
const load = async (root) => (await import(pathToFileURL(path.join(root, "lib/claude-hours/hours.ts")).href)).getClaudeCodeHours(NOW);
const after = await load(ROOTS.after);
const before = await load(ROOTS.before);
if (after.state !== "ok") fail(`branch getClaudeCodeHours state is ${after.state}, not ok`);
if (before.state !== "ok") fail(`main getClaudeCodeHours state is ${before.state}, not ok`);

// (a) the level is the stored row, mapped as hours.ts maps it
const rows = q(`SELECT active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
                FROM agent_progress WHERE source = 'claude';`);
let want;
if (rows.length === 0) want = { state: "pending" };
else {
  const r = rows[0];
  want = r.level === null || r.tier === null
    ? { state: "none", activeS: r.active_s }
    : { state: "level", level: r.level, tier: r.tier, xp: r.xp, xpIntoLevel: r.xp_into_level ?? 0,
        xpToNext: r.xp_to_next, sToNext: r.s_to_next, stars: r.stars ?? 0, activeS: r.active_s };
}
if (want.state === "pending") fail("(a) the copy has no agent_progress row for claude: roll it up with the branch's rollup.sh first");
if (after.state === "ok" && !isDeepStrictEqual(after.hours.level, want))
  fail(`(a) hours.level ${JSON.stringify(after.hours.level)} vs agent_progress ${JSON.stringify(want)}`);

// (b) nothing else moved
if (after.state === "ok" && before.state === "ok") {
  const { level, ...afterRest } = after.hours;
  const { rank, xp, ...beforeRest } = before.hours;
  if (level === undefined) fail("(b) the branch payload has no level");
  if (rank === undefined || xp === undefined) fail("(b) main's payload has no rank/xp to drop: is THEONE_BEFORE really main?");
  if ("rank" in afterRest || "xp" in afterRest) fail("(b) the branch payload still carries rank or xp");
  if (!isDeepStrictEqual(afterRest, beforeRest)) {
    const keys = Object.keys({ ...afterRest, ...beforeRest }).filter((k) => !isDeepStrictEqual(afterRest[k], beforeRest[k]));
    fail(`(b) the payload moved between main and the branch in: ${keys.join(", ")}`);
  }
}

// (c) no level math in TheOneOS
const NEEDLES = ["rankForHours", "CLAUDE_RANKS", "13034431", "9000000"];
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(path.join(ROOTS.after, "lib/claude-hours"));
files.push(path.join(ROOTS.after, "components/personal/ai-spend/claude-hours-panel.tsx"));
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const n of NEEDLES) if (text.includes(n)) fail(`(c) ${path.relative(ROOTS.after, f)} contains ${n}`);
}

console.log(`theone-level-proof: main@${gitHead(ROOTS.before)} vs branch@${gitHead(ROOTS.after)}; level ${JSON.stringify(after.state === "ok" ? after.hours.level : null)}; ${files.length} files grepped`);
console.log(failures === 0 ? "ALL CHECKS HOLD" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
