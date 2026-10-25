# Stage 6 — Character: skills, sub-skills, pace and level-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tool's projects and models level as OSRS sub-skills from the driven hours
Watchtower already measures. A new unranged `/character` page shows them, with pace, ETAs,
streaks and a level-up log.

**Architecture:**
- `capture/rollup.sh` does all the math, and no existing number moves.
  - Section 1 attributes each Claude gap to its driving model and writes
    `claude_model_rollups`.
  - The agent section does the same for Codex and Hermes. It then builds five skill tables
    from the committed Claude rollups and its own gaps, using the one thresholds list it
    already holds.
- `lib/read/character.ts` reads those tables. `lib/render/character.ts` draws them.
- Both are wired through `lib/views.ts` into `watchtower serve` and `watchtower report`.

**Tech stack:** bash, the `sqlite3` CLI (window functions), Node ≥ 22 with native type
stripping, vitest. **Zero runtime dependencies.**

**Spec (binding):** `docs/superpowers/specs/2026-10-03-stage-6-character-skills-design.md`,
approved 2026-10-03 (commit `e28f50d`).
- Copy every table, column, formula and empty-state string from the spec or from this plan;
  do not re-derive them.
- The spec's §2 decisions are settled and must not be re-asked.

**Branch:** `stage-6-character-skills`, cut from `main` @ `e26c362`. Watchtower only; TheOneOS
is untouched.

**Ledger:** `.superpowers/sdd/2026-10-03-stage-6-character-skills/`, with `progress.md` and a
`task-N-report.md` per task.

**Review shape (the user's standing preference):**
- No per-task review gates.
- Every task ends with:
  - its tests green;
  - `npm run typecheck` clean;
  - its guard plants recorded in its report;
  - a commit.
- After Task 5: **one** whole-branch review on the most capable model, then **at most one** fix
  wave.

---

## Rulings (the spec does not settle these; read at review)

- **R1 — `skill_level_ups` gains `tier` and `tier_changed`.** Spec §4.1 lists only `day`.
  - The page must print "→ ⟨tier⟩" when the tier changed, and no tier boundary may live
    under `lib/`, so the rollup stores both.
  - The tier boundaries move into one temp table, `_ag_tier`. `_sk_prog` and `_sk_ups` both
    read it, so there is still exactly one tier `CASE`.
- **R2 — the agents' skill rows read `_ag_g` / `_ag_gap`.** The agent section's read phase
  runs before its own swap, so `agent_daily_rollups` still holds the previous run's rows at
  that point. `_ag_g` is the exact set of rows the swap writes as
  `agent_daily_rollups.active_s`. Spec §4.2's "agent_daily_rollups.active_s × 1000" therefore
  means `_ag_g.active_s × 1000`.
- **R3 — Claude's `_evm` and `_sfm` go in section 1's read phase; `_gap` goes in its write
  phase.**
  - `_gap` sits where `_act` always was: section 1's header comment keeps `_act` in the write
    phase deliberately.
  - The expensive part, the event/request merge, runs without the write lock. `_gap` only
    joins its result.
  - An event written between the two phases has no `_evm` row and falls back to `_sfm`, or
    to `(no model)` for a session `_sfm` never saw. The identity holds either way.
- **R4 — tool lifetimes come from `_ag_life`, unchanged.** That is what keeps
  `agent_progress` identical, including a registered tool's row with no seconds and no
  level. Sub-skill lifetimes are `SUM(active_ms) / 1000` over `_sk_daily`.
- **R5 — guard 1's plants.** In this design `COALESCE` gives every gap a model, so the
  spec's "inner-join gaps to a model" becomes two plants:
  - Claude: drop `(no model)` from `claude_model_rollups`.
  - Agents: book the agent model rows to the session's start day instead of the gap's day.
    Dropping `(no model)` there would also redden guard 4's test, which pins the
    review-only Codex session (Review Focus 1).
- **R6 — `WATCHTOWER_ROLLUP_TODAY` pins the as-of day in tests.**
  - It is read only when it is `YYYY-MM-DD`; otherwise the as-of day is `date +%Y-%m-%d`,
    the run's local day.
  - It reaches the SQL through the agent section's existing prelude, as a one-row temp table
    `_sk_asof`.
- **R7 — ETAs are integer ceilings without a float.**
  - `CEIL(x / (xp_28d / 28.0))` is `(x * 28 + xp_28d - 1) / xp_28d`.
  - Not every `sqlite3` build has `ceil()`.
  - The result is never 0, because x ≥ 1 whenever it is not NULL.
- **R8 — `(excluded)` is hidden at read time from the level-up log too.** It is already
  hidden from the projects table. The log's count excludes it.
- **R9 — no `skill_progress` table means a whole-page pending card.**
  - The card reads `level pending` and "Watchtower's rollup has not run since its v8 install"
    (new constant `LEVEL_PENDING_WHY_V8`).
  - The existing `LEVEL_PENDING_WHY_CLAUDE` still names v7: `agent_progress` arrived in v7.
- **R10 — windows with no XP are labelled, never shown as a number.** XP today, 7 days and 28
  days print "none" when they are 0. A streak with no days prints "none". The page never
  prints "0 XP".
- **R11 — anchors.**
  - Each tool's section card has `id="character-<source>"`.
  - Tiles link in-page (`#character-<source>`).
  - The Overview's level cards link to `/character#character-<source>` served, and to
    `#character-<source>` in the report.
  - The same ids work in both, because the report stacks every view in one file.
- **R12 — the Skills grid follows the spec.** It has a tile only for a tool with a level. A
  tool in the `none` or `pending` state appears in its own section, through `levelBlock`.

## Global Constraints

- **All math lives in `capture/rollup.sh`.** That covers the gap rule, the XP rule,
  thresholds, tiers, pace, ETAs and streaks. `lib/` reads, filters, sorts and labels. Its
  only arithmetic:
  - a meter's percent;
  - seconds ÷ 3600;
  - a stored day count added to a stored date.
- **No `MIN(gap,` under `lib/` or in any script but `rollup.sh`.** In `rollup.sh`,
  `MIN(gap, 300)` stays at exactly **4** copies and `MIN(gap, 14400)` at exactly **3**
  (`tests/capture-scripts.test.ts`).
- **One thresholds list** (`_ag_xp`) and **one tier `CASE`** (`_ag_tier`, R1) in
  `rollup.sh`.
- **No existing number moves.**
  - Every `claude_*` table and `agent_progress` are identical to `main`'s rollup on the same
    snapshot, except `updated_at`.
  - `tests/regression.test.ts` (the Claude baseline) and every Stage 5 test stay green
    unchanged, except where a step below names the edit.
- **Rollup transactions:**
  - every intermediate is `CREATE TEMP TABLE _…` in a `BEGIN DEFERRED` read phase;
  - the agent section's `BEGIN IMMEDIATE` holds only `DELETE FROM t` + `INSERT INTO t (cols)
    SELECT cols FROM _staged ORDER BY rowid` pairs (`tests/rollup-lock.test.ts`).
- **Schema:** `CC_SCHEMA_VERSION=8` in `capture/lib.sh` and `schemaVersion: 8` in
  `lib/config.ts`. A test pins the two together.
- **The page never shows** "Lv 1", "0 XP", a 0-day ETA, a date for a NULL ETA, "NaN", or
  `$0.00`.
- **Strings, verbatim:**
  - `No driven hours yet.` (existing `NO_DRIVEN_HOURS`)
  - `No projects with driven hours yet.` / `No models with driven hours yet.`
  - `No level-ups yet.`
  - `no pace in the last 28 days`
  - `at your 28-day pace`
  - `level pending` (existing `LEVEL_PENDING`)
  - `Watchtower's rollup has not run since its v8 install`
  - `Excluded projects are hidden here; their time still counts toward the tool.`
- **Tests:**
  - Rollup tests seed `wt_*` through `tests/helpers/agent-seed.ts`, never through an adapter.
  - `TZ=UTC` is pinned by the helpers.
  - **R21:** each guard's literal values live in exactly one test.
  - Run the suite as `npx vitest run --exclude '.claude/**'`. A stray worktree under
    `.claude/` doubles a plain `npm test`.
- **The live system:**
  - Never test against `~/.theone/claude-code-usage.sqlite`. Copy it with `sqlite3 .backup`,
    each copy in its own directory: the `.schema-vN` marker lives in the DB's directory.
  - Never run `install.sh` against the live `~/.claude`.
- **Git:**
  - Never touch or commit the untracked `.claude/`.
  - No `Co-Authored-By` and no AI attribution in any commit.
  - After each SDD script call, restore `.superpowers/sdd/.gitignore`.

## Review Focus

These are the inputs the spec implies but its guards do not name. Each has a test in the task
that owns its code.

1. **A Codex session whose only requests are `codex-auto-review`** (34 live). Its time is
   `(no model)`, never `codex-auto-review`. Pinned in guard 4's test (Task 2).
2. **Activity dated after the as-of day** (clock skew, a test seam, a run just after midnight).
   It counts in no window and in no streak. Pinned in "ignores activity dated after the as-of
   day" (Task 2).
3. **A tool at 99 with stars.** No "next level" line, no "99 by", stars on the tile. Pinned in
   "at 99 shows stars and no ETA" (Task 4).
4. **Project paths and model names with `<`, `&` or `'`.** They are escaped in the tables, the
   tiles and the level-up log. Pinned in "escapes every name" (Task 4).
5. **A database with no driven hours** (a fresh install, or tokens only). The page renders
   every empty state with no "NaN", "Lv 1" or "0 XP". Pinned in "a database with no driven
   hours reads as none" (Task 3) and "renders every empty state" (Task 4).

## Guard map (R21)

Each plant must turn exactly **one** test red. The task's report records the plant, the test
it reddened, and the revert.

| # | Test (file › name) | Plant | Task |
|---|---|---|---|
| 1 | `skill-rollup` › every skill's model rows sum to its tool's hours, every day | (a) Claude: add `AND g.model <> '(no model)'` to `claude_model_rollups`'s `HAVING`. (b) Agents: book `_sk_daily`'s agent model rows to `strftime('%Y-%m-%d', s.started_at, 'unixepoch', 'localtime')` via `JOIN _ag_sess s`, instead of `_ag_gap.day` | 1 (a), 2 (b) |
| 2 | `skill-rollup` › credits each gap to the model you were driving | (a) Drop `is_sidechain = 0` from `_evm` and `_sfm`. (b) In `_sfm`, drop `fr.model` from the `COALESCE` | 1 |
| 3 | `skill-rollup` › books a session with no transcript to the model it recorded | Use `sm.model`'s raw `model` (keep the `[1m]` suffix) | 1 |
| 4 | `skill-rollup` › codex-auto-review never earns time | Remove `AND model <> 'codex-auto-review'` from `_ag_evm` and `_ag_sfm` | 2 |
| 5 | `skill-rollup` › a Hermes session with several models goes to (several models) | `MIN(model)` in place of the `CASE` in `_ag_sfm`'s `hr` | 2 |
| 6 | `skill-rollup` › project rows equal the project rollups | Read `window_ms` for Claude's project rows in `_sk_daily` | 2 |
| 7 | `skill-rollup` › tool rows equal the rollups, and their lifetime equals agent_progress | Build Claude's tool rows from `claude_project_rollups WHERE project_key <> '(excluded)'`, summed per day | 2 |
| 8 | `skill-rollup` › logs the day each level was reached | `t.xp < b.xp` and `t.xp >= b.prev_xp` in `_sk_ups`'s band | 2 |
| 9 | `skill-rollup` › paces XP per calendar day | `pace_xp_per_day` = `xp_28d` ÷ the window's active days | 2 |
| 10 | `skill-rollup` › a streak survives a today with no activity yet | Drop the `d1` fallback from `streak_current` | 2 |

## File map

| File | Change | Task |
|---|---|---|
| `capture/lib.sh` | `CC_SCHEMA_VERSION=8`; five new tables | 1 |
| `lib/config.ts` | `schemaVersion: 8` | 1 |
| `capture/rollup.sh` | Section 1: `_evm`, `_sfm`, `_gap`, `_act` from `_gap`, `claude_model_rollups` swap | 1 |
| `capture/rollup.sh` | Agent section: `_sk_asof` prelude, `_ag_evm`, `_ag_sfm`, `_ag_gap` + ts + model, `_ag_tier`, `_sk_*`, `_ag_prog` from `_sk_prog`, four more swaps | 2 |
| `tests/fixtures/make-fixture.sh` | Scenario `model-mix` | 1 |
| `tests/skill-rollup.test.ts` | New: guards 1–10, Review Focus 1–2 | 1, 2 |
| `tests/capture-scripts.test.ts` | Schema v8 tests; v7 tests read the version | 1 |
| `tests/rollup-lock.test.ts` | New read-phase tables and swaps | 1, 2 |
| `tests/helpers/agent-seed.ts` | `roll(db, env)` | 2 |
| `lib/read/character.ts` | New reader | 3 |
| `tests/read-character.test.ts` | New | 3 |
| `lib/render/character.ts` | New renderer | 4 |
| `lib/render/empty.ts` | Five strings | 4 |
| `lib/render/level.ts` | Export `meter` | 4 |
| `lib/render/layout.ts` | `card` takes `id`; Character in `TOOLS`; `toolRow` by class; tile CSS | 4 |
| `lib/render/overview.ts` | Level cards link to Character | 4 |
| `lib/render/report.ts` | Character in the report's tool row | 4 |
| `lib/views.ts` | `/character`, unranged; Overview gets `served` | 4 |
| `tests/render-character.test.ts` | New | 4 |
| `tests/report-budget.test.ts` | `character` per-week pin | 4 |
| `SESSION.md`, `CLAUDE.md` | Session 19; v8 tables, Character, the test seam | 5 |

## Fixture reference

- `BASE = 1750000000` is 2025-06-15T15:06:40Z, the `make-fixture.sh` epoch.
- `T = 1789466400` is 2026-09-15T10:00:00Z.
- `D = 1790762400` is 2026-09-30T10:00:00Z. `WATCHTOWER_ROLLUP_TODAY=2026-09-30`.
- `DAY = 86400`.
- XP checks:
  - `xp(2) = 83`, reached at exactly 58 s: 58 × 13,034,431 / 9,000,000 = 83.99 → 83. 57 s
    gives 82.
  - `xp(5) = 388` at 268 s.
  - `xp(10) = 1154` at 797 s (796 s gives 1152).
  - 100 s → 144 XP; 300 s → 434; 1300 s → 1882, which is Lv 13 with 225 to next; 60 s → 86.

---

## Tasks

### Task 1: Schema v8, and Claude's hours by driving model

**Files:**
- Modify: `capture/lib.sh` (version line 20; tables appended after `agent_progress`, ~line 489)
- Modify: `lib/config.ts:117`
- Modify: `capture/rollup.sh` (section 1: read phase before its first `COMMIT;` ~line 403;
  `_act` ~lines 461–532; after the daily rollups' `UPDATE … repos_json` ~line 700)
- Modify: `tests/fixtures/make-fixture.sh` (new scenario before `agent-drift)`)
- Create: `tests/skill-rollup.test.ts`
- Modify: `tests/capture-scripts.test.ts` (schema v7 block ~line 772; new v8 block)
- Modify: `tests/rollup-lock.test.ts:33` (`READ_PHASE_TABLES`)

**Interfaces:**
- Produces:
  - table `claude_model_rollups (day, model, active_ms, updated_at)`. Per day it sums to
    `claude_daily_rollups.active_ms`.
  - tables `skill_daily`, `skill_progress`, `skill_level_ups`, `skill_pace`, declared and
    empty. Task 2 fills them.
  - temp tables `_gap` (per gap: `session_id, project_key, id, ts, active_s, window_s,
    model`), `_evm (id, model)` and `_sfm (session_id, model)`, inside section 1's
    connection only.
  - fixture scenario `model-mix`.

- [ ] **Step 1: Declare schema v8**

In `capture/lib.sh`, change `CC_SCHEMA_VERSION=7` to `CC_SCHEMA_VERSION=8`. Then append inside
the same schema heredoc, directly after the `agent_progress` table's `);` and before the
closing `SQL`:

```sql

-- Stage 6 (schema v8): the Character page. All regenerable. claude_model_rollups
-- is filled by section 1 of rollup.sh, which holds Claude's per-gap rows; the
-- skill_* tables by the agent section, beside agent_progress.
CREATE TABLE IF NOT EXISTS claude_model_rollups (
  day        TEXT NOT NULL,              -- YYYY-MM-DD, local, session START day (as claude_daily_rollups)
  model      TEXT NOT NULL,              -- the driving model; '(no model)' when none is known
  active_ms  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, model)
);

CREATE TABLE IF NOT EXISTS skill_daily (
  source    TEXT NOT NULL,               -- 'claude' | 'codex' | 'hermes'
  kind      TEXT NOT NULL,               -- 'tool' | 'project' | 'model'
  key       TEXT NOT NULL,               -- the source, a project_key, or a model
  day       TEXT NOT NULL,               -- Claude: session start day, agents: the gap's end day
  active_ms INTEGER NOT NULL,            -- > 0: a day without time has no row
  PRIMARY KEY (source, kind, key, day)
);

CREATE TABLE IF NOT EXISTS skill_progress (
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL,
  active_s      INTEGER NOT NULL,        -- > 0: no seconds, no row, never Lv 1
  xp            INTEGER NOT NULL,
  level         INTEGER NOT NULL,
  tier          TEXT NOT NULL,
  xp_into_level INTEGER NOT NULL,
  xp_to_next    INTEGER,                 -- NULL at 99
  s_to_next     INTEGER,                 -- NULL at 99
  stars         INTEGER NOT NULL,
  first_day     TEXT NOT NULL,
  last_day      TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (source, kind, key)
);

CREATE TABLE IF NOT EXISTS skill_level_ups (
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  key          TEXT NOT NULL,
  level        INTEGER NOT NULL,         -- 2..99 (Lv 1 is never logged)
  day          TEXT NOT NULL,            -- the first day whose end-of-day XP reached xp(level)
  tier         TEXT NOT NULL,            -- the tier at this level
  tier_changed INTEGER NOT NULL,         -- 1 when this level opens a new tier
  PRIMARY KEY (source, kind, key, level)
);

CREATE TABLE IF NOT EXISTS skill_pace (
  source          TEXT PRIMARY KEY,      -- a tool, or 'all'
  as_of_day       TEXT NOT NULL,
  xp_today        INTEGER NOT NULL,
  xp_7d           INTEGER NOT NULL,
  xp_28d          INTEGER NOT NULL,
  pace_xp_per_day REAL NOT NULL,         -- xp_28d / 28.0: per CALENDAR day
  eta_next_days   INTEGER,               -- NULL with no pace, at 99, or with no level, and never 0
  eta_99_days     INTEGER,
  streak_current  INTEGER NOT NULL,
  streak_best     INTEGER NOT NULL
);
```

In `lib/config.ts`, change `schemaVersion: 7,` to `schemaVersion: 8,`.

- [ ] **Step 2: Move the schema tests to v8**

Run `grep -n "schema-v7\|\.schema-v\${\|toBe(7)" tests/*.ts`. In `tests/capture-scripts.test.ts`'s
`describe("schema v7", …)` block:
- replace each literal `".schema-v7"` with `` `.schema-v${schemaVersion()}` ``, which is what the
  v6 block already does;
- rename the test "and stamps .schema-v7" to "and stamps the current marker".

Fix any other literal 7 the grep shows the same way. Then add, after the v7 block:

```ts
// Stage 6 (schema v8): five regenerable Character tables. Tables only, so no
// cc_added_columns line; the version bump is what lets an existing install's
// init miss the fast path and create them.
const V8_TABLES = ["claude_model_rollups", "skill_daily", "skill_progress", "skill_level_ups", "skill_pace"];

describe("schema v8", () => {
  it("creates the five Character tables on a fresh DB, and stamps .schema-v8", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v8-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V8_TABLES) expect(tablesOf(db)).toContain(table);
    expect(existsSync(path.join(dir, ".schema-v8"))).toBe(true);
  });

  it("adds them to an older database in one cc_init_db call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v8up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    for (const table of V8_TABLES) expect(tablesOf(db)).not.toContain(table);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V8_TABLES) expect(tablesOf(db)).toContain(table);
  });
});
```

Run: `npx vitest run tests/capture-scripts.test.ts tests/config.test.ts`
Expected: PASS. Then commit:

```bash
git add capture/lib.sh lib/config.ts tests/capture-scripts.test.ts
git commit -m "schema v8: claude_model_rollups and the four skill tables"
```

- [ ] **Step 3: Add the `model-mix` fixture**

In `tests/fixtures/make-fixture.sh`, add this scenario directly before `agent-drift)`:

```bash
  model-mix)
    # Stage 6 (spec 4.3): Claude's hours by driving model, one session per day so
    # each guard reads its own day.
    # Day 0, S_MS: a gap before the first reply, Opus, a Haiku SIDECHAIN call,
    # then /model to Sonnet. The Sonnet request at 200 shares its second with
    # the Stop and counts as before it. Opus 10+50+40+50 = 150 s, Sonnet
    # 50+100+100 = 250 s, Haiku nothing.
    sess S_MS 0
    ev S_MS 0   SessionStart
    ev S_MS 10  UserPromptSubmit
    req ms_r1 S_MS 40  /tmp/fx 10 0
    req_meta ms_r1 claude-opus-5 cli
    ev S_MS 60  Stop
    ev S_MS 100 UserPromptSubmit
    req ms_r2 S_MS 130 /tmp/fx 10 1
    req_meta ms_r2 claude-haiku-4-5 cli
    ev S_MS 150 PreToolUse
    req ms_r3 S_MS 200 /tmp/fx 10 0
    req_meta ms_r3 claude-sonnet-5 cli
    ev S_MS 200 Stop
    ev S_MS 300 UserPromptSubmit
    ev S_MS 400 Stop
    ev S_MS 400 SessionEnd
    # Day 2, S_NOTX: no transcript was ever ingested; the session recorded
    # claude-opus-5[1m]. 10 + 90 = 100 s to claude-opus-5.
    sess S_NOTX $((2 * DAY))
    fx_sql "UPDATE claude_sessions SET model = $(cc_sqlstr 'claude-opus-5[1m]') WHERE session_id = $(cc_sqlstr S_NOTX);"
    ev S_NOTX $((2 * DAY))       SessionStart
    ev S_NOTX $((2 * DAY + 10))  UserPromptSubmit
    ev S_NOTX $((2 * DAY + 100)) Stop
    # Day 4, S_NOMODEL: no request and no recorded model -> (no model), 20 + 50 = 70 s.
    sess S_NOMODEL $((4 * DAY))
    ev S_NOMODEL $((4 * DAY))      SessionStart
    ev S_NOMODEL $((4 * DAY + 20)) UserPromptSubmit
    ev S_NOMODEL $((4 * DAY + 70)) Stop
    # Day 6, S_MID: starts 23:50:00 UTC (2025-06-21) and runs to 00:10 the next
    # day. All 1,200 s book to the START day, as claude_daily_rollups books them.
    sess S_MID $((6 * DAY + 31400))
    ev S_MID $((6 * DAY + 31400)) SessionStart
    ev S_MID $((6 * DAY + 31460)) UserPromptSubmit
    req mid_r1 S_MID $((6 * DAY + 31500)) /tmp/fx 10 0
    req_meta mid_r1 claude-opus-4-8 cli
    ev S_MID $((6 * DAY + 32600)) Stop
    ;;
```

Run: `bash -n tests/fixtures/make-fixture.sh && d=$(mktemp -d) && bash tests/fixtures/make-fixture.sh model-mix "$d/x.sqlite" && sqlite3 "$d/x.sqlite" "SELECT COUNT(*) FROM claude_events; SELECT COUNT(*) FROM claude_requests;"`
Expected: `18` then `4` (S_MS 9 events, the other three sessions 3 each).

- [ ] **Step 4: Write the failing Claude guards**

Create `tests/skill-rollup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";

// Stage 6: the Character page's data. Every tool's projects and models are
// sub-skills, levelled from the hours rollup.sh already measures (spec §4).
// R21: each guard's literal values live in ONE test here. Every other test over
// the same data asserts identities, so one planted defect reds one test. The
// plants, and the test each reddened, are in the task reports under
// .superpowers/sdd/2026-10-03-stage-6-character-skills/.

type Row = Record<string, unknown>;

/** Days on which Claude's model rows do not sum to claude_daily_rollups.active_ms. */
const claudeModelDrift = (db: string) => rows<Row>(db, `
  WITH m AS (SELECT day, SUM(active_ms) AS ms FROM claude_model_rollups GROUP BY day),
       d AS (SELECT day, active_ms AS ms FROM claude_daily_rollups WHERE active_ms > 0)
  SELECT d.day, d.ms AS daily, m.ms AS models FROM d LEFT JOIN m USING (day) WHERE m.ms IS NOT d.ms
  UNION ALL
  SELECT m.day, NULL, m.ms FROM m LEFT JOIN d USING (day) WHERE d.ms IS NULL`);

describe("hours by driving model", () => {
  // GUARD 1 (R21). Planted: (a) `AND g.model <> '(no model)'` in
  // claude_model_rollups's HAVING. Task 2 extends this test to every tool.
  it("every skill's model rows sum to its tool's hours, every day", () => {
    const dbs = [
      buildAndRoll("model-mix"), buildAndRoll("four-projects"), buildAndRoll("crosses-midnight"),
      buildAndRoll("mixed-projects-one-day", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" }),
    ];
    for (const db of dbs) {
      expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_model_rollups")[0].n).toBeGreaterThan(0);
      expect(claudeModelDrift(db)).toEqual([]);
    }
    expect(rows(dbs[0], "SELECT model, active_ms FROM claude_model_rollups WHERE day = '2025-06-19'"))
      .toEqual([{ model: "(no model)", active_ms: 70000 }]);
  });

  // GUARD 2 (R21), and spec §10's review focus 1, 2 and 4: the gap before the
  // first reply goes to the first model that answered; a request in the same
  // second as the Stop counts before it; a model that only ran as a subagent
  // has no row. Planted: (a) let sidechain requests drive; (b) drop the
  // first-request fallback.
  it("credits each gap to the model you were driving", () => {
    const db = buildAndRoll("model-mix");
    expect(rows(db, "SELECT model, active_ms FROM claude_model_rollups WHERE day = '2025-06-15' ORDER BY model"))
      .toEqual([{ model: "claude-opus-5", active_ms: 150000 }, { model: "claude-sonnet-5", active_ms: 250000 }]);
  });

  // GUARD 3 (R21). 2,433 live sessions have no ingested request; their recorded
  // model names all but 2.4 h of 46.3 h. Planted: keep the "[1m]" suffix.
  it("books a session with no transcript to the model it recorded", () => {
    const db = buildAndRoll("model-mix");
    expect(rows(db, "SELECT model, active_ms FROM claude_model_rollups WHERE day = '2025-06-17'"))
      .toEqual([{ model: "claude-opus-5", active_ms: 100000 }]);
  });
});
```

Run: `npx vitest run tests/skill-rollup.test.ts`
Expected: FAIL. `claude_model_rollups` exists but is empty, so the `toBeGreaterThan(0)` and
the `toEqual` assertions fail.

- [ ] **Step 5: Build `_evm` and `_sfm` in section 1's read phase**

In `capture/rollup.sh`, section 1, insert directly before the read phase's `COMMIT;` (the one
followed by `BEGIN IMMEDIATE;`, after `_turns`):

```sql

-- Stage 6 (spec 4.3): the model each Claude event was driven by, the model of
-- the session's latest MAIN-THREAD request at or before the event. Built here,
-- in the read phase, because it is the expensive part: one merge of events and
-- requests per session, sorted once. Requests sort before events in the same
-- second, so a turn's Stop credits the model that answered it; requests in one
-- second order by request_id, so the greater one wins. The running window
-- carries the latest request without a correlated subquery: grp counts the
-- requests so far, and the first row of each grp is the request that opened it.
-- An event before the session's first request gets no row; _sfm covers it.
DROP TABLE IF EXISTS _evm;
CREATE TEMP TABLE _evm AS
WITH st AS (
  SELECT session_id, ts, 1 AS k, id AS tb, id AS eid, NULL AS model
  FROM claude_events
  WHERE session_id IS NOT NULL AND hook_event_name NOT IN ('LauncherStart','LauncherEnd')
  UNION ALL
  SELECT session_id, ts, 0, request_id, NULL, model
  FROM claude_requests
  WHERE session_id IS NOT NULL AND is_sidechain = 0 AND model IS NOT NULL AND model <> '<synthetic>'
), g AS (
  SELECT st.*, SUM(1 - k) OVER (PARTITION BY session_id ORDER BY ts, k, tb
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
  FROM st
), m AS (
  SELECT eid, k, grp, FIRST_VALUE(model) OVER (PARTITION BY session_id, grp ORDER BY ts, k, tb) AS model
  FROM g
)
SELECT eid AS id, model FROM m WHERE k = 1 AND grp > 0;
CREATE INDEX IF NOT EXISTS _evm_id ON _evm(id);

-- The fallback for a gap with no main-thread request at or before it (spec 4.3
-- steps 3-5): the session's FIRST main-thread request's model, then the model
-- the session recorded (claude_sessions.model with any "[1m]"-style suffix
-- removed; '' and 'unknown' are no record), then '(no model)'. 2,433 live
-- sessions have no ingested request; their recorded model names all but 2.4 h
-- of their 46.3 h.
DROP TABLE IF EXISTS _sfm;
CREATE TEMP TABLE _sfm AS
WITH fr AS (
  SELECT session_id, model,
         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, request_id) AS rn
  FROM claude_requests
  WHERE session_id IS NOT NULL AND is_sidechain = 0 AND model IS NOT NULL AND model <> '<synthetic>'
), sm AS (
  SELECT session_id,
         NULLIF(NULLIF(CASE WHEN instr(model, '[') > 0 THEN substr(model, 1, instr(model, '[') - 1)
                            ELSE model END, ''), 'unknown') AS model
  FROM claude_sessions
)
SELECT e.session_id, COALESCE(fr.model, sm.model, '(no model)') AS model
FROM (SELECT DISTINCT session_id FROM claude_events WHERE session_id IS NOT NULL) e
LEFT JOIN fr ON fr.session_id = e.session_id AND fr.rn = 1
LEFT JOIN sm ON sm.session_id = e.session_id;
CREATE INDEX IF NOT EXISTS _sfm_id ON _sfm(session_id);
```

- [ ] **Step 6: Split `_act` into per-gap `_gap` rows, and sum them**

In section 1's write phase, the block from `DROP TABLE IF EXISTS _act;` to the end of
`CREATE TEMP TABLE _act AS … FROM ev GROUP BY session_id, project_key;` becomes the block
below.
- Keep the existing long comment above it, unchanged except its first line: "Activity model
  (rev 3, …)" now applies to `_gap`.
- The `ev` CTE and both `CASE` expressions are **moved, not copied**. Count the copies
  afterwards: `MIN(gap, 300)` appears twice and `MIN(gap, 14400)` twice here, as before.

```sql
DROP TABLE IF EXISTS _gap;
CREATE TEMP TABLE _gap AS
WITH ev AS (
  SELECT e.session_id, e.ts, e.hook_event_name AS evt, e.id,
         COALESCE(k.project_key, '(unfiled)') AS project_key,
         e.ts - LAG(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id) AS gap,
         MAX(CASE WHEN e.hook_event_name = 'UserPromptSubmit' THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_work,
         MAX(CASE WHEN e.hook_event_name IN ('Stop','SessionStart') THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_idle
  FROM claude_events e
  LEFT JOIN _pk k ON k.cwd = e.cwd
  WHERE e.session_id IS NOT NULL
    AND e.hook_event_name NOT IN ('LauncherStart','LauncherEnd')
)
SELECT ev.session_id, ev.project_key, ev.id, ev.ts,
       CASE WHEN ev.gap IS NULL                             THEN 0
            WHEN ev.evt IN ('SessionStart','SessionEnd')    THEN 0
            -- A gap ENDING at UserPromptSubmit is always think time: you were
            -- reading or typing, never executing. This must not depend on
            -- WORK/THINK state, because Stop is unreliable -- one session had
            -- 4 Stop events for 23 prompts, so the state machine can sit in
            -- WORK indefinitely and bill a walk-away as 4h of task time.
            WHEN ev.evt = 'UserPromptSubmit'                THEN MIN(gap, 300)
            WHEN ev.last_work > ev.last_idle                THEN MIN(gap, 14400)
            ELSE                                                 MIN(gap, 300)
       END AS active_s,
       CASE WHEN ev.gap IS NULL                             THEN 0
            WHEN ev.evt IN ('SessionStart','SessionEnd')    THEN 0
            ELSE                                                 MIN(gap, 14400)
       END AS window_s,
       -- Stage 6 (spec 4.3): the gap's driving model is the model at the event
       -- that ENDS it, else the session's fallback (_sfm). R3: an event written
       -- after the read phase has neither, and is '(no model)'.
       COALESCE(m.model, f.model, '(no model)') AS model
FROM ev
LEFT JOIN _evm m ON m.id = ev.id
LEFT JOIN _sfm f ON f.session_id = ev.session_id;

DROP TABLE IF EXISTS _act;
-- One row per (session, project_key): the per-gap rows above, summed. Same
-- numbers as before Stage 6, which kept the rule's text in one place.
CREATE TEMP TABLE _act AS
SELECT session_id, project_key,
       -- the deterministic tie-break for _pdom below
       MAX(id) AS last_id,
       SUM(active_s) AS active_s,
       SUM(window_s) AS window_s
FROM _gap GROUP BY session_id, project_key;
```

`MIN(gap, …)` stays unqualified because the copy-count test searches for that exact text.
`gap` is unambiguous: only `ev` has it.

- [ ] **Step 7: Swap in `claude_model_rollups`**

In section 1's write phase, directly after the `UPDATE claude_daily_rollups AS r SET
repos_json = …, models_json = …;` statement, add:

```sql

-- Stage 6 (spec 4.3): Claude's hours by driving model, booked exactly as the
-- daily rollup books them -- to the session's START day, through _sx -- so per
-- day these rows sum to claude_daily_rollups.active_ms. Time in excluded
-- projects is in here, as it is in the daily row.
DELETE FROM claude_model_rollups;
INSERT INTO claude_model_rollups (day, model, active_ms, updated_at)
SELECT sx.day, g.model, CAST(SUM(g.active_s) * 1000 AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM _gap g JOIN _sx sx ON sx.session_id = g.session_id
GROUP BY sx.day, g.model
HAVING SUM(g.active_s) > 0;
```

In `tests/rollup-lock.test.ts`, add `"_evm", "_sfm"` to `READ_PHASE_TABLES`.

- [ ] **Step 8: Run the guards and the whole suite**

Run: `npx vitest run tests/skill-rollup.test.ts tests/rollup-lock.test.ts tests/capture-scripts.test.ts tests/regression.test.ts tests/activity-model.test.ts tests/project-rollup.test.ts`
Expected: PASS. `regression.test.ts` is the Claude baseline: it proves `_act`'s refactor
moved no daily, project or rank number.

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck && bash -n capture/rollup.sh`
Expected: all green.

- [ ] **Step 9: Plant guards 1a, 2a, 2b and 3, and record them**

For each plant in the Guard map's rows 1(a), 2(a), 2(b) and 3:
1. Make the edit.
2. Run `npx vitest run --exclude '.claude/**'`.
3. Confirm **exactly one** test is red, and that it is the mapped one.
4. Revert with `git checkout capture/rollup.sh`.

Write each result in `task-1-report.md`: the plant, the red test's name, and the count of red
tests (must be 1). If a plant reds more than one test, move the extra literal into the mapped
test (R21) and re-plant.

- [ ] **Step 10: Commit**

```bash
git add capture/rollup.sh tests/fixtures/make-fixture.sh tests/skill-rollup.test.ts tests/rollup-lock.test.ts
git commit -m "rollup: Claude's hours by driving model (claude_model_rollups)"
```

---

### Task 2: The agent section: models, skill tables, levels, level-ups, pace and streaks

**Files:**
- Modify: `capture/rollup.sh` (agent section: prelude ~line 1675; `_ag_ev` ~1770; `_ag_gap`
  ~1781; `_ag_xp` / `_ag_life` / `_ag_prog` ~1865–1925; the write phase ~1930–1955)
- Modify: `tests/helpers/agent-seed.ts` (`roll`)
- Modify: `tests/skill-rollup.test.ts`
- Modify: `tests/rollup-lock.test.ts:81-87` (`AG_READ_PHASE_TABLES`, `AG_SWAPPED`, the swap test's
  name)

**Interfaces:**
- Consumes (Task 1): `claude_model_rollups`; the four empty `skill_*` tables; fixture
  `model-mix`.
- Produces:
  - `skill_daily (source, kind, key, day, active_ms)`, rows only where `active_ms > 0`.
  - `skill_progress (source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next,
    s_to_next, stars, first_day, last_day, updated_at)`, rows only where `active_s > 0`.
  - `skill_level_ups (source, kind, key, level, day, tier, tier_changed)`.
  - `skill_pace (source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days,
    eta_99_days, streak_current, streak_best)`: one row per tool in `agent_progress`, plus
    `all`.
  - `roll(db: string, env?: Record<string, string>): void` in `tests/helpers/agent-seed.ts`.
  - env `WATCHTOWER_ROLLUP_TODAY` (`YYYY-MM-DD`).

- [ ] **Step 1: Let `roll` take an environment**

In `tests/helpers/agent-seed.ts`:

```ts
/** Re-run rollup.sh (TZ=UTC) and fail loudly, with its stderr, on a non-zero exit. */
export function roll(db: string, env: Record<string, string> = {}): void {
  const r = rerollup(db, ["--quiet"], env);
  if (r.status !== 0) throw new Error(`rollup.sh exited ${r.status}: ${r.stderr}`);
}
```

- [ ] **Step 2: Write the failing agent guards**

In `tests/skill-rollup.test.ts`:
- Change the import lines to:

```ts
import { describe, expect, it } from "vitest";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
```

- Add below `type Row`:

```ts
const T = 1789466400;       // 2026-09-15T10:00:00Z
const D = 1790762400;       // 2026-09-30T10:00:00Z
const DAY = 86400;
const TODAY = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };

/** A driven Codex session of exactly `secs` (> 10) active seconds: a 10 s think, then work to a stop. */
const codexDay = (id: string, t: number, secs: number, cwd = "/tmp/wt-sk-one"): SeedSession => ({
  source: "codex", id, entry: "Codex Desktop", driven: 1, startedAt: t, cwd,
  events: [[t, "session_start"], [t + 10, "prompt"], [t + secs, "stop"]],
});

/** (source, day) where the model rows do not sum to the source's rollup, Claude's or the agents'. */
const modelDrift = (db: string) => rows<Row>(db, `
  WITH r AS (
    SELECT 'claude' AS source, day, active_ms AS ms FROM claude_daily_rollups WHERE active_ms > 0
    UNION ALL
    SELECT source, day, SUM(active_s) * 1000 FROM agent_daily_rollups GROUP BY source, day HAVING SUM(active_s) > 0
  ), m AS (
    SELECT source, day, SUM(active_ms) AS ms FROM skill_daily WHERE kind = 'model' GROUP BY source, day
  )
  SELECT r.source, r.day, r.ms AS rollup, m.ms AS models FROM r LEFT JOIN m USING (source, day) WHERE m.ms IS NOT r.ms
  UNION ALL
  SELECT m.source, m.day, NULL, m.ms FROM m LEFT JOIN r USING (source, day) WHERE r.ms IS NULL`);
```

- Replace guard 1's test body, keeping its name and comment, and noting plant (b) in the
  comment:

```ts
  it("every skill's model rows sum to its tool's hours, every day", () => {
    const mix = buildAndRoll("model-mix");
    const Tm = T + 49800; // 2026-09-15T23:50:00Z
    seedAgents(mix, [
      { source: "codex", id: "mid", entry: "Codex Desktop", driven: 1, startedAt: Tm, cwd: "/tmp/wt-sk-one",
        events: [[Tm, "session_start"], [Tm + 60, "prompt"], [Tm + 1200, "stop"]],
        requests: [{ id: "mid-1", ts: Tm + 100, model: "gpt-5.5" }] },
      codexDay("bare", T + 2 * DAY, 90),
      { source: "hermes", id: "one", entry: "cli", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T + 10, "prompt"], [T + 50, "stop"]],
        requests: [{ id: "one-1", ts: T, model: "hermes-x" }] },
      { source: "hermes", id: "two", entry: "cli", driven: 1, startedAt: T + DAY, cwd: "/tmp/wt-sk-one",
        events: [[T + DAY, "session_start"], [T + DAY + 10, "prompt"], [T + DAY + 70, "stop"]],
        requests: [{ id: "two-a", ts: T + DAY, model: "model-a" }, { id: "two-b", ts: T + DAY, model: "model-b" }] },
    ]);
    roll(mix);
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const dbs = [mix, buildAndRoll("four-projects"), buildAndRoll("crosses-midnight"),
                 buildAndRoll("mixed-projects-one-day", excl)];
    for (const db of dbs) {
      expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'model'")[0].n).toBeGreaterThan(0);
      expect(modelDrift(db)).toEqual([]);
    }
    expect(rows(mix, "SELECT DISTINCT source FROM skill_daily WHERE kind = 'model' ORDER BY source"))
      .toEqual([{ source: "claude" }, { source: "codex" }, { source: "hermes" }]);
    expect(rows(mix, "SELECT key, active_ms FROM skill_daily WHERE source = 'claude' AND kind = 'model' AND day = '2025-06-19'"))
      .toEqual([{ key: "(no model)", active_ms: 70000 }]);
  });
```

- Add a new `describe("the agent skills", () => { … })` holding the tests below, in this
  order.

```ts
  // GUARD 4 (R21), and Review Focus 1: a session whose only requests are
  // reviews (34 live) books to (no model), never to the reviewer. Planted:
  // remove the codex-auto-review exclusion from _ag_evm and _ag_sfm.
  it("codex-auto-review never earns time", () => {
    const db = buildAndRoll("resumed");
    const t2 = T + 2 * DAY;
    seedAgents(db, [
      { source: "codex", id: "rv", entry: "Codex Desktop", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T + 10, "prompt"], [T + 60, "stop"], [T + 100, "prompt"], [T + 150, "stop"]],
        requests: [{ id: "rv-1", ts: T + 30, model: "gpt-5.5" }, { id: "rv-2", ts: T + 120, model: "codex-auto-review" }] },
      { source: "codex", id: "ro", entry: "Codex Desktop", driven: 1, startedAt: t2, cwd: "/tmp/wt-sk-one",
        events: [[t2, "session_start"], [t2 + 20, "prompt"], [t2 + 80, "stop"]],
        requests: [{ id: "ro-1", ts: t2 + 40, model: "codex-auto-review" }] },
    ]);
    roll(db);
    expect(rows(db, "SELECT day, key, active_ms FROM skill_daily WHERE source = 'codex' AND kind = 'model' ORDER BY day"))
      .toEqual([
        { day: "2026-09-15", key: "gpt-5.5", active_ms: 150000 },
        { day: "2026-09-17", key: "(no model)", active_ms: 80000 },
      ]);
  });

  // GUARD 5 (R21). Hermes stores no per-call times, so a session that used two
  // models is not split by a guess. Planted: MIN(model) for the CASE.
  it("a Hermes session with several models goes to (several models)", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      { source: "hermes", id: "multi", entry: "cli", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T + 10, "prompt"], [T + 70, "stop"]],
        requests: [{ id: "m-a", ts: T, model: "model-a" }, { id: "m-b", ts: T, model: "model-b" }] },
      { source: "hermes", id: "single", entry: "cli", driven: 1, startedAt: T + DAY, cwd: "/tmp/wt-sk-one",
        events: [[T + DAY, "session_start"], [T + DAY + 10, "prompt"], [T + DAY + 40, "stop"]],
        requests: [{ id: "s-a", ts: T + DAY, model: "model-a" }] },
    ]);
    roll(db);
    expect(rows(db, "SELECT day, key, active_ms FROM skill_daily WHERE source = 'hermes' AND kind = 'model' ORDER BY day"))
      .toEqual([
        { day: "2026-09-15", key: "(several models)", active_ms: 70000 },
        { day: "2026-09-16", key: "model-a", active_ms: 40000 },
      ]);
  });

  // GUARD 6 (R21). Planted: window_ms for Claude's project rows.
  it("project rows equal the project rollups", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    seedAgents(db, [codexDay("pa", T, 120, "/tmp/wt-sk-a"), codexDay("pb", T + DAY, 60, "/tmp/wt-sk-b")]);
    roll(db, excl);
    const drift = rows<Row>(db, `
      WITH r AS (
        SELECT 'claude' AS source, project_key AS key, day, active_ms AS ms FROM claude_project_rollups WHERE active_ms > 0
        UNION ALL
        SELECT source, project_key, day, active_s * 1000 FROM agent_daily_rollups WHERE active_s > 0
      ), p AS (SELECT source, key, day, active_ms AS ms FROM skill_daily WHERE kind = 'project')
      SELECT r.*, p.ms AS skill FROM r LEFT JOIN p USING (source, key, day) WHERE p.ms IS NOT r.ms
      UNION ALL
      SELECT p.source, p.key, p.day, NULL, p.ms FROM p LEFT JOIN r USING (source, key, day) WHERE r.ms IS NULL`);
    expect(drift).toEqual([]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE source = 'claude' AND kind = 'project' AND key = '(excluded)'"))
      .toEqual([{ n: 1 }]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE source = 'codex' AND kind = 'project'")[0].n)
      .toBeGreaterThan(0);
  });

  // GUARD 7 (R21). The tool rows are what pace, streaks and the level-up log
  // read, so they must equal the rollups per day, and their lifetime must equal
  // the level. Planted: Claude's tool rows from the project rows without
  // (excluded) -- hiding excluded time at write time.
  it("tool rows equal the rollups, and their lifetime equals agent_progress", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    seedAgents(db, [codexDay("tl", T, 200)]);
    roll(db, excl);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_project_rollups WHERE project_key = '(excluded)' AND active_ms > 0")[0].n)
      .toBeGreaterThan(0);
    const daily = rows<Row>(db, `
      WITH r AS (
        SELECT 'claude' AS source, day, active_ms AS ms FROM claude_daily_rollups WHERE active_ms > 0
        UNION ALL
        SELECT source, day, SUM(active_s) * 1000 FROM agent_daily_rollups GROUP BY source, day HAVING SUM(active_s) > 0
      ), t AS (SELECT source, day, active_ms AS ms FROM skill_daily WHERE kind = 'tool')
      SELECT r.*, t.ms AS tool FROM r LEFT JOIN t USING (source, day) WHERE t.ms IS NOT r.ms
      UNION ALL
      SELECT t.source, t.day, NULL, t.ms FROM t LEFT JOIN r USING (source, day) WHERE r.ms IS NULL`);
    expect(daily).toEqual([]);
    const cols = "source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars";
    const prog = rows(db, `SELECT ${cols} FROM skill_progress WHERE kind = 'tool' ORDER BY source`);
    expect(prog).toEqual(rows(db, `SELECT ${cols} FROM agent_progress WHERE active_s > 0 ORDER BY source`));
    expect(prog.map((p) => (p as Row).source)).toEqual(["claude", "codex"]);
    expect(rows(db, "SELECT source, SUM(active_ms) / 1000 AS active_s FROM skill_daily WHERE kind = 'tool' GROUP BY source ORDER BY source"))
      .toEqual(rows(db, "SELECT source, active_s FROM skill_progress WHERE kind = 'tool' ORDER BY source"));
  });

  // GUARD 8 (R21). 58 s is exactly xp(2) = 83; 268 s is exactly xp(5) = 388;
  // 797 s is exactly xp(10) = 1154, Apprentice. Planted: strict comparisons in
  // _sk_ups's band.
  it("logs the day each level was reached", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("l1", T, 58), codexDay("l2", T + DAY, 210), codexDay("l3", T + 2 * DAY, 529)]);
    roll(db);
    expect(rows(db, `SELECT level, day, tier, tier_changed FROM skill_level_ups
                     WHERE source = 'codex' AND kind = 'tool' ORDER BY level`)).toEqual([
      { level: 2, day: "2026-09-15", tier: "Noobie", tier_changed: 0 },
      { level: 3, day: "2026-09-16", tier: "Noobie", tier_changed: 0 },
      { level: 4, day: "2026-09-16", tier: "Noobie", tier_changed: 0 },
      { level: 5, day: "2026-09-16", tier: "Noobie", tier_changed: 0 },
      { level: 6, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 7, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 8, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 9, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 10, day: "2026-09-17", tier: "Apprentice", tier_changed: 1 },
    ]);
    expect(rows(db, "SELECT level FROM skill_progress WHERE source = 'codex' AND kind = 'tool'")).toEqual([{ level: 10 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM skill_level_ups WHERE level < 2")).toEqual([{ n: 0 }]);
  });

  // GUARD 9 (R21). Codex: 100 s today, 200 s ten days ago, 1000 s forty days
  // ago. 28-day XP 434 is 15.5 a calendar day; 1300 s lifetime is Lv 13 with
  // 225 XP to go: ceil(225 / 15.5) = 15 days, and 99 in 840,810. Hermes: only
  // forty days ago, so no pace and no ETAs. Planted: divide by active days.
  it("paces XP per calendar day", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      codexDay("p0", D, 100), codexDay("p10", D - 10 * DAY, 200), codexDay("p40", D - 40 * DAY, 1000),
      { source: "hermes", id: "h40", entry: "cli", driven: 1, startedAt: D - 40 * DAY, cwd: "/tmp/wt-sk-one",
        events: [[D - 40 * DAY, "session_start"], [D - 40 * DAY + 10, "prompt"], [D - 40 * DAY + 300, "stop"]] },
    ]);
    roll(db, TODAY);
    const cols = "source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days, eta_99_days";
    expect(rows(db, `SELECT ${cols} FROM skill_pace WHERE source <> 'claude' ORDER BY source`)).toEqual([
      { source: "all", as_of_day: "2026-09-30", xp_today: 144, xp_7d: 144, xp_28d: 434, pace_xp_per_day: 15.5, eta_next_days: null, eta_99_days: null },
      { source: "codex", as_of_day: "2026-09-30", xp_today: 144, xp_7d: 144, xp_28d: 434, pace_xp_per_day: 15.5, eta_next_days: 15, eta_99_days: 840810 },
      { source: "hermes", as_of_day: "2026-09-30", xp_today: 0, xp_7d: 0, xp_28d: 0, pace_xp_per_day: 0, eta_next_days: null, eta_99_days: null },
    ]);
  });

  // GUARD 10 (R21). Codex active the three days before today and two more
  // before that; Hermes two days that end the day before yesterday; Claude one
  // day in 2025 (the resumed fixture), a best run that is long over. Planted:
  // drop the yesterday fallback.
  it("a streak survives a today with no activity yet", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      ...[1, 2, 3, 6, 7].map((n) => codexDay(`s${n}`, D - n * DAY, 60)),
      ...[2, 3].map((n): SeedSession => ({ source: "hermes", id: `h${n}`, entry: "cli", driven: 1, startedAt: D - n * DAY,
        cwd: "/tmp/wt-sk-one", events: [[D - n * DAY, "session_start"], [D - n * DAY + 10, "prompt"], [D - n * DAY + 60, "stop"]] })),
    ]);
    roll(db, TODAY);
    expect(rows(db, "SELECT source, streak_current, streak_best FROM skill_pace ORDER BY source")).toEqual([
      { source: "all", streak_current: 3, streak_best: 3 },
      { source: "claude", streak_current: 0, streak_best: 1 },
      { source: "codex", streak_current: 3, streak_best: 3 },
      { source: "hermes", streak_current: 0, streak_best: 2 },
    ]);
  });

  // Review Focus 2. Days after the as-of day count in no window and no run.
  // Asserts neither streak_current (guard 10's) nor the pace (guard 9's).
  it("ignores activity dated after the as-of day", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("y", D - DAY, 60), codexDay("f1", D + DAY, 60), codexDay("f2", D + 2 * DAY, 60)]);
    roll(db, TODAY);
    expect(rows(db, "SELECT xp_today, xp_7d, xp_28d, streak_best FROM skill_pace WHERE source = 'codex'"))
      .toEqual([{ xp_today: 0, xp_7d: 86, xp_28d: 86, streak_best: 1 }]);
  });
```

Run: `npx vitest run tests/skill-rollup.test.ts`
Expected: FAIL. Guard 1 fails for codex and hermes, and guards 4–10 and Review Focus 2 fail,
because `skill_daily`, `skill_level_ups` and `skill_pace` are empty. Guards 2 and 3 still
pass.

- [ ] **Step 3: Pass the as-of day into the agent section**

In `capture/rollup.sh`, directly after the line that sets `_ag_prelude` for an unsynced
database (`[ "$_ag_ready" = "3" ] || _ag_prelude="…"`), add:

```bash

# Stage 6 (spec 4.6): pace and streaks are measured as of the run's local day.
# WATCHTOWER_ROLLUP_TODAY pins it for tests; anything but YYYY-MM-DD is ignored.
_sk_today="$(date +%Y-%m-%d)"
case "${WATCHTOWER_ROLLUP_TODAY:-}" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) _sk_today="$WATCHTOWER_ROLLUP_TODAY" ;;
esac
_ag_prelude="$_ag_prelude
CREATE TEMP TABLE _sk_asof (d0 TEXT NOT NULL);
INSERT INTO _sk_asof VALUES ($(cc_sqlstr "$_sk_today"));"
```

- [ ] **Step 4: Attribute each agent gap to a model**

Directly after `_ag_ev` (before the comment above `_ag_gap`), add:

```sql

-- Stage 6 (spec 4.3): the driving model of each Codex event, by Claude's rule
-- over the session's requests: the latest at or before the event, requests
-- before events in the same second, ties to the greater source_record_id.
-- codex-auto-review is a reviewer and never drives; Codex records no subagent
-- flag, so it is the only exclusion. Hermes stores no per-call times, so it
-- has no rows here; _ag_sfm gives each of its sessions one model.
DROP TABLE IF EXISTS _ag_evm;
CREATE TEMP TABLE _ag_evm AS
WITH st AS (
  SELECT canonical_id, ts, 1 AS k, seq AS s1, source_record_id AS s2, NULL AS model
  FROM _ag_ev WHERE source = 'codex'
  UNION ALL
  SELECT canonical_id, ts, 0, 0, source_record_id, model
  FROM wt_requests
  WHERE source = 'codex' AND model IS NOT NULL AND model <> 'codex-auto-review'
), g AS (
  SELECT st.*, SUM(1 - k) OVER (PARTITION BY canonical_id ORDER BY ts, k, s1, s2
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
  FROM st
), m AS (
  SELECT s2, k, grp, FIRST_VALUE(model) OVER (PARTITION BY canonical_id, grp ORDER BY ts, k, s1, s2) AS model
  FROM g
)
SELECT s2 AS source_record_id, model FROM m WHERE k = 1 AND grp > 0;
CREATE INDEX IF NOT EXISTS _ag_evm_id ON _ag_evm(source_record_id);

-- The fallback (spec 4.3): a Codex session's first non-reviewer request; a
-- Hermes session's one model, or '(several models)' when it used two or more
-- -- never a guessed split; otherwise '(no model)'.
DROP TABLE IF EXISTS _ag_sfm;
CREATE TEMP TABLE _ag_sfm AS
WITH cr AS (
  SELECT canonical_id, model,
         ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY ts, source_record_id) AS rn
  FROM wt_requests
  WHERE source = 'codex' AND model IS NOT NULL AND model <> 'codex-auto-review'
), hr AS (
  SELECT canonical_id,
         CASE WHEN COUNT(DISTINCT model) = 1 THEN MAX(model) ELSE '(several models)' END AS model
  FROM wt_requests WHERE source = 'hermes' AND model IS NOT NULL
  GROUP BY canonical_id
)
SELECT s.canonical_id,
       COALESCE(CASE WHEN s.first_source = 'codex' THEN cr.model ELSE hr.model END, '(no model)') AS model
FROM _ag_sess s
LEFT JOIN cr ON cr.canonical_id = s.canonical_id AND cr.rn = 1
LEFT JOIN hr ON hr.canonical_id = s.canonical_id;
CREATE INDEX IF NOT EXISTS _ag_sfm_id ON _ag_sfm(canonical_id);
```

Then change `_ag_gap`.
- In its `ev` CTE, add `e.source_record_id` after `e.evt`.
- Replace its final `SELECT … FROM ev;` with the block below. The `CASE` is moved unchanged:
  `MIN(gap, 300)` twice and `MIN(gap, 14400)` once.

```sql
SELECT ev.source, ev.canonical_id, ev.project_key, ev.ts,
       strftime('%Y-%m-%d', ev.ts, 'unixepoch', 'localtime') AS day,
       CASE WHEN gap IS NULL                              THEN 0
            WHEN evt IN ('session_start','session_end')   THEN 0
            WHEN evt = 'prompt'                           THEN MIN(gap, 300)
            WHEN last_work > last_idle                    THEN MIN(gap, 14400)
            ELSE                                               MIN(gap, 300)
       END AS active_s,
       -- Stage 6: the model at the event that ENDS the gap, else the session's.
       COALESCE(m.model, f.model, '(no model)') AS model
FROM ev
LEFT JOIN _ag_evm m ON ev.source = 'codex' AND m.source_record_id = ev.source_record_id
LEFT JOIN _ag_sfm f ON f.canonical_id = ev.canonical_id;
```

- [ ] **Step 5: Tiers once; skill hours; the keyed level pipeline**

Directly after the `_ag_xp` `INSERT … VALUES …;` statement, add `_ag_tier`:

```sql

-- Stage 6 (R1): each level's tier, once. _sk_prog and _sk_ups both read it, so
-- the tier boundaries live in this one CASE.
DROP TABLE IF EXISTS _ag_tier;
CREATE TEMP TABLE _ag_tier AS
SELECT level,
       CASE WHEN level >= 99 THEN 'Master'
            WHEN level >= 85 THEN 'Pro'
            WHEN level >= 70 THEN 'Advanced'
            WHEN level >= 50 THEN 'Intermediate'
            WHEN level >= 25 THEN 'Builder'
            WHEN level >= 10 THEN 'Apprentice'
            ELSE                  'Noobie'
       END AS tier
FROM _ag_xp;
```

Keep `_ag_life` exactly as it is. Replace the whole `DROP TABLE IF EXISTS _ag_prog; …
CREATE TEMP TABLE _ag_prog AS … ORDER BY l.source;` block, and its comment, with:

```sql
-- Stage 6 (spec 4.2): driven time per day for every skill -- each tool, its
-- projects and its models. Claude's rows copy the rollups section 1 committed.
-- The agents' come from this section's own gaps: _ag_g is exactly what the swap
-- below writes as agent_daily_rollups.active_s, read here because the swap has
-- not happened yet (R2). Milliseconds throughout, so Claude's carry over
-- exactly. Only days with time get a row. Per source and day the project rows
-- and the model rows each sum to the tool row (tests/skill-rollup.test.ts).
DROP TABLE IF EXISTS _sk_daily;
CREATE TEMP TABLE _sk_daily AS
SELECT source, kind, key, day, active_ms FROM (
  SELECT 'claude' AS source, 'tool' AS kind, 'claude' AS key, day, active_ms FROM claude_daily_rollups
  UNION ALL SELECT 'claude', 'project', project_key, day, active_ms FROM claude_project_rollups
  UNION ALL SELECT 'claude', 'model', model, day, active_ms FROM claude_model_rollups
  UNION ALL SELECT source, 'tool', source, day, SUM(active_s) * 1000 FROM _ag_g GROUP BY source, day
  UNION ALL SELECT source, 'project', project_key, day, SUM(active_s) * 1000 FROM _ag_g GROUP BY source, project_key, day
  UNION ALL SELECT source, 'model', model, day, SUM(active_s) * 1000 FROM _ag_gap GROUP BY source, model, day
) WHERE active_ms > 0
ORDER BY source, kind, key, day;

-- Lifetime seconds per skill. The tool rows are _ag_life's, unchanged from
-- Stage 5, so agent_progress cannot move (R4): a registered tool with no
-- seconds keeps its row, with no level. Every other skill exists once it has time.
DROP TABLE IF EXISTS _sk_life;
CREATE TEMP TABLE _sk_life AS
SELECT source, 'tool' AS kind, source AS key, active_s FROM _ag_life
UNION ALL
SELECT source, kind, key, SUM(active_ms) / 1000 FROM _sk_daily WHERE kind <> 'tool' GROUP BY source, kind, key;

-- Spec 4.4 (Stage 5's 4.4, keyed). XP = active_s * 13,034,431 / 9,000,000
-- (integer division: 2,500 h is exactly 99). Level is the highest L with
-- xp(L) <= XP, and NULL with no driven seconds. s_to_next is the integer
-- ceiling of the seconds that reach xp(L+1). Stars: one per 900,000 s (250 h)
-- past 9,000,000 s, floored.
DROP TABLE IF EXISTS _sk_prog;
CREATE TEMP TABLE _sk_prog AS
WITH x AS (
  SELECT source, kind, key, active_s, active_s * 13034431 / 9000000 AS xp FROM _sk_life
), l AS (
  SELECT x.source, x.kind, x.key, x.active_s, x.xp,
         CASE WHEN x.active_s > 0 THEN (SELECT MAX(t.level) FROM _ag_xp t WHERE t.xp <= x.xp) END AS level
  FROM x
), span AS (
  SELECT source, kind, key, MIN(day) AS first_day, MAX(day) AS last_day
  FROM _sk_daily GROUP BY source, kind, key
)
SELECT l.source, l.kind, l.key, l.active_s, l.xp, l.level, tr.tier,
       l.xp - cur.xp AS xp_into_level,
       nxt.xp - l.xp AS xp_to_next,
       (nxt.xp * 9000000 + 13034430) / 13034431 - l.active_s AS s_to_next,
       CASE WHEN l.level IS NULL          THEN NULL
            WHEN l.active_s >= 9000000    THEN (l.active_s - 9000000) / 900000
            ELSE                               0
       END AS stars,
       sp.first_day, sp.last_day
FROM l
LEFT JOIN _ag_xp cur  ON cur.level = l.level
LEFT JOIN _ag_xp nxt  ON nxt.level = l.level + 1
LEFT JOIN _ag_tier tr ON tr.level = l.level
LEFT JOIN span sp     ON sp.source = l.source AND sp.kind = l.kind AND sp.key = l.key
ORDER BY l.source, l.kind, l.key;

-- agent_progress, unchanged in every column: the keyed pipeline's tool rows.
DROP TABLE IF EXISTS _ag_prog;
CREATE TEMP TABLE _ag_prog AS
SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
FROM _sk_prog WHERE kind = 'tool' ORDER BY source;

-- skill_progress: every skill with time. No seconds, no row -- never Lv 1.
DROP TABLE IF EXISTS _sk_progress;
CREATE TEMP TABLE _sk_progress AS
SELECT source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars,
       first_day, last_day
FROM _sk_prog WHERE active_s > 0 ORDER BY source, kind, key;
```

- [ ] **Step 6: Level-ups, pace and streaks**

Directly after `_sk_progress`, before the read phase's `COMMIT;`, add:

```sql

-- Spec 4.5: the day each level was reached -- the first day whose end-of-day
-- cumulative XP is at least xp(L). A band join: each day claims the levels its
-- XP crossed since the day before, so each level appears once. Lv 1 is never
-- logged; a level whose tier differs from the level below opens a new tier.
DROP TABLE IF EXISTS _sk_ups;
CREATE TEMP TABLE _sk_ups AS
WITH c AS (
  SELECT source, kind, key, day,
         (SUM(active_ms) OVER (PARTITION BY source, kind, key ORDER BY day
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) / 1000)
           * 13034431 / 9000000 AS xp
  FROM _sk_daily
), b AS (
  SELECT c.*, COALESCE(LAG(xp) OVER (PARTITION BY source, kind, key ORDER BY day), 0) AS prev_xp FROM c
)
SELECT b.source, b.kind, b.key, t.level, b.day, tr.tier,
       CASE WHEN tr.tier <> pr.tier THEN 1 ELSE 0 END AS tier_changed
FROM b
JOIN _ag_xp t   ON t.level >= 2 AND t.xp > b.prev_xp AND t.xp <= b.xp
JOIN _ag_tier tr ON tr.level = t.level
JOIN _ag_tier pr ON pr.level = t.level - 1
ORDER BY b.source, b.kind, b.key, t.level;

-- Spec 4.6: the as-of day (R6) and its windows.
DROP TABLE IF EXISTS _sk_d;
CREATE TEMP TABLE _sk_d AS
SELECT d0, date(d0, '-1 day') AS d1, date(d0, '-6 days') AS d6, date(d0, '-27 days') AS d27 FROM _sk_asof;

-- XP earned in each window, per tool with a progress row, by the XP rule over
-- the window's seconds. Days after the as-of day are in no window.
DROP TABLE IF EXISTS _sk_win;
CREATE TEMP TABLE _sk_win AS
SELECT t.source,
       (COALESCE(SUM(CASE WHEN s.day = d.d0  THEN s.active_ms END), 0) / 1000) * 13034431 / 9000000 AS xp_today,
       (COALESCE(SUM(CASE WHEN s.day >= d.d6 THEN s.active_ms END), 0) / 1000) * 13034431 / 9000000 AS xp_7d,
       (COALESCE(SUM(s.active_ms), 0) / 1000) * 13034431 / 9000000 AS xp_28d
FROM _ag_life t
CROSS JOIN _sk_d d
LEFT JOIN _sk_daily s ON s.source = t.source AND s.kind = 'tool' AND s.day BETWEEN d.d27 AND d.d0
GROUP BY t.source
ORDER BY t.source;

-- Runs of consecutive active days (any driven time), per tool and for 'all'
-- (any tool), up to the as-of day. Along a run, a day's julian number minus its
-- rank is constant.
DROP TABLE IF EXISTS _sk_runs;
CREATE TEMP TABLE _sk_runs AS
WITH ad AS (
  SELECT source, day FROM _sk_daily, _sk_d WHERE kind = 'tool' AND day <= d0
  UNION
  SELECT 'all', day FROM _sk_daily, _sk_d WHERE kind = 'tool' AND day <= d0
), isl AS (
  SELECT source, day,
         CAST(julianday(day) AS INTEGER) - ROW_NUMBER() OVER (PARTITION BY source ORDER BY day) AS run
  FROM ad
)
SELECT source, MAX(day) AS last_day, COUNT(*) AS days FROM isl GROUP BY source, run;

-- Spec 4.6: one row per tool and one 'all'. Pace is XP per CALENDAR day over
-- 28 days. The ETAs are integer ceilings without a float (R7): x / (xp_28d /
-- 28) rounded up is (x * 28 + xp_28d - 1) / xp_28d. NULL with no pace, at 99
-- and with no level (xp_to_next is NULL in both); 'all' has none. A current
-- streak survives a today with no activity yet: the run ending yesterday counts.
DROP TABLE IF EXISTS _sk_pace;
CREATE TEMP TABLE _sk_pace AS
WITH w AS (
  SELECT source, xp_today, xp_7d, xp_28d FROM _sk_win
  UNION ALL
  SELECT 'all', COALESCE(SUM(xp_today), 0), COALESCE(SUM(xp_7d), 0), COALESCE(SUM(xp_28d), 0) FROM _sk_win
)
SELECT w.source, d.d0 AS as_of_day, w.xp_today, w.xp_7d, w.xp_28d,
       w.xp_28d / 28.0 AS pace_xp_per_day,
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL THEN NULL
            ELSE (p.xp_to_next * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_next_days,
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL THEN NULL
            ELSE ((13034431 - p.xp) * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_99_days,
       COALESCE((SELECT r.days FROM _sk_runs r WHERE r.source = w.source AND r.last_day = d.d0),
                (SELECT r.days FROM _sk_runs r WHERE r.source = w.source AND r.last_day = d.d1),
                0) AS streak_current,
       COALESCE((SELECT MAX(r.days) FROM _sk_runs r WHERE r.source = w.source), 0) AS streak_best
FROM w
CROSS JOIN _sk_d d
LEFT JOIN _sk_prog p ON p.source = w.source AND p.kind = 'tool'
ORDER BY CASE w.source WHEN 'all' THEN 1 ELSE 0 END, w.source;
```

- [ ] **Step 7: Swap the skill tables in**

In the write phase, directly after the `agent_progress` `INSERT … ORDER BY rowid;` and before
`COMMIT;`, add:

```sql
DELETE FROM skill_daily;
INSERT INTO skill_daily (source, kind, key, day, active_ms)
SELECT source, kind, key, day, active_ms FROM _sk_daily ORDER BY rowid;
DELETE FROM skill_progress;
INSERT INTO skill_progress (source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next,
  s_to_next, stars, first_day, last_day, updated_at)
SELECT source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars,
       first_day, last_day, CAST(strftime('%s','now') AS INTEGER) FROM _sk_progress ORDER BY rowid;
DELETE FROM skill_level_ups;
INSERT INTO skill_level_ups (source, kind, key, level, day, tier, tier_changed)
SELECT source, kind, key, level, day, tier, tier_changed FROM _sk_ups ORDER BY rowid;
DELETE FROM skill_pace;
INSERT INTO skill_pace (source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days,
  eta_99_days, streak_current, streak_best)
SELECT source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days, eta_99_days,
       streak_current, streak_best FROM _sk_pace ORDER BY rowid;
```

In `tests/rollup-lock.test.ts`:
- Extend `AG_READ_PHASE_TABLES` with `"_ag_evm", "_ag_sfm", "_ag_tier", "_sk_daily", "_sk_life",
  "_sk_prog", "_sk_progress", "_sk_ups", "_sk_d", "_sk_win", "_sk_runs", "_sk_pace"`.
- Append to `AG_SWAPPED`: `["skill_daily", "_sk_daily"], ["skill_progress", "_sk_progress"],
  ["skill_level_ups", "_sk_ups"], ["skill_pace", "_sk_pace"]`.
- Rename "swaps the four agent tables in the write phase, …" to "swaps the agent and skill
  tables in the write phase, …".

- [ ] **Step 8: Run everything**

Run: `npx vitest run tests/skill-rollup.test.ts tests/rollup-lock.test.ts tests/agent-rollup.test.ts tests/read-level.test.ts tests/capture-scripts.test.ts`
Expected: PASS. `agent-rollup.test.ts` and `read-level.test.ts` pass **unchanged**, which proves
`agent_progress` did not move.

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck && bash -n capture/rollup.sh`
Expected: all green.

- [ ] **Step 9: Plant guards 1b and 4–10, and record them**

Plant each row of the Guard map marked Task 2, exactly as in Task 1 Step 9: exactly one red
test, the mapped one, then revert. Record each plant in `task-2-report.md`. Also record:
- the rollup's wall time on the `density-270` fixture before and after this task, measured
  with `time` around `buildAndRoll`'s rollup;
- whether `_ag_evm` and `_sk_ups` stayed under 100 ms on it.

- [ ] **Step 10: Commit**

```bash
git add capture/rollup.sh tests/helpers/agent-seed.ts tests/skill-rollup.test.ts tests/rollup-lock.test.ts
git commit -m "rollup: every tool's projects and models as skills; level-ups, pace and streaks"
```

---

### Task 3: The reader — `lib/read/character.ts`

**Files:**
- Create: `lib/read/character.ts`
- Create: `tests/read-character.test.ts`

**Interfaces:**
- Consumes:
  - the `skill_*` tables (Task 2);
  - `readLevels`, `totalLevel`, `hasTable`, `AGENT_LABEL`, `AGENT_SOURCES`, and the types
    `AgentSource`, `Level` and `LevelState` from `lib/read/level.ts`;
  - `toolStatus` from `lib/read/tools.ts`;
  - `projectLabel` from `lib/read/projects.ts`;
  - `querySql` from `lib/core/sql.ts`.
- Produces: `readCharacter(db: string, opts?: { now?: number; home?: string }): CharacterData`,
  `LEVEL_UP_CAP = 300`, and the types `CharacterData`, `ToolCharacter`, `Skill`, `Pace`,
  `LevelUp`, `SkillKind`. All exactly as written below.

- [ ] **Step 1: Write the failing tests**

Create `tests/read-character.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyWtSchema } from "@/lib/core/schema";
import { LEVEL_UP_CAP, readCharacter } from "@/lib/read/character";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";

// Stage 6, Task 3. The reader parses, filters (excluded) and labels the skill_*
// tables; every number it returns is a stored one. R21: the rollup's literal
// values live in tests/skill-rollup.test.ts, so these assert identities.

const T = 1789466400;
const D = 1790762400;
const DAY = 86400;
const NOW = D + 3600;
const TODAY = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };
const home = () => mkdtempSync(path.join(tmpdir(), "wt-char-home-")); // no ~/.codex, no ~/.hermes
const codexDay = (id: string, t: number, secs: number, cwd = "/tmp/wt-ch-one"): SeedSession => ({
  source: "codex", id, entry: "Codex Desktop", driven: 1, startedAt: t, cwd,
  events: [[t, "session_start"], [t + 10, "prompt"], [t + secs, "stop"]],
});
function synced(db: string, source: string): void {
  applyWtSchema(db);
  execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO wt_ingest_state (source, last_run_at, last_ok_at, health)
    VALUES ('${source}', ${NOW}, ${NOW}, 'ok');`]);
}

describe("readCharacter", () => {
  it("is pending on a database the v8 rollup has not run on", () => {
    const db = buildAndRoll("resumed");
    execFileSync("sqlite3", [db, "DROP TABLE skill_progress"]);
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.pending).toBe(true);
    expect(c.tools).toEqual([]);
    expect(c.levelUps).toEqual([]);
  });

  it("lists Claude always, and an agent only once it is installed or synced", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("c", T, 120)]);
    roll(db);
    expect(readCharacter(db, { now: NOW, home: home() }).tools.map((t) => t.source)).toEqual(["claude"]);
    synced(db, "codex");
    expect(readCharacter(db, { now: NOW, home: home() }).tools.map((t) => t.source)).toEqual(["claude", "codex"]);
  });

  it("reads each tool's skills from the stored rows, hiding (excluded)", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    const c = readCharacter(db, { now: NOW, home: home() });
    const claude = c.tools.find((t) => t.source === "claude")!;
    expect(claude.excludedHidden).toBe(true);
    expect(claude.projects.map((s) => [s.key, s.level.level, s.level.xp, s.firstDay, s.lastDay])).toEqual(
      rows<{ key: string; level: number; xp: number; first_day: string; last_day: string }>(db, `
        SELECT key, level, xp, first_day, last_day FROM skill_progress
        WHERE source = 'claude' AND kind = 'project' AND key <> '(excluded)'
        ORDER BY level DESC, xp DESC, key`).map((r) => [r.key, r.level, r.xp, r.first_day, r.last_day]));
    expect(claude.projects.every((s) => !s.label.includes("/"))).toBe(true);
    expect(claude.models.map((s) => s.key)).toEqual(
      rows<{ key: string }>(db, `SELECT key FROM skill_progress WHERE source = 'claude' AND kind = 'model'
        ORDER BY level DESC, xp DESC, key`).map((r) => r.key));
    expect(claude.state.state).toBe("level");
    expect(c.totalLevel).toBe(claude.state.state === "level" ? claude.state.level.level : null);
  });

  it("turns the stored pace into a date, and nothing else", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("p0", D, 100), codexDay("p10", D - 10 * DAY, 200)]);
    synced(db, "codex");
    roll(db, TODAY);
    const codex = readCharacter(db, { now: NOW, home: home() }).tools.find((t) => t.source === "codex")!;
    const r = rows<{ as_of_day: string; pace_xp_per_day: number; eta_next_days: number; eta_99_days: number;
      streak_current: number; streak_best: number }>(db, "SELECT * FROM skill_pace WHERE source = 'codex'")[0];
    const date99 = new Date(Date.parse(`${r.as_of_day}T00:00:00Z`) + r.eta_99_days * 86400000).toISOString().slice(0, 10);
    expect(codex.pace).toMatchObject({
      asOfDay: r.as_of_day, perDay: r.pace_xp_per_day, etaNextDays: r.eta_next_days, eta99Days: r.eta_99_days,
      date99, streakCurrent: r.streak_current, streakBest: r.streak_best,
    });
  });

  it("lists level-ups newest first, without (excluded), capped", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.levelUps.length).toBeGreaterThan(0);
    expect(c.levelUps.some((u) => u.key === "(excluded)")).toBe(false);
    const days = c.levelUps.map((u) => u.day);
    expect(days).toEqual([...days].sort().reverse());
    expect(c.levelUpCount).toBe(rows<{ n: number }>(db,
      "SELECT COUNT(*) AS n FROM skill_level_ups WHERE NOT (kind = 'project' AND key = '(excluded)')")[0].n);
    // Readers only read: rows written straight into the table exercise the cap.
    const values = Array.from({ length: LEVEL_UP_CAP + 10 }, (_, i) =>
      `('codex','model','m${i}',2,'2026-09-${String(1 + (i % 28)).padStart(2, "0")}','Noobie',0)`).join(",");
    execFileSync("sqlite3", [db, `INSERT INTO skill_level_ups (source, kind, key, level, day, tier, tier_changed) VALUES ${values};`]);
    const capped = readCharacter(db, { now: NOW, home: home() });
    expect(capped.levelUps).toHaveLength(LEVEL_UP_CAP);
    expect(capped.levelUpCount).toBe(c.levelUpCount + LEVEL_UP_CAP + 10);
  });

  // Review Focus 5.
  it("a database with no driven hours reads as none, never Lv 1", () => {
    const db = buildAndRoll("tokens-only-day");
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.pending).toBe(false);
    const claude = c.tools[0];
    expect(claude.source).toBe("claude");
    expect(claude.state.state).toBe("none");
    expect(claude.projects).toEqual([]);
    expect(claude.models).toEqual([]);
    expect(c.totalLevel).toBeNull();
    expect(c.levelUps).toEqual([]);
    expect(c.all).toMatchObject({ xpToday: 0, xp7d: 0, xp28d: 0, perDay: 0, etaNextDays: null, date99: null });
  });
});
```

Run: `npx vitest run tests/read-character.test.ts`
Expected: FAIL with "Cannot find module '@/lib/read/character'" or similar.

- [ ] **Step 2: Write the reader**

Create `lib/read/character.ts`:

```ts
/**
 * The Character page (Stage 6, spec §5): every tool as a skill, its projects
 * and models as sub-skills, its pace and streaks, and the level-up log -- all
 * as rollup.sh stored them in the skill_* tables. This module reads, filters
 * (excluded) and labels. Its one piece of arithmetic is a stored day count
 * added to a stored date, for "99 by <date>".
 */
import os from "node:os";
import { querySql } from "../core/sql.ts";
import {
  AGENT_LABEL, hasTable, readLevels, totalLevel, type AgentSource, type Level, type LevelState,
} from "./level.ts";
import { projectLabel } from "./projects.ts";
import { toolStatus } from "./tools.ts";

export type SkillKind = "tool" | "project" | "model";

/** The served level-up log's length; the report shows fewer (render/character.ts). */
export const LEVEL_UP_CAP = 300;

export interface Skill {
  key: string;
  /** A project's basename, a model's name. */
  label: string;
  level: Level;
  firstDay: string;
  lastDay: string;
}

export interface Pace {
  asOfDay: string;
  xpToday: number;
  xp7d: number;
  xp28d: number;
  /** XP per calendar day over 28 days. */
  perDay: number;
  etaNextDays: number | null;
  eta99Days: number | null;
  /** asOfDay + eta99Days, YYYY-MM-DD; null with no ETA. */
  date99: string | null;
  streakCurrent: number;
  streakBest: number;
}

export interface LevelUp {
  day: string;
  source: AgentSource;
  kind: SkillKind;
  key: string;
  label: string;
  level: number;
  tier: string;
  tierChanged: boolean;
}

export interface ToolCharacter {
  source: AgentSource;
  label: string;
  /** From agent_progress, as on every other page: pending, none, or a level. */
  state: LevelState;
  pace: Pace | null;
  /** Highest level first; (excluded) is not here. */
  projects: Skill[];
  /** Whether an (excluded) project row was left out. */
  excludedHidden: boolean;
  models: Skill[];
}

export interface CharacterData {
  generatedAt: number;
  /** No skill_progress table: the installed rollup predates schema v8. */
  pending: boolean;
  tools: ToolCharacter[];
  totalLevel: number | null;
  /** The 'all' row: every tool together. */
  all: Pace | null;
  /** Newest first, at most LEVEL_UP_CAP. */
  levelUps: LevelUp[];
  /** Every level-up on record, (excluded) aside. */
  levelUpCount: number;
}

interface ProgRow {
  source: string; kind: string; key: string; active_s: number; xp: number; level: number; tier: string;
  xp_into_level: number; xp_to_next: number | null; s_to_next: number | null; stars: number;
  first_day: string; last_day: string;
}
interface PaceRow {
  source: string; as_of_day: string; xp_today: number; xp_7d: number; xp_28d: number; pace_xp_per_day: number;
  eta_next_days: number | null; eta_99_days: number | null; streak_current: number; streak_best: number;
}
interface UpRow { source: string; kind: string; key: string; level: number; day: string; tier: string; tier_changed: number }

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const EXCLUDED = "(excluded)";

const labelOf = (kind: string, key: string): string => (kind === "project" ? projectLabel(key) : key);

/** A stored day count after a stored day, as a date. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function toSkill(r: ProgRow): Skill {
  return {
    key: r.key,
    label: labelOf(r.kind, r.key),
    level: {
      source: r.source as AgentSource, activeS: r.active_s, xp: r.xp, level: r.level, tier: r.tier,
      xpIntoLevel: r.xp_into_level, xpToNext: r.xp_to_next, sToNext: r.s_to_next, stars: r.stars,
    },
    firstDay: r.first_day,
    lastDay: r.last_day,
  };
}

function toPace(r: PaceRow | undefined): Pace | null {
  if (r === undefined) return null;
  return {
    asOfDay: r.as_of_day, xpToday: r.xp_today, xp7d: r.xp_7d, xp28d: r.xp_28d, perDay: r.pace_xp_per_day,
    etaNextDays: r.eta_next_days, eta99Days: r.eta_99_days,
    date99: r.eta_99_days === null ? null : addDays(r.as_of_day, r.eta_99_days),
    streakCurrent: r.streak_current, streakBest: r.streak_best,
  };
}

export function readCharacter(db: string, opts: { now?: number; home?: string } = {}): CharacterData {
  const generatedAt = opts.now ?? Math.floor(Date.now() / 1000);
  if (!hasTable(db, "skill_progress")) {
    return { generatedAt, pending: true, tools: [], totalLevel: null, all: null, levelUps: [], levelUpCount: 0 };
  }
  const levels = readLevels(db);
  const shown: AgentSource[] = ["claude"];
  for (const s of ["codex", "hermes"] as const) {
    if (toolStatus(db, s, opts.home ?? os.homedir()).state !== "not-installed") shown.push(s);
  }

  const prog = read<ProgRow>(db, `SELECT source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next,
      s_to_next, stars, first_day, last_day FROM skill_progress WHERE kind <> 'tool'
      ORDER BY level DESC, xp DESC, key;`);
  const pace = new Map(read<PaceRow>(db, `SELECT * FROM skill_pace;`).map((r) => [r.source, r]));

  const tools: ToolCharacter[] = shown.map((source) => {
    const mine = prog.filter((r) => r.source === source);
    const projects = mine.filter((r) => r.kind === "project");
    return {
      source,
      label: AGENT_LABEL[source],
      state: levels[source],
      pace: toPace(pace.get(source)),
      projects: projects.filter((r) => r.key !== EXCLUDED).map(toSkill),
      excludedHidden: projects.some((r) => r.key === EXCLUDED),
      models: mine.filter((r) => r.kind === "model").map(toSkill),
    };
  });

  const notExcluded = `NOT (kind = 'project' AND key = '${EXCLUDED}')`;
  const ups = read<UpRow>(db, `SELECT source, kind, key, level, day, tier, tier_changed FROM skill_level_ups
      WHERE ${notExcluded} ORDER BY day DESC, source, kind, key, level DESC LIMIT ${LEVEL_UP_CAP};`);
  const count = read<{ n: number }>(db, `SELECT COUNT(*) AS n FROM skill_level_ups WHERE ${notExcluded};`)[0].n;

  return {
    generatedAt,
    pending: false,
    tools,
    totalLevel: totalLevel(tools.map((t) => t.state)),
    all: toPace(pace.get("all")),
    levelUps: ups.map((u) => ({
      day: u.day, source: u.source as AgentSource, kind: u.kind as SkillKind, key: u.key,
      label: u.kind === "tool" ? AGENT_LABEL[u.source as AgentSource] : labelOf(u.kind, u.key),
      level: u.level, tier: u.tier, tierChanged: u.tier_changed === 1,
    })),
    levelUpCount: count,
  };
}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/read-character.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/read/character.ts tests/read-character.test.ts
git commit -m "read: the Character page's skills, pace and level-ups"
```

---

### Task 4: The page — render, nav, report, Overview links, budget

**Files:**
- Create: `lib/render/character.ts`
- Create: `tests/render-character.test.ts`
- Modify: `lib/render/empty.ts` (append five strings)
- Modify: `lib/render/level.ts:20` (export `meter`)
- Modify: `lib/render/layout.ts`
  - `card` (~line 64);
  - the sidebar CSS (~line 279);
  - the tile CSS beside `.g-2` (~line 118);
  - `TOOLS` (~line 295);
  - `toolRow` (~line 306).
- Modify: `lib/render/overview.ts` (`toolCard`, `overviewSections`, `overviewView`)
- Modify: `lib/render/report.ts:89,105-110`
- Modify: `lib/views.ts:78`
- Modify: `tests/report-budget.test.ts` (`PER_WEEK_LIMIT`)

**Interfaces:**
- Consumes: `readCharacter`, `CharacterData`, `ToolCharacter`, `Skill`, `Pace`, `LevelUp`,
  `LEVEL_UP_CAP` (Task 3).
- Produces:
  - `characterView(d: CharacterData, opts?: { served?: boolean; tz?: string }): View`;
  - `characterAnchor(s: AgentSource): string`;
  - `characterHref(s: AgentSource, served: boolean): string`;
  - `REPORT_LEVEL_UPS = 30`;
  - the route `/character`.

- [ ] **Step 1: Write the failing render tests**

Create `tests/render-character.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CharacterData, LevelUp, Pace, Skill, ToolCharacter } from "@/lib/read/character";
import type { Level } from "@/lib/read/level";
import { characterHref, characterView, REPORT_LEVEL_UPS } from "@/lib/render/character";
import { TOOLS, page } from "@/lib/render/layout";
import { REPORT_ROWS } from "@/lib/render/sessions";

// Stage 6, Task 4. The page labels stored values; these feed it data directly.

const lv = (over: Partial<Level> = {}): Level => ({
  source: "codex", activeS: 149400, xp: 216370, level: 57, tier: "Intermediate",
  xpIntoLevel: 13116, xpToNext: 8096, sToNext: 5590, stars: 0, ...over,
});
const pace = (over: Partial<Pace> = {}): Pace => ({
  asOfDay: "2026-09-30", xpToday: 144, xp7d: 1200, xp28d: 434, perDay: 15.5,
  etaNextDays: 15, eta99Days: 840810, date99: "4328-06-11", streakCurrent: 3, streakBest: 9, ...over,
});
const skill = (key: string, over: Partial<Level> = {}): Skill =>
  ({ key, label: key, level: lv(over), firstDay: "2026-08-01", lastDay: "2026-09-30" });
const tool = (over: Partial<ToolCharacter> = {}): ToolCharacter => ({
  source: "codex", label: "Codex", state: { state: "level", level: lv() }, pace: pace(),
  projects: [skill("TheOneOS")], excludedHidden: false, models: [skill("gpt-5.5")], ...over,
});
const up = (i: number, over: Partial<LevelUp> = {}): LevelUp => ({
  day: `2026-09-${String(30 - (i % 28)).padStart(2, "0")}`, source: "codex", kind: "project", key: `k${String(i).padStart(2, "0")}`,
  label: `k${String(i).padStart(2, "0")}`, level: 12, tier: "Apprentice", tierChanged: false, ...over,
});
const data = (over: Partial<CharacterData> = {}): CharacterData => ({
  generatedAt: 1790766000, pending: false, tools: [tool()], totalLevel: 57, all: pace(), levelUps: [up(0)], levelUpCount: 1, ...over,
});
const html = (d: CharacterData, served = true) => characterView(d, { served, tz: "UTC" }).body;

describe("characterView", () => {
  it("draws a tile per tool with a level, Lv N/99, and the Total level", () => {
    const h = html(data());
    expect(h).toContain(`Lv 57<span class="muted">/99</span>`);
    expect(h).toContain(`href="#character-codex"`);
    expect(h).toContain(`id="character-codex"`);
    expect(h).toContain("Total level");
  });

  // Review Focus 3.
  it("at 99 shows stars and no ETA", () => {
    const top = lv({ level: 99, tier: "Master", xpToNext: null, sToNext: null, stars: 2 });
    const h = html(data({ tools: [tool({ state: { state: "level", level: top }, pace: pace({ etaNextDays: null, eta99Days: null, date99: null }) })] }));
    expect(h).toContain("★×2");
    expect(h).not.toContain("<span>next level</span>");
    expect(h).not.toContain("<span>99</span>");
  });

  it("says when the next level and 99 land, at the 28-day pace", () => {
    const h = html(data());
    expect(h).toContain("in 15 days");
    expect(h).toContain("by 4328-06-11");
    expect(h).toContain("at your 28-day pace");
    expect(h).toContain("15.5 XP a day");
  });

  // Review Focus 4.
  it("escapes every name", () => {
    const nasty = "<o'brien & co>";
    const h = html(data({
      tools: [tool({ projects: [skill(nasty)], models: [skill(nasty)] })],
      levelUps: [up(0, { label: nasty })],
    }));
    expect(h).not.toContain(nasty);
    expect(h).toContain("&lt;o&#39;brien &amp; co&gt;");
  });

  it("names the skill path and the tier change in the level-up log", () => {
    const h = html(data({ levelUps: [up(0, { label: "TheOneOS", level: 10, tierChanged: true })] }));
    expect(h).toContain("Codex › project › TheOneOS");
    expect(h).toContain("→ Apprentice");
  });

  // Review Focus 5.
  it("renders every empty state", () => {
    const none: ToolCharacter = tool({
      state: { state: "none", activeS: 0 }, projects: [], models: [],
      pace: pace({ xpToday: 0, xp7d: 0, xp28d: 0, perDay: 0, etaNextDays: null, eta99Days: null, date99: null, streakCurrent: 0, streakBest: 0 }),
    });
    const h = html(data({ tools: [none], totalLevel: null, all: none.pace, levelUps: [], levelUpCount: 0 }));
    for (const s of ["No driven hours yet.", "No projects with driven hours yet.", "No models with driven hours yet.",
                     "No level-ups yet.", "no pace in the last 28 days"]) expect(h).toContain(s);
    for (const s of ["Lv 1<", "0 XP", "NaN", "in 0 days"]) expect(h).not.toContain(s);
  });

  it("is pending, as one card, before the v8 rollup has run", () => {
    const h = html(data({ pending: true, tools: [], all: null, levelUps: [], levelUpCount: 0, totalLevel: null }));
    expect(h).toContain("level pending");
    expect(h).toContain("Watchtower&#39;s rollup has not run since its v8 install");
  });

  it("hides (excluded) with a caption", () => {
    expect(html(data({ tools: [tool({ excludedHidden: true })] })))
      .toContain("Excluded projects are hidden here; their time still counts toward the tool.");
  });

  it("cuts the report to the newest level-ups and REPORT_ROWS sub-skills, with notes", () => {
    const many = Array.from({ length: 45 }, (_, i) => up(i));
    const projects = Array.from({ length: REPORT_ROWS + 10 }, (_, i) => skill(`p${String(i).padStart(3, "0")}`));
    const d = data({ levelUps: many, levelUpCount: 45, tools: [tool({ projects })] });
    const report = html(d, false);
    expect(report).toContain(`the ${REPORT_LEVEL_UPS} newest of 45 level-ups`);
    // A level-up's skill cell is its whole path: "Codex › project › k29".
    expect(report).toContain(`› k${String(REPORT_LEVEL_UPS - 1).padStart(2, "0")}<`);
    expect(report).not.toContain(`› k${REPORT_LEVEL_UPS}<`);
    expect(report).toContain(`the ${REPORT_ROWS} highest of ${REPORT_ROWS + 10} projects`);
    const served = html(d, true);
    expect(served).toContain("› k44<");
    expect(served).not.toContain("newest of 45");
  });
});

describe("Character in the nav and on the Overview", () => {
  it("sits in the tool row after the Overview, and is current on its own page", () => {
    expect(TOOLS.map((t) => t.label)).toEqual(["Overview", "Character", "Claude Code", "Codex", "Hermes"]);
    const p = page({ title: "x", active: "/character", body: "" });
    expect(p).toContain(`<span class="pill on t-character" aria-current="true">Character</span>`);
  });

  it("links each level card to its section: the route served, the anchor in the report", () => {
    expect(characterHref("claude", true)).toBe("/character#character-claude");
    expect(characterHref("claude", false)).toBe("#character-claude");
  });
});
```

In `tests/render-overview.test.ts`, add inside `describe("overviewView", …)`, using that file's own
`data()` and `html()` helpers:

```ts
  // Stage 6 (R11): each level card links to its tool's Character section.
  it("links each level card to Character: the route served, the anchor in the report", () => {
    expect(overviewView(data(), { tz: "UTC", served: true }).body).toContain(`href="/character#character-claude"`);
    expect(html(data())).toContain(`href="#character-claude"`);
    expect(html(data())).not.toContain(`href="/character`);
  });
```

In `tests/sources-report.test.ts`, add beside the other `buildReport` tests, with that file's
`NOW`:

```ts
  // Stage 6: Character is one article, reached from the tool row, not the page row.
  it("stacks Character into the report, linked from the tool row only", () => {
    const home = mkdtempSync(path.join(tmpdir(), "wt-char-rep-home-"));
    const html = buildReport({ db: buildAndRoll("resumed"), now: NOW, tz: "UTC", home });
    expect(html.split(`<article class="view" id="character">`)).toHaveLength(2);
    expect(html).toContain(`<a class="pill t-character" href="#character">Character</a>`);
    const pages = html.slice(html.indexOf(`<nav class="pages"`), html.indexOf("</nav>", html.indexOf(`<nav class="pages"`)));
    expect(pages).not.toContain(`href="#character"`);
  });
```

Run: `npx vitest run tests/render-character.test.ts`
Expected: FAIL with "Cannot find module '@/lib/render/character'".

- [ ] **Step 2: Strings, `meter`, `card` ids, the nav, and tile CSS**

Append to `lib/render/empty.ts`:

```ts
/** Stage 6, the Character page (spec §5). */
export const LEVEL_PENDING_WHY_V8 = "Watchtower's rollup has not run since its v8 install";
export const NO_PACE = "no pace in the last 28 days";
export const AT_PACE = "at your 28-day pace";
export const NO_LEVEL_UPS = "No level-ups yet.";
export const EXCLUDED_HIDDEN = "Excluded projects are hidden here; their time still counts toward the tool.";
export const noSubSkills = (what: "projects" | "models"): string => `No ${what} with driven hours yet.`;
```

In `lib/render/level.ts`, change `function meter(l: Level): string {` to
`export function meter(l: Level): string {`.

In `lib/render/layout.ts`:
- `card`:

```ts
export function card(opts: { title: string; body: string; hero?: boolean; wide?: boolean; id?: string }): string {
  const cls = ["c", opts.hero ? "hero" : "", opts.wide ? "wide" : ""].filter(Boolean).join(" ");
  const id = opts.id === undefined ? "" : ` id="${esc(opts.id)}"`;
  return `<section class="${cls}"${id}><h2>${esc(opts.title)}</h2>${opts.body}</section>`;
}
```

- After the `.g-2 { … }` rule, add:

```css
.g-tiles { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); margin-top: 8px; }
a.tile { display: block; text-decoration: none; color: inherit; }
```

- In the sidebar block, change `html[data-nav=sidebar] .t-overview { order: 2; }` to
  `html[data-nav=sidebar] .t-overview, html[data-nav=sidebar] .t-character { order: 2; }`.
- `TOOLS`:

```ts
/** Every tool, the Overview and Character: real links since Stage 5 (spec §5 Nav; Stage 6 §5). */
export const TOOLS: ToolLink[] = [
  { label: "Overview", href: "/overview", cls: "t-overview" },
  { label: "Character", href: "/character", cls: "t-character" },
  { label: "Claude Code", href: "/", cls: "tool-cc" },
  { label: "Codex", href: "/codex", cls: "t-agent" },
  { label: "Hermes", href: "/hermes", cls: "t-agent" },
];
```

- In `toolRow`, replace the `return (…)` with the grouping below. Pills are grouped by
  class, not by position, so adding a tool cannot misplace one.

```ts
  const all = tools.filter((t) => t.cls !== "t-agent").map(pill).join("");
  const agents = tools.filter((t) => t.cls === "t-agent").map(pill).join("");
  return (
    `<nav class="tools" aria-label="Tools">` +
    `<span class="grp grp-all">All tools</span>${all}` +
    `<span class="grp grp-agents">Agents</span>${agents}` +
    `</nav>`
  );
```

- [ ] **Step 3: Write the renderer**

Create `lib/render/character.ts`:

```ts
/**
 * The Character page (Stage 6, spec §5): an OSRS-style skills tab. Every tool
 * is a skill, its projects and models are sub-skills, and the page shows pace,
 * streaks and the level-up log. It labels what the rollup stored. Its only
 * arithmetic is a meter's percent (level.ts) and seconds shown as hours.
 */
import { LEVEL_UP_CAP, type CharacterData, type LevelUp, type Pace, type Skill, type ToolCharacter } from "../read/character.ts";
import { AGENT_LABEL, type AgentSource } from "../read/level.ts";
import { sortableTable, type SortCell, type SortColumn } from "./charts.ts";
import {
  AT_PACE, EXCLUDED_HIDDEN, LEVEL_PENDING, LEVEL_PENDING_WHY_V8, NO_DRIVEN_HOURS, NO_LEVEL_UPS, NO_PACE, noSubSkills,
} from "./empty.ts";
import { esc, grouped, localZone, num, stamp } from "./html.ts";
import { card, type View } from "./layout.ts";
import { formatXp, levelBlock, meter } from "./level.ts";
import { REPORT_ROWS } from "./sessions.ts";

/** The report lists this many level-ups; served, the reader's LEVEL_UP_CAP. */
export const REPORT_LEVEL_UPS = 30;

/** A tool's section: the same id served and in the report, which stacks every view in one file. */
export const characterAnchor = (s: AgentSource): string => `character-${s}`;
/** Where an Overview level card links: the route when served, the in-file anchor in the report (R11). */
export const characterHref = (s: AgentSource, served: boolean): string =>
  `${served ? "/character" : ""}#${characterAnchor(s)}`;

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;
const DASH = `<span class="absent">—</span>`;
const days = (n: number) => `${grouped(n)} ${n === 1 ? "day" : "days"}`;
/** R10: a window with no XP is "none", never "0 XP". */
const gain = (xp: number) => (xp > 0 ? `<b>+${esc(formatXp(xp))} XP</b>` : absent("none"));
const perDay = (p: number) => `${p >= 100 ? grouped(Math.floor(p)) : num(p, 1)} XP a day`;
const paceKv = (p: Pace) => kv("pace · 28 days", p.xp28d > 0 ? `<b>${perDay(p.perDay)}</b>` : absent(NO_PACE));
const streak = (p: Pace) =>
  p.streakBest > 0 ? `<b>${days(p.streakCurrent)} · best ${days(p.streakBest)}</b>` : absent("none");
const atPace = `<span class="muted"> ${esc(AT_PACE)}</span>`;

function characterCard(d: CharacterData): string {
  const total = d.totalLevel === null ? `<div class="big absent">—</div>` : `<div class="big">${d.totalLevel}</div>`;
  const a = d.all;
  const facts = a === null ? "" : [
    kv("XP today", gain(a.xpToday)), kv("XP · 7 days", gain(a.xp7d)), paceKv(a), kv("streak", streak(a)),
  ].join("");
  return card({ title: "Character", hero: true, body: total + `<div class="muted label">total level</div><div class="block">${facts}</div>` });
}

function tile(t: ToolCharacter): string {
  if (t.state.state !== "level") return "";
  const l = t.state.level;
  const stars = l.stars > 0
    ? ` <span class="stars" aria-label="${l.stars} ${l.stars === 1 ? "star" : "stars"} past 99">★×${l.stars}</span>` : "";
  return `<a class="c tile" href="#${characterAnchor(t.source)}"><h2>${esc(t.label)}</h2>` +
    `<div class="big lv">Lv ${l.level}<span class="muted">/99</span></div>` +
    `<div class="muted label">${esc(l.tier)}${stars}</div>${meter(l)}</a>`;
}

function skillsCard(d: CharacterData): string {
  const tiles = d.tools.map(tile).join("");
  const grid = tiles === "" ? `<div class="state absent">${esc(NO_DRIVEN_HOURS)}</div>` : `<div class="g g-tiles">${tiles}</div>`;
  const foot = kv("Total level", d.totalLevel === null ? absent("—") : `<b>${d.totalLevel}</b>`);
  return card({ title: "Skills", wide: true, body: grid + `<div class="block">${foot}</div>` });
}

function paceBlock(p: Pace | null): string {
  if (p === null) return "";
  return [
    kv("XP today", gain(p.xpToday)), kv("XP · 7 days", gain(p.xp7d)), kv("XP · 28 days", gain(p.xp28d)),
    paceKv(p),
    p.etaNextDays === null ? "" : kv("next level", `<b>in ${days(p.etaNextDays)}</b>${atPace}`),
    p.date99 === null ? "" : kv("99", `<b>by ${esc(p.date99)}</b>${atPace}`),
    kv("streak", streak(p)),
  ].join("");
}

const COLS: SortColumn[] = [
  { key: "skill", label: "Skill" }, { key: "lv", label: "Lv", num: true }, { key: "tier", label: "Tier" },
  { key: "xp", label: "XP", num: true }, { key: "next", label: "XP to next", num: true },
  { key: "hours", label: "Hours", num: true }, { key: "first", label: "First" }, { key: "last", label: "Last" },
];

function skillRow(s: Skill): { cells: Record<string, SortCell> } {
  const l = s.level;
  return {
    cells: {
      skill: { html: esc(s.label), sort: s.label },
      lv: { html: String(l.level), sort: l.level },
      tier: { html: esc(l.tier), sort: l.level },
      xp: { html: esc(formatXp(l.xp)), sort: l.xp },
      next: l.xpToNext === null ? { html: DASH, sort: null } : { html: esc(formatXp(l.xpToNext)), sort: l.xpToNext },
      hours: { html: `${num(l.activeS / 3600, 1)}h`, sort: l.activeS },
      first: { html: esc(s.firstDay), sort: s.firstDay },
      last: { html: esc(s.lastDay), sort: s.lastDay },
    },
  };
}

function skillTable(t: ToolCharacter, what: "projects" | "models", served: boolean): string {
  const all = what === "projects" ? t.projects : t.models;
  const shown = served ? all : all.slice(0, REPORT_ROWS);
  const cut = shown.length < all.length
    ? `<p class="note">This report lists the ${REPORT_ROWS} highest of ${grouped(all.length)} ${what}; serve the dashboard for all of them.</p>`
    : "";
  const excluded = what === "projects" && t.excludedHidden ? `<p class="note">${esc(EXCLUDED_HIDDEN)}</p>` : "";
  return card({
    title: `${t.label} · ${what}`, wide: true,
    body: sortableTable(COLS, shown.map(skillRow), { empty: noSubSkills(what) }) + cut + excluded,
  });
}

function toolSection(t: ToolCharacter, served: boolean): string {
  return card({
    id: characterAnchor(t.source), title: t.label, wide: true,
    body: levelBlock(t.state, t.source) + `<div class="block">${paceBlock(t.pace)}</div>`,
  }) + skillTable(t, "projects", served) + skillTable(t, "models", served);
}

const UP_COLS: SortColumn[] = [
  { key: "day", label: "Day" }, { key: "skill", label: "Skill" }, { key: "lv", label: "Level", num: true },
  { key: "tier", label: "Tier" },
];

const pathOf = (u: LevelUp) =>
  u.kind === "tool" ? AGENT_LABEL[u.source] : `${AGENT_LABEL[u.source]} › ${u.kind} › ${u.label}`;

function levelUpsCard(d: CharacterData, served: boolean): string {
  const shown = served ? d.levelUps : d.levelUps.slice(0, REPORT_LEVEL_UPS);
  const note = shown.length >= d.levelUpCount ? ""
    : served
      ? `<p class="note">Showing the ${grouped(shown.length)} newest of ${grouped(d.levelUpCount)} level-ups.</p>`
      : `<p class="note">This report lists the ${grouped(shown.length)} newest of ${grouped(d.levelUpCount)} level-ups; serve the dashboard for up to ${grouped(LEVEL_UP_CAP)}.</p>`;
  const rows = shown.map((u) => ({
    cells: {
      day: { html: esc(u.day), sort: u.day },
      skill: { html: esc(pathOf(u)), sort: pathOf(u) },
      lv: { html: `Lv ${u.level}`, sort: u.level },
      tier: u.tierChanged ? { html: `→ ${esc(u.tier)}`, sort: u.level } : { html: "", sort: null },
    } as Record<string, SortCell>,
  }));
  return card({ title: "Level-ups", wide: true, body: sortableTable(UP_COLS, rows, { empty: NO_LEVEL_UPS }) + note });
}

export function characterView(d: CharacterData, opts: { served?: boolean; tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const served = opts.served === true;
  const body = d.pending
    ? card({ title: "Character", body: `<div class="state absent">${esc(LEVEL_PENDING)}</div><div class="muted">${esc(LEVEL_PENDING_WHY_V8)}</div>` })
    : characterCard(d) + skillsCard(d) + d.tools.map((t) => toolSection(t, served)).join("") + levelUpsCard(d, served);
  return {
    href: "/character",
    title: "Character",
    body,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · levels are lifetime; pace and streaks as of ${d.all?.asOfDay ?? "—"}, local days · ` +
      `from skill_progress, skill_pace, skill_level_ups and agent_progress · hours count driven sessions only`,
  };
}
```

The "escapes every name" test checks that `<td>` text is escaped. If `sortableTable` writes
`data-sort` from `esc`, the raw `nasty` string does not appear there either.

- [ ] **Step 4: Route, report tool row, and Overview links**

In `lib/views.ts`:
- import `readCharacter` from `./read/character.ts` and `characterView` from
  `./render/character.ts`;
- add, directly after the `/overview` entry:

```ts
  { href: "/character", ranged: false, build: (c) => characterView(readCharacter(c.db, { now: c.now, home: c.home }), { served: c.served, tz: c.tz }) },
```

and change the `/overview` entry's options to `{ tz: c.tz, served: c.served }`.

In `lib/render/report.ts`:
- change `const TOOL_ROW = new Set(["/overview", "/codex", "/hermes"]);` to
  `new Set(["/overview", "/character", "/codex", "/hermes"]);`;
- in the `tools:` array, add `{ label: "Character", href: "#character", cls: "t-character" },`
  after the Overview entry;
- update the comment above `TOOL_ROW` to name Character.

In `lib/render/overview.ts`:
- import `characterHref` from `./character.ts`;
- add a `served: boolean` parameter to `toolCard` (last) and to `overviewSections`, which
  passes it through;
- `overviewView`'s opts become `{ tz?: string; served?: boolean }`, passing
  `opts.served === true`;
- in `toolCard`, add this constant:

```ts
  const more = `<p class="note"><a href="${esc(characterHref(t.source, served))}">Skills, pace and level-ups →</a></p>`;
```

and put `+ more` after `levelBlock(t.level, t.source)` in both the `pending` return and the
final return.

Run: `npx vitest run tests/render-character.test.ts tests/render-overview.test.ts tests/sources-report.test.ts tests/serve.test.ts && npm run typecheck`
Expected: PASS. If an existing layout or report test pins the old four-entry tool row, update
its expected markup to the five entries and name the change in the report. That is the only
pre-existing test edit allowed here.

- [ ] **Step 5: Pin `/character`'s bytes per week**

In `tests/report-budget.test.ts`, add `character: 0,` to `PER_WEEK_LIMIT`, then run:

`npx vitest run tests/report-budget.test.ts -t "pinned bytes per week"`

- If it fails with `character: N B/week, over 0`, pin `character` at N × 1.15, rounded up to
  the next 10, but never under 50.
- If it passes at 0, pin 50, the floor every flat page has.
- If `total` is reported over, raise it by the `character` pin.

Add one line to the measurement comment above `describe(…)`:
"Stage 6 adds Character: N B/week measured (its level-up log is cut to 30 in the report and
its tables to REPORT_ROWS), pinned at …". Re-run until green.

- [ ] **Step 6: Run everything and commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`
Expected: all green.

```bash
git add lib/render/character.ts lib/render/empty.ts lib/render/level.ts lib/render/layout.ts lib/render/overview.ts \
        lib/render/report.ts lib/views.ts tests/render-character.test.ts tests/render-overview.test.ts \
        tests/sources-report.test.ts tests/report-budget.test.ts
git commit -m "Character page: skills grid, sub-skill tables, pace, streaks and the level-up log"
```

(Add any other test file Step 4 had to touch.)

---

### Task 5: Live proof, `SESSION.md`, `CLAUDE.md`

**Files:**
- Modify: `SESSION.md` (a new `## Session 19` entry at the top)
- Modify: `CLAUDE.md`

Every command runs on `.backup` copies under the scratchpad, never on the live DB.

- [ ] **Step 1: Make two identical copies, and roll each with its own code**

```bash
P="$TMPDIR/stage6-proof"; rm -rf "$P"; mkdir -p "$P/main" "$P/branch"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup '$P/main/db.sqlite'"
sqlite3 "$P/main/db.sqlite" ".backup '$P/branch/db.sqlite'"
git show main:capture/rollup.sh > "$P/main-rollup.sh"; git show main:capture/lib.sh > "$P/main-lib.sh"
( export THEONE_DB_PATH="$P/main/db.sqlite" WATCHTOWER_DB_PATH="$P/main/db.sqlite" CC_LIB_PATH="$P/main-lib.sh"
  time bash "$P/main-rollup.sh" --quiet )
( export THEONE_DB_PATH="$P/branch/db.sqlite" WATCHTOWER_DB_PATH="$P/branch/db.sqlite" CC_LIB_PATH="$PWD/capture/lib.sh"
  time bash capture/rollup.sh --quiet )
```

Record both wall times. **The branch may add at most 1 s.**

- [ ] **Step 2: Claude's tables and `agent_progress` are unchanged**

```bash
for t in claude_daily_rollups claude_project_rollups claude_rank_progress claude_profile_daily \
         claude_discipline_scores claude_prices claude_request_metrics claude_turns \
         agent_prices agent_request_metrics agent_daily_rollups agent_progress; do
  cols=$(sqlite3 "$P/main/db.sqlite" "SELECT group_concat(name, ',') FROM pragma_table_info('$t') WHERE name NOT IN ('updated_at')")
  sqlite3 -bail "$P/main/db.sqlite" "ATTACH '$P/branch/db.sqlite' AS b;
    SELECT '$t', (SELECT COUNT(*) FROM main.$t),
      (SELECT COUNT(*) FROM (SELECT $cols FROM main.$t EXCEPT SELECT $cols FROM b.$t)),
      (SELECT COUNT(*) FROM (SELECT $cols FROM b.$t EXCEPT SELECT $cols FROM main.$t));"
done
```

Expected: twelve lines, each `table|N|0|0` with N > 0. Empty output is a failure.
- If a table carries another clock column (for example `computed_at`), add it to the
  `NOT IN` list and name it in the report.
- `claude_daily_rollups` must match to the row: it is the proof that `_act`'s refactor moved
  nothing.

- [ ] **Step 3: The identities, and `(no model)`**

```bash
sqlite3 -bail "$P/branch/db.sqlite" "
WITH t AS (SELECT source, day, active_ms FROM skill_daily WHERE kind = 'tool'),
     m AS (SELECT source, day, SUM(active_ms) AS ms FROM skill_daily WHERE kind = 'model' GROUP BY 1, 2),
     p AS (SELECT source, day, SUM(active_ms) AS ms FROM skill_daily WHERE kind = 'project' GROUP BY 1, 2)
SELECT 'mismatched days', COUNT(*) FROM t LEFT JOIN m USING (source, day) LEFT JOIN p USING (source, day)
 WHERE m.ms IS NOT t.active_ms OR p.ms IS NOT t.active_ms;
SELECT 'orphan days', COUNT(*) FROM (SELECT source, day FROM skill_daily WHERE kind <> 'tool'
  EXCEPT SELECT source, day FROM skill_daily WHERE kind = 'tool');
SELECT 'claude (no model) h', ROUND(SUM(active_ms) / 3600000.0, 1) FROM skill_daily
 WHERE source = 'claude' AND kind = 'model' AND key = '(no model)';
SELECT source, kind, key, level, tier, ROUND(active_s / 3600.0, 1) AS h FROM skill_progress
 WHERE kind <> 'tool' ORDER BY source, kind, active_s DESC;"
```

Expected:
- `mismatched days|0`;
- `orphan days|0`;
- `(no model)` about 2.4 h (spec §3), not 46.3.

Keep the top three projects and models per tool for `SESSION.md`.

- [ ] **Step 4: One level-up day by hand**

Pick Claude's tool row and its current level L from `skill_progress`. Run:

```bash
sqlite3 -bail "$P/branch/db.sqlite" "
SELECT day, (SUM(active_ms) OVER (ORDER BY day) / 1000) * 13034431 / 9000000 AS xp
FROM skill_daily WHERE source = 'claude' AND kind = 'tool' ORDER BY day;" | tail -15
sqlite3 "$P/branch/db.sqlite" "SELECT level, day FROM skill_level_ups WHERE source = 'claude' AND kind = 'tool' ORDER BY level DESC LIMIT 3;"
```

The day stored for L must be the first day whose running XP is at least `xp(L)`, from the
thresholds list. Write the check out in the report.

- [ ] **Step 5: The page and the report**

```bash
THEONE_DB_PATH="$P/branch/db.sqlite" WATCHTOWER_DB_PATH="$P/branch/db.sqlite" node bin/watchtower report --out "$P/report.html"
wc -c "$P/report.html"; grep -c 'id="character' "$P/report.html"
```

Record the size against the 2,000,000-byte budget. Open `$P/report.html` in the agent browser
(browseros-neo) and confirm the Character section renders:
- the tiles;
- the tables;
- the level-up log;
- no "NaN", "Lv 1" or "0 XP".

Describe what you saw in the report; a screenshot is optional.

- [ ] **Step 6: Docs**

`SESSION.md`: a new `## Session 19 — 2026-10-03 — Stage 6 (Character): skills, sub-skills,
pace, level-ups` entry at the top, in Session 18's shape:
- what shipped;
- the live proofs with their numbers;
- the guard plants: each, with the one test it reddened;
- Rulings R1–R12, one line each;
- the top sub-skills per tool;
- open items: pieces 2 (achievements and quests) and 3 (character attributes) are next, as
  their own specs.

`CLAUDE.md`:
- `CC_SCHEMA_VERSION` is **8**;
- the test count, from the final run's summary;
- in "Durable vs regenerable", a Stage 6 paragraph:
  - `claude_model_rollups` is filled by section 1;
  - the four `skill_*` tables are filled by the agent section's read phase and swap;
  - `_ag_tier` is the one tier `CASE`;
- a short **Character page** paragraph after the Performance page's: `/character`,
  `lib/read/character.ts` + `lib/render/character.ts`, unranged, in the tool row, reads only
  `skill_*` and `agent_progress`;
- under Testing conventions: `WATCHTOWER_ROLLUP_TODAY` pins the as-of day for pace and
  streaks; `roll(db, env)` passes it.

- [ ] **Step 7: Commit**

```bash
git add SESSION.md CLAUDE.md
git commit -m "docs: Stage 6 live proof, session 19 handoff"
```

---

## After the tasks

1. **One whole-branch review** (most capable model), against the spec and this plan. It reads
   the ledger's rulings first.
2. **At most one fix wave**, then one scoped re-review.
3. **Hand over:**
   - push the branch;
   - open the PR (no AI attribution);
   - give the user `! gh pr merge <N> --squash --delete-branch`;
   - then `! bash capture/install.sh` (the live v8 install) and `! watchtower sync`. The auto
     mode classifier blocks Claude from running any of these.

## Plan self-review (done while writing)

- **Spec coverage:**

  | Spec | Where |
  |---|---|
  | §4.0 | Task 1 Steps 5–7 and Task 2 Steps 4–7 |
  | §4.1 | Task 1 Step 1, plus R1's two columns |
  | §4.2 | Task 2 Step 5 `_sk_daily` |
  | §4.3 | Task 1 Step 5 and Task 2 Step 4 |
  | §4.4 | `_sk_prog` |
  | §4.5 | `_sk_ups` |
  | §4.6 | `_sk_d`, `_sk_win`, `_sk_runs`, `_sk_pace` |
  | §5 | Tasks 3–4, empty states in the Global Constraints |
  | §6.1 | Guard map |
  | §6.2 | Task 5 |
  | §7 | After the tasks |
  | §10.1, .2, .4 | Guard 2 |
  | §10.3 | Guard 1 |
  | §10.5 | The v8 upgrade test (Task 1 Step 2) and the reader's pending test (Task 3) |

- **Names, checked across tasks:**
  - `roll(db, env)`;
  - `readCharacter`, `CharacterData.levelUpCount`, `LEVEL_UP_CAP`;
  - `characterAnchor`, `characterHref`, `REPORT_LEVEL_UPS`;
  - `meter`, `noSubSkills`;
  - `_sk_progress` (staged) vs `_sk_prog` (keyed pipeline).
- **R21:** guard 1's agent plant moved off `(no model)` (R5) so it cannot redden guard 4's
  test. Review Focus 2 asserts neither pace nor `streak_current`.
