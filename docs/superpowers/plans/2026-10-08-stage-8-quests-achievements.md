# Stage 8 — Quests and achievements: weekly habit quests, tiered milestones, Quest and Achievement Points — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each week, Claude Code gets up to three quests aimed at its three weakest Usage Profile
disciplines. Each is measured over that Monday-to-Sunday week, against a target one step better
than last week. Every tool also earns dated bronze-to-platinum achievements from its history.
Both earn points (Quest Points and Achievement Points), shown on a new `/quests` page and on the
Character page's Skills card.

**Architecture:**
- `capture/rollup.sh` does all the math, and no existing number moves.
  - The as-of day (`_sk_today`) moves up, ahead of the profile section, which receives it as
    `_pf_asof`.
  - The profile section:
    - gains a `'wk'` window in `_pf_win`;
    - measures each (week, discipline) once, in `_pf_wk`;
    - picks and scores each week's quests (`_pf_qpick`, `_pf_quests`);
    - swaps in `claude_quests`.
  - The agent section's read phase builds `_ac_*` after `_sk_pace`, from tables it already
    holds. Its write phase swaps in `achievement_tiers` and `character_points`.
- `lib/read/quests.ts` and `lib/render/quests.ts` draw `/quests`, which only reads, groups and
  labels. `readCharacter` reads `character_points` for two rows on the Skills card.

**Tech stack:** bash, the `sqlite3` CLI (window functions), Node ≥ 22 with native type
stripping, vitest. **Zero runtime dependencies.**

**Spec (binding):** `docs/superpowers/specs/2026-10-08-stage-8-quests-achievements-design.md`,
approved 2026-10-08 (commit `b8a0c87`).
- Copy every table, column, rule and string from the spec or from this plan. Do not re-derive
  them.
- The spec's §2 decisions are settled and must not be re-asked.

**Branch:** `stage-8-quests-achievements`, which already exists. It holds the brainstorm
(`6eb98dc`), the spec (`b8a0c87`) and this plan, on top of `main` @ `67eb1ad`. Watchtower only:
TheOneOS reads none of the new tables and is untouched.

**Ledger:** `.superpowers/sdd/2026-10-08-stage-8-quests-achievements/` holds `progress.md` and
a `task-N-report.md` per task. It also holds this plan's inputs:
- **`task-1.patch`, `task-2.patch`, `task-3.patch`**: every change, tests included.
  - They were built from the validated prototype against `b8a0c87` and apply in order with
    `git apply`.
  - At each task's state, `npm run typecheck` is clean and the whole suite passes.
  - Every code block in this plan is cut from these patches by script, so the plan and the
    patches match byte for byte.
  - **Apply the patch; do not retype the code.** If a hunk does not apply, stop and report.
    Do not re-derive it.
- **`plants.py`**: guards 1–10's plants, run as `python3 plants.py <n> <file>`. It edits the
  file in place and fails loudly if its pattern is missing.
- **`plant-results.md`**: the whole suite under each plant on the final tree, recorded while
  this plan was written.

**Review shape (the user's standing preference):**
- No per-task review gates.
- Every task ends with:
  - its tests green;
  - `npm run typecheck` clean;
  - its guard plants recorded in its report;
  - a commit.
- After Task 4: **one** whole-branch review on the most capable model, then **at most one** fix
  wave.

---

## Rulings (the spec does not settle these; read at review)

- **R1: `claude_quests` gains `week_end`**, the week's Sunday, stored by the rollup.
  - It holds the dates for the page heading, the quest log, and Quester's and Perfect week's
    unlock days.
  - With it, neither the reader nor the page does any week arithmetic (spec §5).
- **R2: the spec's `_q_def`, `_q_pick` and `_q_rows` are `_pf_qdef`, `_pf_qpick` and
  `_pf_quests`.** `_pf_wkin` and `_pf_wk` sit beside them.
  - `tests/profile-rollup.test.ts` allows only `_pf_` temp writes in the profile read phase.
  - Its write-phase pattern requires `… FROM _pf_\w+ ORDER BY rowid`.
  - Full marks is the column `full_marks`, because `FULL` is an SQLite keyword.
- **R3: Regular and Wordsmith for Codex and Hermes read `_ag_s` (`SUM(driven)`) and `_ag_r`
  (`SUM(tokens_out)`).** These are the rows `_ag_daily` is built from. `_ag_daily` itself
  cannot be read here: its `COALESCE` columns are unnamed. The numbers are the same.
- **R4: `achievement_tiers` carries `updated_at`,** stamped
  `CAST(strftime('%s','now') AS INTEGER)` like every agent-section table. The lock test's
  insert pattern allows exactly that.
- **R5: guard 4 tests the absolute step with Ask first (security), not Clean run.**
  - Ask first runs through the same at-most absolute branch, and needs only hook events.
  - Clean run would also need tool coverage and tool errors.
  - `quest-ask-first` exists for this.
- **R6: guard 2's plant changes all four `'weekday 1'` in the `'wk'` branch.** Changing only
  some duplicates week keys and crashes the rollup, which is a crash, not a red test.
- **R7: no rollup test except guard 2's names a week by its date.** The others pick a week by
  position (`weeks(qw)[i]`), because guard 2's plant re-keys every week to a Sunday.
- **R8: guard 9's plant is on Perfect week**: each week's value is replaced by the current
  total.
  - The fixtures never reach 10 QP, so Quester's tiers stay locked.
  - Its test asserts two things:
    - the stored value equals the number of all-done weeks;
    - the unlock day is a quest week's Sunday, no earlier than the first all-done week's.
  - An exact-date assertion would also go red under guard 7's plant: both achievements are
    running totals.
- **R9: reader tests seed the three tables straight into a `cc_init_db` database.** No rollup
  runs, so no rollup plant can redden them.
- **R10: the 20-request gate appears in `lib/render/quests.ts` as `GATE_REQUESTS`.**
  - It only picks between "under 20 requests so far" and "no reading" for an open week's
    missing value. No number is derived from it.
  - `/profile` renders its gate from a stored NULL. A quest stores `requests` instead (spec
    §4.1).
- **R11: the spec's identity "`agent_progress`, `skill_*` and the Total are identical with and
  without the quest inputs" gets no new test.**
  - The Stage 5–7 suites pin those tables on their own fixtures, and they pass with no edit.
  - Task 4's step 4.3 compares them whole against `main` on live data.
- **R12: the rollup test files build each fixture once, in `beforeAll` (60 s).** Building
  several fixtures per test overran vitest's 5 s default under full-suite contention.
- **R13: `tests/sources-report.test.ts`'s fixture multiple goes from 4.4× to 4.5×.** The
  measured report is 287,250 B, against the 4.4× ceiling of 285,397 B.

## Global Constraints

- **All math lives in `capture/rollup.sh`.** `lib/` reads, groups, sorts and labels.
  - Its only arithmetic: a share × 100 shown as a percent, and tokens ÷ 1000 shown in
    thousands.
  - No step, full-marks value or tier threshold under `lib/`. `tests/quests-page.test.ts`
    allows only `0 1 10 20 100 1000` as numbers in the two new files.
- **No `MIN(gap,` under `lib/` or in any script but `rollup.sh`.** `MIN(gap, 300)` stays at
  exactly **4** copies and `MIN(gap, 14400)` at exactly **3**.
- **No existing number moves.**
  - All 18 tables of Task 4's step 4.3 are identical to `main`'s rollup on the same snapshot,
    `updated_at` aside.
  - The only fixture edits are the three new scenarios.
- **Rollup transactions:**
  - every intermediate is `CREATE TEMP TABLE _pf_…` or `_ac_…` inside its section's
    `BEGIN DEFERRED` read phase;
  - each write phase stays `DELETE` + `INSERT … SELECT … FROM <staged> ORDER BY rowid` pairs.
- **Schema:** `CC_SCHEMA_VERSION=10` in `capture/lib.sh` and `schemaVersion: 10` in
  `lib/config.ts`. A test pins the two together.
- **The page never shows** a missing value as `0`, `no data` as `missed`, a tool with no level
  as `Lv 0` or `Lv 1`, or `NaN`.
- **Strings, verbatim** (`lib/render/empty.ts`):
  - `Quests pending until the v10 rollup`
  - `Achievements pending until the v10 rollup`
  - `No quests yet: a quest needs a week with at least 20 requests before it.`
  - `No quests this week: nothing was measurable last week.`
  - `under 20 requests so far`
  - `no reading`
  - `No tiers unlocked yet.`
  - `No closed weeks with quests yet.`
  - The quest names: `Look before you leap`, `Lean cache`, `Travel light`, `Fresh start`,
    `Right tool`, `Ask first`, `Clean run`, `Variety pack`, `Signature move`, `Delegate`.
  - The tier names: `bronze`, `silver`, `gold`, `platinum`.
- **Tests:**
  - **R21:** each guard's literal values live in exactly one test. Every plant is run, and
    every test it reddens is recorded. More than one red is a finding for the report, not
    something to hide by weakening a test.
  - `TZ=UTC` is pinned by the helpers.
  - Run the suite as `npx vitest run --exclude '.claude/**'`.
- **The live system:**
  - Never test against `~/.theone/claude-code-usage.sqlite`. Copy it with `sqlite3 .backup`,
    each copy in its own directory, because the `.schema-vN` marker lives in the DB's
    directory.
  - Never run `install.sh` against the live `~/.claude`.
- **Git:**
  - Never touch or commit the untracked `.claude/`.
  - No `Co-Authored-By` and no AI attribution in any commit.
  - After each SDD script call, restore `.superpowers/sdd/.gitignore`.

## Review Focus

These are inputs the spec implies but its guards do not name. Each has a test in the task that
owns its code.

1. **A closed week before tool-call or hook coverage.** Its tool and event measures are NULL,
   never 0, so they are never quests. Pinned in "a week before tool and hook coverage gets no
   tool or event quest" (Task 1).
2. **A value equal to its target** (spec §10.2). Status compares the stored, rounded numbers,
   so a shown value equal to its target is `done`. Pinned in "a closed week's status follows its
   stored value and target" (Task 1).
3. **Weeks after the as-of day** (spec §10.4). `_pf_days` runs to today, but no week after
   `WATCHTOWER_ROLLUP_TODAY` gets rows. Pinned in "a week ends on the Sunday after it starts,
   and no week starts after the as-of day" (Task 1).
4. **A tool with no level** (spec §10.5). Codex is synced but has no driven hours: its Seasoned
   value is NULL and every tier stays locked. Pinned in "a tool with no level has no Seasoned
   value and nothing unlocked, never Lv 0" (Task 2). The page shows `—` (Task 3).
5. **A reader on a v9 database** (spec §10.6) reads "pending", never an error:
   - with no `claude_quests` table, or no `character_points` row;
   - and Character shows no point rows.
   Pinned in "is pending before the v10 rollup: no table, or no points row" and "reads Quest
   and Achievement Points, and none before the v10 rollup" (Task 3).

## Guard map (R21)

Each plant must turn exactly **one** test red. `plants.py <n>` applies it. A task's report
records the plant, every test it reddened, and the restore (`git checkout -- <file>`).

| # | Test (file › name) | Plant (`plants.py`) | Task |
|---|---|---|---|
| 1 | `quests-rollup` › a week's quests come from the scores before it starts | `s.day = date(w.week, '-1 day')` → `'+6 days'` in `_pf_qpick` | 1 |
| 2 | `quests-rollup` › a week runs Monday to Sunday | all four `'weekday 1'` → `'weekday 0'` in the `'wk'` branch | 1 |
| 3 | `quests-rollup` › a target stops at full marks and holds there | `MIN(q.moved, d.full_marks)` and `MAX(…)` → `q.moved` | 1 |
| 4 | `quests-rollup` › an at-most quest steps down | the four at-most steps in `_pf_qdef` made positive | 1 |
| 5 | `quests-rollup` › a quiet week is no data, never missed | drop `WHEN value IS NULL THEN 'no data'` | 1 |
| 6 | `quests-rollup` › the current week stays open | `CASE WHEN d0 BETWEEN lo AND hi` → `CASE WHEN 0` | 1 |
| 7 | `achievements-rollup` › each tier is dated the first day it was reached | `MIN(c.day)` → `MAX(c.day)` in `_ac_reach`'s running-total branch | 2 |
| 8 | `achievements-rollup` › achievement points weight each tier | `THEN d.tier ELSE 0` → `THEN 1 ELSE 0` in `_ac_tiers` | 2 |
| 9 | `achievements-rollup` › quest achievements date from their week | Perfect week's per-week value → the current count of perfect weeks | 2 |
| 10 | `read-character` › achievement unlocks stay out of the level-up log | `readCharacter` unions unlocked `achievement_tiers` into its level-ups and count | 3 |

## File map

| File | Change | Task |
|---|---|---|
| `capture/lib.sh` | `CC_SCHEMA_VERSION=10`; `claude_quests`, `achievement_tiers`, `character_points` | 1 |
| `lib/config.ts` | `schemaVersion: 10` | 1 |
| `capture/rollup.sh` | `_sk_today` moved ahead of the profile section; the `_pf_asof` prelude; the `'wk'` window; `_pf_qdef`, `_pf_wkin`, `_pf_wk`, `_pf_qpick`, `_pf_quests`; the `claude_quests` swap | 1 |
| `capture/rollup.sh` | Agent section: `_ac_def`, `_ac_cum`, `_ac_first`, `_ac_strong`, `_ac_val`, `_ac_reach`, `_ac_tiers`, `_ac_points`; two swaps | 2 |
| `tests/fixtures/make-fixture.sh` | Scenarios `quest-weeks`, `quest-sunday`, `quest-ask-first` | 1 |
| `tests/quests-rollup.test.ts` | New: guards 1–6, the quest identities, Review Focus 1–3 | 1 |
| `tests/capture-scripts.test.ts` | `schema v10`; v9's marker test reads the current version | 1 |
| `tests/config.test.ts` | `schemaVersion` 10 | 1 |
| `tests/achievements-rollup.test.ts` | New: guards 7–9, the achievement identities, Review Focus 4 | 2 |
| `tests/rollup-lock.test.ts` | `_ac_*` in the read phase; two swaps | 2 |
| `lib/read/quests.ts` | New: `readQuests`, the quest and achievement labels, types | 3 |
| `lib/render/quests.ts` | New: `questsView` | 3 |
| `lib/render/empty.ts` | Eight Stage 8 strings | 3 |
| `lib/read/character.ts`, `lib/render/character.ts` | `CharacterData.points`; two rows on the Skills card | 3 |
| `lib/views.ts`, `lib/render/layout.ts`, `lib/render/report.ts` | `/quests` after `/character`: `STATIC_VIEWS`, `TOOLS` (`t-quests`), the report's tool row | 3 |
| `tests/quests-page.test.ts` | New: the reader, the page, every state, the nav, the no-literal check | 3 |
| `tests/read-character.test.ts`, `tests/render-character.test.ts` | Guard 10; the points rows; the nav list | 3 |
| `tests/sources-report.test.ts`, `tests/report-budget.test.ts` | `/quests` in the list; 4.5× (R13); `quests: 320` B/week | 3 |
| `SESSION.md`, `CLAUDE.md` | Session 22; v10 tables; the as-of day in the profile section | 4 |

## Fixture reference

- **`quest-weeks`**, as of Wed 2026-09-09:
  - Six weeks of requests only. There are no tool calls and no hook events, so only
    cost-discipline, context-hygiene and model-routing are ever measured.
  - Every request falls on a Tuesday or a Wednesday, never a Sunday.
  - `qw_week <session> <date> <requests> <cache-read> <second-model-count>` builds a week.

| Week (Monday) | Requests | Shape | Quests (slot order, score) | Status |
|---|---|---|---|---|
| A 2026-08-03 | 20 | ctx 200,000, one model | none (no week before it) | — |
| B 2026-08-10 | 20 | as A | routing 0, cost 0, context 31; targets 0.05, 1800, 180,000 | all missed |
| C 2026-08-17 | 20 | ctx 10,000, two models 10/10 | routing 0, cost 0, context 31; values 0.5, 100, 10,000 | all done (the perfect week) |
| D 2026-08-24 | 5 | — | cost 0 (100 → 90), routing 28 (hold 0.35), context 31 (hold 60,000) | all no data |
| E 2026-08-31 | 20 | as A | none (D measured nothing) | — |
| F 2026-09-07 | 20 | as C | cost, routing 26, context 50; baselines from E; values 100, 0.5, 10,000 | all open |

  - Results: QP 3 and AP 1. Perfect week bronze unlocks on 2026-08-23, C's Sunday.

- **`quest-sunday`**, as of Wed 2026-08-19:
  - Week A has 20 requests on 08-04.
  - Week B has 19 requests on 08-11, plus one at 2026-08-16T23:00Z (its Sunday) in its own
    session.
  - Week 2026-08-10 therefore has three quests, each with 20 requests and a measured value.
- **`quest-ask-first`**, as of Wed 2026-08-12:
  - A `SessionStart` on 2026-07-01 starts hook coverage.
  - Weeks 08-04 and 08-11 each have 20 one-model requests and 10 prompts under
    `bypassPermissions`.
  - Week 08-10's quests are routing, cost and security. Security's baseline is 1.0 and its
    target 0.99, and it is open.
- **`codexDb()`** (`tests/achievements-rollup.test.ts`), as of 2026-09-30:
  - The `agent-drift` fixture, plus 100 driven Codex sessions from 2026-09-15T10:00Z, 60 s
    apart, with no events, so Codex has no hours and no level.
  - Three requests of 600,000 output tokens, on days 0, 2 and 4.
  - Results:
    - Regular bronze and silver on 2026-09-15.
    - Wordsmith bronze on 2026-09-17, with a value of 1,800,000.
    - AP 4 and QP 0.
    - Claude's Seasoned value is 35, with nothing unlocked.

---

## Tasks

### Task 1: Schema v10, the as-of day, the `'wk'` window and `claude_quests`

**Files:**
- Modify: `capture/lib.sh`, `lib/config.ts`, `capture/rollup.sh`, `tests/fixtures/make-fixture.sh`,
  `tests/capture-scripts.test.ts`, `tests/config.test.ts`
- Create: `tests/quests-rollup.test.ts`

**Interfaces:**
- Consumes: the profile section's existing `_pf_days`, `_pf_win`, `_pf_agg`, `_pf_medctx`,
  `_pf_long`, `_pf_tcday`, `_pf_slday`, `_pf_evday`, `_pf_modday`, `_pf_sdkday`,
  `_pf_coverage`, `_pf_evcov`, `_pf_scores` and `_pf_ev` (its `ord` is the display order).
- Produces:
  - `claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold,
    value, requests, status)`, with `status` in `open | done | missed | no data` and NULL
    `value` meaning not measured.
  - The bash variable `_sk_today`, set once before the profile section and read by the agent
    section's `_sk_asof` prelude.

- [ ] **Step 1.1: Write the failing tests**

```bash
L=.superpowers/sdd/2026-10-08-stage-8-quests-achievements
git apply --include='tests/*' "$L/task-1.patch"
```

This writes the following.

The three scenarios, in `tests/fixtures/make-fixture.sh`:

```diff
--- a/tests/fixtures/make-fixture.sh
+++ b/tests/fixtures/make-fixture.sh
@@ -1635,6 +1635,57 @@ case "$scenario" in
     req_skill km_r1 superpowers:brainstorming
     ev  S_SKMID $((6 * DAY + 32600)) Stop
     ;;
+  quest-weeks)
+    # Stage 8 (spec 4.2-4.4): six calendar weeks of requests only -- no tool
+    # call or hook event anywhere, so only cost-discipline, context-hygiene and
+    # model-routing can be measured, and every week with quests has exactly
+    # those three. No request falls on a Sunday, so moving a week's first day
+    # re-keys the weeks without moving any request between them (guard 2's
+    # plant reds only its own test).
+    #   A  Mon 2026-08-03  20 requests, ctx 200,000, one model  -> the first baseline
+    #   B  Mon 2026-08-10  the same as A                        -> quests, all missed
+    #   C  Mon 2026-08-17  ctx 10,000, two models 10/10         -> quests, all done
+    #   D  Mon 2026-08-24  5 requests                           -> quests, no data
+    #   E  Mon 2026-08-31  the same as A                        -> no quests (D measured nothing)
+    #   F  Mon 2026-09-07  the same as C, as of Wed 2026-09-09  -> quests, open
+    qw_week() { # qw_week <session> <YYYY-MM-DD> <requests> <cache-read> <second-model-count>
+      local t0; t0="$(epoch "$2T10:00:00Z")"
+      for i in $(seq 0 $(($3 - 1))); do
+        req_at "${1}_$i" "$1" "$((t0 + i * 60))" /tmp/fx 90 0 10 "$4" 0
+        if [ "$i" -lt "$5" ]; then req_meta "${1}_$i" fx-model-2 cli; fi
+      done
+    }
+    qw_week QW_A 2026-08-04 20 200000 0
+    qw_week QW_B 2026-08-11 20 200000 0
+    qw_week QW_C 2026-08-18 20 10000 10
+    qw_week QW_D 2026-08-26 5 10000 0
+    qw_week QW_E 2026-09-01 20 200000 0
+    qw_week QW_F 2026-09-08 20 10000 10
+    ;;
+  quest-sunday)
+    # Stage 8, guard 2: week B's 20th request is on its Sunday, 2026-08-16, so
+    # B is measured only if a week runs Monday to Sunday. As of Wed 2026-08-19.
+    for i in $(seq 0 19); do req_at "QS_A_$i" QS_A "$(( $(epoch 2026-08-04T10:00:00Z) + i * 60 ))" /tmp/fx 90 0 10 200000 0; done
+    for i in $(seq 0 18); do req_at "QS_B_$i" QS_B "$(( $(epoch 2026-08-11T10:00:00Z) + i * 60 ))" /tmp/fx 90 0 10 200000 0; done
+    req_at QS_B_SUN QS_B_SUN "$(epoch 2026-08-16T23:00:00Z)" /tmp/fx 90 0 10 200000 0
+    ;;
+  quest-ask-first)
+    # Stage 8, guard 4's absolute step: two weeks of 20 one-model requests, each
+    # with 10 prompts submitted under bypassPermissions. The SessionStart on
+    # 2026-07-01 starts hook coverage early enough that both the weeks and the
+    # 30-day window of Sunday 2026-08-09 are event-covered, so security is
+    # measured: 0 on that Sunday, and a bypass share of 1.0 each week. The three
+    # lowest are model-routing, cost-discipline and security (all 0, by display
+    # order); context-hygiene (31) is left out. As of Wed 2026-08-12.
+    ev_at QAF_OLD "$(epoch 2026-07-01T12:00:00Z)" SessionStart
+    for w in 2026-08-04 2026-08-11; do
+      t0="$(epoch "${w}T10:00:00Z")"
+      for i in $(seq 0 19); do req_at "QAF_${w}_$i" "QAF_$w" "$((t0 + i * 60))" /tmp/fx 90 0 10 200000 0; done
+      for i in $(seq 0 9); do
+        ev_at "QAF_$w" "$((t0 + 30 + i * 60))" UserPromptSubmit '{"permission_mode":"bypassPermissions"}'
+      done
+    done
+    ;;
   agent-drift)
     # Stage 5, guard 11: one event stream through Claude's rule here and through
     # the agent copy in tests/agent-rollup.test.ts, which seeds these same
```

`tests/quests-rollup.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DISCIPLINE_ORDER } from "@/lib/read/profile";
import { buildAndRoll, rows } from "./helpers/fixture-db";

// Stage 8 (spec 4.2-4.4, 6.1): claude_quests, built by rollup.sh's profile
// section. Guards 1-6 each own one test below, and R21 keeps each guard's
// literal values in that test alone. Every other test asserts identities, and
// no test but guard 2's names a week by its date: guard 2's plant re-keys
// every week to a Sunday, which must red only its own test.

interface QuestRow {
  week: string; week_end: string; slot: number; discipline: string; score: number; direction: string;
  baseline: number; target: number; hold: number; value: number | null; requests: number; status: string;
}
const quests = (db: string) =>
  rows<QuestRow>(db, "SELECT * FROM claude_quests ORDER BY week, slot;");
/** Weeks with quests, oldest first, each its rows in slot order. */
function weeks(db: string): QuestRow[][] {
  const out = new Map<string, QuestRow[]>();
  for (const r of quests(db)) out.set(r.week, [...(out.get(r.week) ?? []), r]);
  return [...out.values()];
}

// The scenarios and their as-of days (tests/fixtures/make-fixture.sh).
const WEEKS = { WATCHTOWER_ROLLUP_TODAY: "2026-09-09" };
const SUNDAY = { WATCHTOWER_ROLLUP_TODAY: "2026-08-19" };
const ASK_FIRST = { WATCHTOWER_ROLLUP_TODAY: "2026-08-12" };

let qw: string; // quest-weeks: weeks A-F, as of Wed 2026-09-09 (week F)
let qs: string; // quest-sunday: week B's 20th request on its Sunday
let qa: string; // quest-ask-first: Ask first measured, as of Wed 2026-08-12

// Each test only reads, so each scenario is built and rolled once.
beforeAll(() => {
  qw = buildAndRoll("quest-weeks", WEEKS);
  qs = buildAndRoll("quest-sunday", SUNDAY);
  qa = buildAndRoll("quest-ask-first", ASK_FIRST);
}, 60000);

describe("Stage 8: weekly quests", () => {
  // Guard 1. Week C's own days lift model-routing from 0 to 28, so its own
  // last day would rank cost-discipline first; the Sunday before it ranks them
  // 0 and 0, by display order.
  it("a week's quests come from the scores before it starts", () => {
    const c = weeks(qw)[1];
    expect(c.map((q) => [q.discipline, q.score])).toEqual([
      ["model-routing", 0], ["cost-discipline", 0], ["context-hygiene", 31],
    ]);
  });

  // Guard 2. Week B's 20th request is on its Sunday: only a Monday-to-Sunday
  // week measures it.
  it("a week runs Monday to Sunday", () => {
    const b = quests(qs).filter((q) => q.week === "2026-08-10");
    expect(b.map((q) => [q.week_end, q.requests, q.value === null])).toEqual([
      ["2026-08-16", 20, false], ["2026-08-16", 20, false], ["2026-08-16", 20, false],
    ]);
  });

  // Guard 3. Week C ends at 50% off the top model and a 10,000-token median
  // context, both past full marks, so week D's quests on them are holds.
  it("a target stops at full marks and holds there", () => {
    const held = quests(qw).filter((q) => q.hold === 1);
    expect(held.map((q) => [q.discipline, q.baseline, q.target])).toEqual([
      ["model-routing", 0.5, 0.35], ["context-hygiene", 10000, 60000],
    ]);
  });

  // Guard 4. Lean cache steps down by 10% and Ask first by one point.
  it("an at-most quest steps down", () => {
    const atMost = [...quests(qw), ...quests(qa)].filter((q) => q.direction === "at-most" && q.hold === 0);
    const pairs = new Map(atMost.map((q) => [`${q.discipline} ${q.baseline}`, q.target]));
    expect(Object.fromEntries(pairs)).toEqual({
      "cost-discipline 2000": 1800, "context-hygiene 200000": 180000,
      "cost-discipline 100": 90, "security 1": 0.99,
    });
  });

  // Guard 5. Week D has 5 requests.
  it("a quiet week is no data, never missed", () => {
    const d = weeks(qw)[2];
    expect(d.map((q) => [q.requests, q.value, q.status])).toEqual([
      [5, null, "no data"], [5, null, "no data"], [5, null, "no data"],
    ]);
  });

  // Guard 6. The as-of day is in week F.
  it("the current week stays open", () => {
    const all = weeks(qw);
    const f = all[all.length - 1];
    expect(f.map((q) => [q.status, q.value])).toEqual([["open", 100], ["open", 0.5], ["open", 10000]]);
    expect(all.slice(0, -1).flat().filter((q) => q.status === "open")).toEqual([]);
  });
});

describe("Stage 8: quest identities", () => {
  const all = () => [...quests(qw), ...quests(qs), ...quests(qa)];

  it("each week's baseline is the week before's value", () => {
    const pairs = rows<{ n: number; bad: number }>(qw, `
      SELECT COUNT(*) AS n, SUM(q.baseline IS NOT p.value) AS bad
      FROM claude_quests q JOIN claude_quests p
        ON p.discipline = q.discipline AND p.week = date(q.week, '-7 days');`)[0];
    expect(pairs.n).toBeGreaterThan(0);
    expect(pairs.bad).toBe(0);
  });

  it("a week has at most three quests, slotted by score, then display order", () => {
    const ord = new Map(DISCIPLINE_ORDER.map((d, i) => [d as string, i]));
    for (const w of weeks(qw)) {
      expect(w.length).toBeLessThanOrEqual(3);
      expect(w.map((q) => q.slot)).toEqual(w.map((_, i) => i + 1));
      const sorted = [...w].sort((a, b) => a.score - b.score || ord.get(a.discipline)! - ord.get(b.discipline)!);
      expect(w.map((q) => q.discipline)).toEqual(sorted.map((q) => q.discipline));
    }
  });

  it("a closed week's status follows its stored value and target", () => {
    for (const q of all().filter((r) => r.status !== "open" && r.value !== null)) {
      const met = q.direction === "at-least" ? q.value! >= q.target : q.value! <= q.target;
      expect({ q, status: q.status }).toEqual({ q, status: met ? "done" : "missed" });
    }
  });

  // Spec 10.3: quest-weeks records no tool call and no hook event, so no week
  // is tool- or event-covered. Only the request-based disciplines are measured.
  it("a week before tool and hook coverage gets no tool or event quest", () => {
    expect([...new Set(quests(qw).map((q) => q.discipline))].sort())
      .toEqual(["context-hygiene", "cost-discipline", "model-routing"]);
  });

  it("a week ends on the Sunday after it starts, and no week starts after the as-of day", () => {
    expect(rows<{ n: number }>(qw, `SELECT COUNT(*) AS n FROM claude_quests
      WHERE week_end <> date(week, '+6 days') OR week > '${WEEKS.WATCHTOWER_ROLLUP_TODAY}';`)[0].n).toBe(0);
  });
});

describe("Stage 8: the profile section's quest swap", () => {
  const ROLLUP = path.resolve(__dirname, "..", "capture", "rollup.sh");
  it("stages claude_quests in _pf_quests and swaps it in the write phase", () => {
    const src = readFileSync(ROLLUP, "utf8");
    const section = src.slice(src.indexOf("# ---- rebuild the Usage Profile"), src.indexOf("# ---- rebuild the agent rollups (Stage 5)"));
    const write = section.slice(section.lastIndexOf("BEGIN IMMEDIATE"));
    expect(write).toContain("DELETE FROM claude_quests;");
    expect(write).toMatch(/INSERT INTO claude_quests \([\w, ]+\)\s+SELECT [\w, ]+\s+FROM _pf_quests ORDER BY rowid;/);
  });
});
```

`tests/capture-scripts.test.ts` and `tests/config.test.ts`:

```diff
--- a/tests/capture-scripts.test.ts
+++ b/tests/capture-scripts.test.ts
@@ -859,14 +859,14 @@ describe("schema v8", () => {
 const V9_TABLES = ["claude_skill_rollups", "claude_skill_packs"];
 
 describe("schema v9", () => {
-  it("creates the two skill tables on a fresh DB, and stamps .schema-v9", () => {
+  it("creates the two skill tables on a fresh DB, and stamps the current schema marker", () => {
     const dir = mkdtempSync(path.join(tmpdir(), "wt-v9-"));
     const db = path.join(dir, "fixture.sqlite");
     execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
       env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
     });
     for (const table of V9_TABLES) expect(tablesOf(db)).toContain(table);
-    expect(existsSync(path.join(dir, ".schema-v9"))).toBe(true);
+    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
   });
 
   it("adds them to an older database in one cc_init_db call, its rows untouched", () => {
@@ -884,6 +884,36 @@ describe("schema v9", () => {
   });
 });
 
+// Stage 8 (schema v10): weekly quests, achievement tiers and the two point
+// totals, all regenerable. Tables only, so no cc_added_columns line.
+const V10_TABLES = ["claude_quests", "achievement_tiers", "character_points"];
+
+describe("schema v10", () => {
+  it("creates the three Stage 8 tables on a fresh DB, and stamps .schema-v10", () => {
+    const dir = mkdtempSync(path.join(tmpdir(), "wt-v10-"));
+    const db = path.join(dir, "fixture.sqlite");
+    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
+      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
+    });
+    for (const table of V10_TABLES) expect(tablesOf(db)).toContain(table);
+    expect(existsSync(path.join(dir, ".schema-v10"))).toBe(true);
+  });
+
+  it("adds them to an older database in one cc_init_db call, its rows untouched", () => {
+    const dir = mkdtempSync(path.join(tmpdir(), "wt-v10up-"));
+    const db = path.join(dir, "fixture.sqlite");
+    buildV5(db);
+    for (const table of V10_TABLES) expect(tablesOf(db)).not.toContain(table);
+    execFileSync("sqlite3", [db, "INSERT INTO claude_requests(request_id, ts, tokens_out) VALUES('req_v5', 1750000000, 42);"]);
+    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
+      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
+    });
+    for (const table of V10_TABLES) expect(tablesOf(db)).toContain(table);
+    expect(execFileSync("sqlite3", [db, "SELECT request_id, ts, tokens_out FROM claude_requests;"], { encoding: "utf8" }).trim())
+      .toBe("req_v5|1750000000|42");
+  });
+});
+
 // Spec §6: the durable tables -- never rebuilt from the filesystem, unlike
 // the regenerable rollup tables rollup.sh legitimately DELETE+re-INSERTs on
 // every run -- must never be wiped wholesale by any capture script. A DROP
```

```diff
--- a/tests/config.test.ts
+++ b/tests/config.test.ts
@@ -27,7 +27,7 @@ describe("loadConfig", () => {
       env: {},
       fileExists: () => true,
     });
-    expect(c.schemaVersion).toBe(9);
+    expect(c.schemaVersion).toBe(10);
     expect(c.database.path.endsWith("/.theone/claude-code-usage.sqlite")).toBe(true);
     expect(c.capture.installDir.endsWith("/.claude")).toBe(true);
     expect(c.coach.mode).toBe("cli");
```

- [ ] **Step 1.2: Run them and watch them fail**

Run: `npx vitest run tests/quests-rollup.test.ts tests/config.test.ts tests/capture-scripts.test.ts -t "Stage 8|schema v10|defaults|current schema marker"`

Expected: FAIL.
- The quest tests fail with `no such table: claude_quests`.
- `config` fails expecting 10 and receiving 9.
- `schema v10` fails because its tables are missing.
- The v9 marker test fails looking for `.schema-v10`.

- [ ] **Step 1.3: Implement**

```bash
git apply --exclude='tests/*' "$L/task-1.patch"
```

This writes the following.

`capture/lib.sh` and `lib/config.ts`:

```diff
--- a/capture/lib.sh
+++ b/capture/lib.sh
@@ -17,7 +17,7 @@
 # from the raw event/session/snapshot tables.
 
 # ---- config ---------------------------------------------------------------
-CC_SCHEMA_VERSION=9
+CC_SCHEMA_VERSION=10
 
 # Database location. This MUST resolve identically to defaultDbPath() in
 # lib/config.ts: that is the reader, this is the writer, they are two languages
@@ -569,6 +569,44 @@ CREATE TABLE IF NOT EXISTS claude_skill_packs (
   via         TEXT NOT NULL,             -- 'plugin' | 'link' | 'none'
   resolved_at INTEGER NOT NULL
 );
+
+-- Stage 8 (schema v10): each week's quests, regenerable, filled by rollup.sh's
+-- profile section. week is the Monday; value NULL means not measured.
+CREATE TABLE IF NOT EXISTS claude_quests (
+  week       TEXT    NOT NULL,           -- YYYY-MM-DD, the week's Monday, local
+  week_end   TEXT    NOT NULL,           -- YYYY-MM-DD, its Sunday
+  slot       INTEGER NOT NULL,           -- 1-3, lowest score first
+  discipline TEXT    NOT NULL,
+  score      INTEGER NOT NULL,           -- the 30-day score on the Sunday before, which chose it
+  direction  TEXT    NOT NULL,           -- 'at-least' | 'at-most'
+  baseline   REAL    NOT NULL,           -- last week's value
+  target     REAL    NOT NULL,
+  hold       INTEGER NOT NULL,           -- 1: the baseline was already at full marks
+  value      REAL,                       -- this week's, at the quest's precision; NULL = not measured
+  requests   INTEGER NOT NULL,           -- this week's requests so far
+  status     TEXT    NOT NULL,           -- 'open' | 'done' | 'missed' | 'no data'
+  PRIMARY KEY (week, slot),
+  UNIQUE (week, discipline)
+);
+
+-- Stage 8: every achievement's four tiers, per tool, and the two point totals.
+-- Regenerable, filled by rollup.sh's agent section.
+CREATE TABLE IF NOT EXISTS achievement_tiers (
+  achievement  TEXT    NOT NULL,
+  source       TEXT    NOT NULL,         -- 'claude' | 'codex' | 'hermes'
+  tier         INTEGER NOT NULL,         -- 1 bronze .. 4 platinum
+  threshold    INTEGER NOT NULL,
+  value        INTEGER,                  -- the current value; NULL = nothing measured (no level)
+  unlocked_day TEXT,                     -- the first day history reached the threshold; NULL = locked
+  points       INTEGER NOT NULL,         -- the tier when unlocked, else 0
+  updated_at   INTEGER,
+  PRIMARY KEY (achievement, source, tier)
+);
+CREATE TABLE IF NOT EXISTS character_points (
+  qp         INTEGER NOT NULL,           -- Quest Points: quests done
+  ap         INTEGER NOT NULL,           -- Achievement Points: the sum of achievement_tiers.points
+  updated_at INTEGER
+);
 SQL
 }
 
```

```diff
--- a/lib/config.ts
+++ b/lib/config.ts
@@ -114,7 +114,7 @@ export function entryLists(id: "codex" | "hermes", sc: SourceConfig | undefined)
 
 function defaults(exists: (p: string) => boolean): WatchtowerConfig {
   return {
-    schemaVersion: 9,
+    schemaVersion: 10,
     database: { path: defaultDbPath(exists) },
     capture: { installDir: path.join(os.homedir(), ".claude") },
     coach: { mode: "cli", apiKey: null },
```

`capture/rollup.sh`:
- the as-of day moves ahead of the profile section;
- the profile heredoc gets its `_pf_asof` prelude;
- `_pf_win` gains `'wk'`;
- the quest tables are added after the WoW update;
- the swap is added to the write phase;
- the agent section keeps its `_sk_asof` prelude, now reading the moved variable.

```diff
--- a/capture/rollup.sh
+++ b/capture/rollup.sh
@@ -1138,6 +1138,14 @@ sqlite3 -cmd ".timeout 8000" "$DB" "INSERT OR REPLACE INTO claude_rank_progress
    sessions_count, rank_index, rank_name, hours_into_rank, hours_to_next, next_rank_name, xp, hygiene_score, updated_at)
   VALUES (1, $TH, $AH, $LC, $LTIN, $LTOUT, $NSESS, $idx, '$rank', $into, $Ltonext, $Lnext, $xp, $HYG, strftime('%s','now'));" 2>/dev/null || true
 
+# Stage 8 (spec 4.0): the as-of day, once, for the profile section's quests and
+# the agent section's pace and streaks. WATCHTOWER_ROLLUP_TODAY pins it for
+# tests; anything but YYYY-MM-DD is ignored.
+_sk_today="$(date +%Y-%m-%d)"
+case "${WATCHTOWER_ROLLUP_TODAY:-}" in
+  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) _sk_today="$WATCHTOWER_ROLLUP_TODAY" ;;
+esac
+
 # ---- rebuild the Usage Profile (Stage 4A) -----------------------------------
 # Its OWN sqlite3 run, deliberately AFTER the rank write above: rank and the
 # daily/project rollups have already committed by this point, so a failure
@@ -1162,7 +1170,9 @@ sqlite3 -cmd ".timeout 8000" "$DB" "INSERT OR REPLACE INTO claude_rank_progress
 #      tables, COMMIT -- milliseconds. The DELETEs sit INSIDE that transaction,
 #      so a failure anywhere rolls back to the previous profile, never to empty.
 # tests/profile-rollup.test.ts pins both the shape and the failure behaviour.
-sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" <<'SQL' 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: profile rebuild failed" >&2; exit 1; }
+# Stage 8: the as-of day reaches the heredoc as a one-row temp table, printed
+# ahead of it as the agent section's prelude is.
+{ printf 'CREATE TEMP TABLE _pf_asof (d0 TEXT NOT NULL);\nINSERT INTO _pf_asof VALUES (%s);\n' "$(cc_sqlstr "$_sk_today")"; cat <<'SQL'
 BEGIN DEFERRED;
 
 -- One row per LOCAL day from the first ever request through today. A day with
@@ -1191,7 +1201,14 @@ SELECT day, '30' AS win, date(day, '-29 day') AS lo, day AS hi FROM _pf_days
 UNION ALL
 SELECT day, '7',  date(day, '-6 day'),  day               FROM _pf_days
 UNION ALL
-SELECT day, '7p', date(day, '-13 day'), date(day, '-7 day') FROM _pf_days;
+SELECT day, '7p', date(day, '-13 day'), date(day, '-7 day') FROM _pf_days
+UNION ALL
+-- Stage 8 (spec 4.2): one calendar week per Monday, Monday..Sunday, keyed by
+-- its Monday, through the week of the as-of day. The one place a week is defined.
+SELECT DISTINCT date(d.day, '-6 days', 'weekday 1'), 'wk',
+       date(d.day, '-6 days', 'weekday 1'), date(d.day, '-6 days', 'weekday 1', '+6 days')
+FROM _pf_days d CROSS JOIN _pf_asof a
+WHERE date(d.day, '-6 days', 'weekday 1') <= a.d0;
 
 -- Every request's OWN local day, computed once and indexed, so the range join
 -- below is an index range scan per window (a few hundred rows) rather than a
@@ -1812,6 +1829,149 @@ SET total_wow = total - (SELECT p7.total FROM _pf_profile p7
                          WHERE p7.day = date(_pf_profile.day, '-7 day'))
 WHERE total IS NOT NULL;
 
+-- ============================================================================
+-- Stage 8: weekly quests (spec 4.2-4.4). Each (week, discipline) is measured
+-- once, in _pf_wk: that week's value, and the next week's baseline.
+-- ============================================================================
+
+-- Each quest's rule, and the only place it lives (spec 4.4). A target is the
+-- baseline plus step -- or, with rel = 1, the baseline times (1 + step) --
+-- never past full_marks. p is the precision every value, baseline and target
+-- is stored at, so the page shows exactly the numbers status compared.
+DROP TABLE IF EXISTS _pf_qdef;
+CREATE TEMP TABLE _pf_qdef (discipline TEXT PRIMARY KEY, direction TEXT NOT NULL,
+  step REAL NOT NULL, rel INTEGER NOT NULL, full_marks REAL NOT NULL, p REAL NOT NULL);
+INSERT INTO _pf_qdef (discipline, direction, step, rel, full_marks, p) VALUES
+  ('verification',    'at-least',  0.02,  0, 0.5,   0.001),
+  ('cost-discipline', 'at-most',  -0.1,   1, 10,    1),
+  ('context-hygiene', 'at-most',  -0.1,   1, 60000, 1000),
+  ('session-hygiene', 'at-least',  0.1,   0, 1,     0.001),
+  ('model-routing',   'at-least',  0.05,  0, 0.35,  0.001),
+  ('security',        'at-most',  -0.01,  0, 0.02,  0.001),
+  ('output-quality',  'at-most',  -0.005, 0, 0.05,  0.001),
+  ('prompt-hygiene',  'at-least',  1,     0, 5,     1),
+  ('reuse',           'at-least',  1,     0, 8,     1),
+  ('automation',      'at-least',  2,     0, 5,     1);
+
+-- One row per week: its '30'-style aggregates from the 'wk' window, the
+-- per-day tables summed over Monday..Sunday (as _pf_wtool and its siblings sum
+-- them over each '30' window), and whether tool calls and hook events were
+-- being recorded -- the profile's coverage rules, applied to the week's Monday.
+DROP TABLE IF EXISTS _pf_wkin;
+CREATE TEMP TABLE _pf_wkin AS
+SELECT w.day AS week, w.lo, w.hi,
+       COALESCE(a.n_requests, 0) AS requests,
+       CASE WHEN cov.coverage_start IS NOT NULL AND w.lo >= cov.coverage_start THEN 1 ELSE 0 END AS tool_covered,
+       CASE WHEN ev.event_start IS NOT NULL AND w.lo >= ev.event_start THEN 1 ELSE 0 END AS event_covered,
+       a.sum_tcr, a.sum_fresh, mc.median_ctx, l.long_sessions, l.long_with_reset,
+       t.calls, t.inspect, t.errors, t.subagents,
+       sl.kinds AS slash_kinds, sl.top AS slash_top,
+       e.prompts_with_mode, e.bypass,
+       md.top AS top_n,
+       sdk.headless
+FROM _pf_win w
+CROSS JOIN _pf_coverage cov
+CROSS JOIN _pf_evcov ev
+LEFT JOIN _pf_agg a     ON a.win  = 'wk' AND a.day  = w.day
+LEFT JOIN _pf_medctx mc ON mc.win = 'wk' AND mc.day = w.day
+LEFT JOIN _pf_long l    ON l.win  = 'wk' AND l.day  = w.day
+LEFT JOIN (SELECT x.day AS week, SUM(t.calls) AS calls, SUM(t.inspect) AS inspect,
+                  SUM(t.errors) AS errors, SUM(t.subagents) AS subagents
+           FROM _pf_win x JOIN _pf_tcday t ON t.tday BETWEEN x.lo AND x.hi
+           WHERE x.win = 'wk' GROUP BY x.day) t ON t.week = w.day
+LEFT JOIN (SELECT week, COUNT(*) AS kinds, MAX(n) AS top
+           FROM (SELECT x.day AS week, s.command, SUM(s.n) AS n
+                 FROM _pf_win x JOIN _pf_slday s ON s.sday BETWEEN x.lo AND x.hi
+                 WHERE x.win = 'wk' GROUP BY x.day, s.command)
+           GROUP BY week) sl ON sl.week = w.day
+LEFT JOIN (SELECT x.day AS week, SUM(v.prompts_with_mode) AS prompts_with_mode, SUM(v.bypass) AS bypass
+           FROM _pf_win x JOIN _pf_evday v ON v.eday BETWEEN x.lo AND x.hi
+           WHERE x.win = 'wk' GROUP BY x.day) e ON e.week = w.day
+LEFT JOIN (SELECT week, MAX(n) AS top
+           FROM (SELECT x.day AS week, m.model, SUM(m.n) AS n
+                 FROM _pf_win x JOIN _pf_modday m ON m.rday BETWEEN x.lo AND x.hi
+                 WHERE x.win = 'wk' GROUP BY x.day, m.model)
+           GROUP BY week) md ON md.week = w.day
+LEFT JOIN (SELECT x.day AS week, COUNT(DISTINCT s.session_id) AS headless
+           FROM _pf_win x JOIN _pf_sdkday s ON s.rday BETWEEN x.lo AND x.hi
+           WHERE x.win = 'wk' GROUP BY x.day) sdk ON sdk.week = w.day
+WHERE w.win = 'wk';
+
+-- One row per (week, discipline), spec 4.2's table. value is NULL -- not
+-- measured -- under 20 requests and wherever that table says; otherwise it is
+-- stored at its quest's precision. round(.., 3) after the step makes 0.35
+-- the double 0.35, not 0.35000000000000003.
+DROP TABLE IF EXISTS _pf_wk;
+CREATE TEMP TABLE _pf_wk AS
+WITH m AS (
+  SELECT week, lo, hi, requests, 'verification' AS discipline,
+         CASE WHEN tool_covered = 1 AND calls > 0 THEN inspect * 1.0 / calls END AS raw FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'cost-discipline',
+         CASE WHEN sum_fresh > 0 THEN sum_tcr * 1.0 / sum_fresh END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'context-hygiene', median_ctx FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'session-hygiene',
+         CASE WHEN long_sessions > 0 THEN long_with_reset * 1.0 / long_sessions END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'model-routing',
+         CASE WHEN top_n IS NOT NULL AND requests > 0 THEN 1 - top_n * 1.0 / requests END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'security',
+         CASE WHEN event_covered = 1 AND prompts_with_mode > 0 THEN bypass * 1.0 / prompts_with_mode END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'output-quality',
+         CASE WHEN tool_covered = 1 AND calls > 0 THEN errors * 1.0 / calls END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'prompt-hygiene',
+         CASE WHEN tool_covered = 1 THEN COALESCE(slash_kinds, 0) END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'reuse',
+         CASE WHEN tool_covered = 1 THEN COALESCE(slash_top, 0) END FROM _pf_wkin
+  UNION ALL SELECT week, lo, hi, requests, 'automation',
+         CASE WHEN tool_covered = 1 THEN COALESCE(subagents, 0) + COALESCE(headless, 0) END FROM _pf_wkin
+)
+SELECT m.week, m.lo, m.hi, m.discipline, m.requests,
+       CASE WHEN m.requests < 20 OR m.raw IS NULL THEN NULL
+            ELSE round(round(m.raw / d.p) * d.p, 3) END AS value
+FROM m JOIN _pf_qdef d ON d.discipline = m.discipline;
+CREATE UNIQUE INDEX idx_pf_wk ON _pf_wk(week, discipline);
+
+-- Spec 4.3: a week's quests are the three lowest eligible 30-day scores on the
+-- Sunday before it, ties by display order. Eligible: measured that day (not
+-- needs-data), and measured the week before -- that value is the baseline.
+DROP TABLE IF EXISTS _pf_qpick;
+CREATE TEMP TABLE _pf_qpick AS
+SELECT week, slot, discipline, score, baseline FROM (
+  SELECT w.week, s.discipline, s.score, b.value AS baseline,
+         ROW_NUMBER() OVER (PARTITION BY w.week ORDER BY s.score, e.ord) AS slot
+  FROM (SELECT DISTINCT week FROM _pf_wk) w
+  JOIN _pf_scores s ON s.day = date(w.week, '-1 day') AND s.status <> 'needs-data'
+  JOIN _pf_ev e     ON e.day = s.day AND e.discipline = s.discipline
+  JOIN _pf_wk b     ON b.week = date(w.week, '-7 days') AND b.discipline = s.discipline AND b.value IS NOT NULL
+) WHERE slot <= 3;
+
+-- Spec 4.4: each quest's target and status, staged in claude_quests' shape.
+-- The week holding the as-of day is open; a closed week with no value is
+-- 'no data', never 'missed'.
+DROP TABLE IF EXISTS _pf_quests;
+CREATE TEMP TABLE _pf_quests AS SELECT * FROM main.claude_quests WHERE 0;
+CREATE UNIQUE INDEX idx_pf_quests ON _pf_quests(week, slot);
+INSERT INTO _pf_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
+SELECT week, hi, slot, discipline, score, direction, baseline, target, hold, value, requests,
+       CASE WHEN d0 BETWEEN lo AND hi THEN 'open'
+            WHEN value IS NULL THEN 'no data'
+            WHEN direction = 'at-least' AND value >= target THEN 'done'
+            WHEN direction = 'at-most'  AND value <= target THEN 'done'
+            ELSE 'missed'
+       END
+FROM (
+  SELECT q.week, q.slot, q.discipline, q.score, d.direction, q.baseline, w.value, w.requests, w.lo, w.hi, a.d0,
+         round(round(CASE WHEN d.direction = 'at-least' THEN MIN(q.moved, d.full_marks)
+                          ELSE MAX(q.moved, d.full_marks) END / d.p) * d.p, 3) AS target,
+         CASE WHEN d.direction = 'at-least' THEN q.baseline >= d.full_marks
+              ELSE q.baseline <= d.full_marks END AS hold
+  FROM (SELECT p.*, CASE WHEN d.rel = 1 THEN p.baseline * (1 + d.step) ELSE p.baseline + d.step END AS moved
+        FROM _pf_qpick p JOIN _pf_qdef d ON d.discipline = p.discipline) q
+  JOIN _pf_qdef d ON d.discipline = q.discipline
+  JOIN _pf_wk w   ON w.week = q.week AND w.discipline = q.discipline
+  CROSS JOIN _pf_asof a
+)
+ORDER BY week, slot;
+
 -- End of the READ phase: everything above wrote only the TEMP schema.
 COMMIT;
 
@@ -1826,8 +1986,12 @@ FROM _pf_profile ORDER BY rowid;
 INSERT INTO claude_discipline_scores (day, discipline, score, status, definition, evidence_json)
 SELECT day, discipline, score, status, definition, evidence_json
 FROM _pf_scores ORDER BY rowid;
+DELETE FROM claude_quests;
+INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
+SELECT week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status FROM _pf_quests ORDER BY rowid;
 COMMIT;
 SQL
+} | sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: profile rebuild failed" >&2; exit 1; }
 
 # ---- rebuild the agent rollups (Stage 5) -------------------------------------
 # Codex and Hermes (from wt_*, written by `watchtower sync`) and every tool's
@@ -1852,12 +2016,8 @@ CREATE TEMP TABLE wt_requests (source TEXT, source_record_id TEXT, canonical_id
   model TEXT, tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
   tokens_cache_creation INTEGER, cost_usd REAL);"
 
-# Stage 6 (spec 4.6): pace and streaks are measured as of the run's local day.
-# WATCHTOWER_ROLLUP_TODAY pins it for tests; anything but YYYY-MM-DD is ignored.
-_sk_today="$(date +%Y-%m-%d)"
-case "${WATCHTOWER_ROLLUP_TODAY:-}" in
-  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) _sk_today="$WATCHTOWER_ROLLUP_TODAY" ;;
-esac
+# Stage 6 (spec 4.6): pace and streaks are measured as of _sk_today, the run's
+# local day, computed before the profile section (Stage 8 spec 4.0).
 _ag_prelude="$_ag_prelude
 CREATE TEMP TABLE _sk_asof (d0 TEXT NOT NULL);
 INSERT INTO _sk_asof VALUES ($(cc_sqlstr "$_sk_today"));"
```

- [ ] **Step 1.4: Run the tests and watch them pass**

Run: `bash -n capture/rollup.sh && npx vitest run tests/quests-rollup.test.ts tests/profile-rollup.test.ts tests/rollup-lock.test.ts tests/config.test.ts tests/capture-scripts.test.ts && npm run typecheck`

Expected: PASS. `quests-rollup` has 12 tests.

Then run the whole suite: `npx vitest run --exclude '.claude/**'`. Expected: all green (1144
tests in 71 files).

- [ ] **Step 1.5: Commit**

```bash
git add capture/lib.sh capture/rollup.sh lib/config.ts tests/fixtures/make-fixture.sh \
  tests/quests-rollup.test.ts tests/capture-scripts.test.ts tests/config.test.ts
git commit -m "Stage 8: schema v10 and weekly quests — the 'wk' window, _pf_wk, claude_quests"
```

- [ ] **Step 1.6: Plant guards 1–6**

For each `n` in 1–6:

```bash
python3 "$L/plants.py" $n capture/rollup.sh
npx vitest run tests/quests-rollup.test.ts tests/profile-rollup.test.ts tests/rollup-lock.test.ts 2>&1 | grep -E "^\s+×|Tests "
git checkout -- capture/rollup.sh
```

Expected: exactly the guard map's test is red, one per plant.
- Record each result in `task-1-report.md`, next to `plant-results.md`'s whole-suite line for
  that plant.
- If the committed `capture/rollup.sh` differs from the patch, re-run the whole suite under
  every plant instead.

---

### Task 2: The agent section — `achievement_tiers` and `character_points`

**Files:**
- Modify: `capture/rollup.sh`, `tests/rollup-lock.test.ts`
- Create: `tests/achievements-rollup.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1, `claude_quests` (committed before the agent section runs);
  - from the agent section, `_ag_life`, `_ag_s`, `_ag_r`, `_sk_daily`, `_sk_prog`, `_sk_ups`
    and `_sk_runs`;
  - the committed `claude_daily_rollups` and `claude_discipline_scores`.
- Produces:
  - `achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points,
    updated_at)`: one row per achievement, tool and tier 1–4, in catalogue order;
  - `character_points (qp, ap, updated_at)`: one row.
  - The achievement keys, in catalogue order: `seasoned`, `daily-habit`, `regular`,
    `wordsmith`, `explorer` (one row set per tool), then `skill-collector`, `skill-master`,
    `pack-master`, `skill-user`, `all-rounder`, `quester`, `perfect-week` (Claude only).

- [ ] **Step 2.1: Write the failing tests**

```bash
git apply --include='tests/*' "$L/task-2.patch"
```

This writes `tests/achievements-rollup.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";

// Stage 8 (spec 4.5-4.6): achievement_tiers and character_points, built by
// rollup.sh's agent section. Guards 7-9 each own one test below (R21: their
// literal values live there alone); the rest assert identities.

interface TierRow {
  achievement: string; source: string; tier: number; threshold: number;
  value: number | null; unlocked_day: string | null; points: number;
}
const tiers = (db: string) =>
  rows<TierRow>(db, "SELECT achievement, source, tier, threshold, value, unlocked_day, points FROM achievement_tiers ORDER BY rowid;");
const points = (db: string) => rows<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;");

const T = 1789466400; // 2026-09-15T10:00:00Z
const DAY = 86400;
const TODAY = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };

/**
 * 100 driven Codex sessions on 2026-09-15, 60 s apart, with no events (so no
 * driven hours and no level), and three requests of 600,000 output tokens on
 * days 0, 2 and 4: 1.8M in all, crossing 1M on day 2.
 */
function codexDb(): string {
  const db = buildAndRoll("agent-drift");
  const out = [0, 2, 4];
  const sessions: SeedSession[] = Array.from({ length: 100 }, (_, i) => ({
    source: "codex", id: `s${i}`, entry: "Codex Desktop", driven: 1, startedAt: T + i * 60, cwd: "/tmp/wt-ac",
    requests: i < out.length ? [{ id: `w${i}`, ts: T + out[i] * DAY, model: "gpt-5.5", tout: 600000 }] : [],
  }));
  seedAgents(db, sessions);
  roll(db, TODAY);
  return db;
}
const WEEKS = { WATCHTOWER_ROLLUP_TODAY: "2026-09-09" };

let cx: string; // codexDb()
let qw: string; // quest-weeks, as of Wed 2026-09-09: one perfect week (C)

// Each test only reads, so each database is built and rolled once.
beforeAll(() => {
  cx = codexDb();
  qw = buildAndRoll("quest-weeks", WEEKS);
}, 60000);

describe("Stage 8: achievements", () => {
  // Guard 7. Regular reaches 10 and 100 on its only day; Wordsmith's running
  // sum reaches 1M on day 2, not on day 4.
  it("each tier is dated the first day it was reached", () => {
    const codex = tiers(cx).filter((t) => t.source === "codex" && t.unlocked_day !== null);
    expect(codex.map((t) => [t.achievement, t.tier, t.value, t.unlocked_day])).toEqual([
      ["regular", 1, 100, "2026-09-15"], ["regular", 2, 100, "2026-09-15"], ["wordsmith", 1, 1800000, "2026-09-17"],
    ]);
  });

  // Guard 8. Regular bronze and silver, and Wordsmith bronze: 1 + 2 + 1.
  it("achievement points weight each tier", () => {
    expect(tiers(cx).filter((t) => t.points > 0).map((t) => [t.achievement, t.source, t.tier, t.points])).toEqual([
      ["regular", "codex", 1, 1], ["regular", "codex", 2, 2], ["wordsmith", "codex", 1, 1],
    ]);
    expect(points(cx).map((p) => p.ap)).toEqual([4]);
  });

  // Guard 9. Perfect week counts the weeks whose every quest is done, each
  // dated by its own Sunday. (A later date is guard 7's defect, not this one.)
  it("quest achievements date from their week", () => {
    const perfect = rows<{ week_end: string }>(qw, `SELECT week_end FROM claude_quests GROUP BY week
      HAVING SUM(status = 'done') = COUNT(*) ORDER BY week;`).map((r) => r.week_end);
    const sundays = rows<{ week_end: string }>(qw, "SELECT DISTINCT week_end FROM claude_quests;").map((r) => r.week_end);
    expect(perfect.length).toBeGreaterThan(0);
    const bronze = tiers(qw).find((t) => t.achievement === "perfect-week" && t.tier === 1)!;
    expect(bronze.value).toBe(perfect.length);
    expect(sundays).toContain(bronze.unlocked_day);
    expect(bronze.unlocked_day! >= perfect[0]).toBe(true);
  });
});

describe("Stage 8: achievement identities", () => {
  const dbs = () => [cx, qw];

  it("QP counts done quests and AP sums the unlocked tiers' points", () => {
    for (const db of dbs()) {
      const done = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_quests WHERE status = 'done';")[0].n;
      const sum = tiers(db).reduce((a, t) => a + t.points, 0);
      expect(points(db)).toEqual([{ qp: done, ap: sum }]);
      for (const t of tiers(db)) expect({ t, unlocked: t.points > 0 }).toEqual({ t, unlocked: t.unlocked_day !== null });
    }
  });

  it("covers every registered tool, and Claude alone for the Claude Code achievements", () => {
    const tools = rows<{ source: string }>(cx, "SELECT source FROM agent_progress ORDER BY source;").map((r) => r.source);
    const by = (a: string) => [...new Set(tiers(cx).filter((t) => t.achievement === a).map((t) => t.source))].sort();
    for (const a of ["seasoned", "daily-habit", "regular", "wordsmith", "explorer"]) expect(by(a)).toEqual(tools);
    for (const a of ["skill-collector", "skill-master", "pack-master", "skill-user", "all-rounder", "quester", "perfect-week"]) {
      expect(by(a)).toEqual(["claude"]);
    }
    for (const a of new Set(tiers(cx).map((t) => t.achievement))) {
      for (const s of by(a)) {
        expect(tiers(cx).filter((t) => t.achievement === a && t.source === s).map((t) => t.tier)).toEqual([1, 2, 3, 4]);
      }
    }
  });

  it("a tool with no level has no Seasoned value and nothing unlocked, never Lv 0", () => {
    expect(rows<{ level: number | null }>(cx, "SELECT level FROM agent_progress WHERE source = 'codex';")).toEqual([{ level: null }]);
    expect(tiers(cx).filter((t) => t.achievement === "seasoned" && t.source === "codex").map((t) => [t.value, t.unlocked_day]))
      .toEqual([[null, null], [null, null], [null, null], [null, null]]);
  });

  it("a tier unlocks no earlier than the tier below it", () => {
    for (const db of dbs()) {
      const all = tiers(db);
      for (const t of all.filter((r) => r.unlocked_day !== null)) {
        const lower = all.find((r) => r.achievement === t.achievement && r.source === t.source && r.tier === t.tier - 1);
        if (lower !== undefined) {
          expect(lower.unlocked_day).not.toBeNull();
          expect(lower.unlocked_day! <= t.unlocked_day!).toBe(true);
        }
      }
    }
  });
});
```

and `tests/rollup-lock.test.ts`:

```diff
--- a/tests/rollup-lock.test.ts
+++ b/tests/rollup-lock.test.ts
@@ -82,12 +82,14 @@ describe("Stage 4B: rollup section 1's transactions", () => {
 const AG_READ_PHASE_TABLES = ["_ag_prices", "_ag_no_rate", "_ag_pwin", "_ag_sess", "_ag_rm", "_ag_ev", "_ag_gap",
   "_ag_g", "_ag_s", "_ag_r", "_ag_keys", "_ag_daily", "_ag_xp", "_ag_life", "_ag_prog",
   "_ag_evm", "_ag_sfm", "_ag_tier", "_sk_daily", "_sk_life", "_sk_prog", "_sk_progress", "_sk_ups", "_sk_d",
-  "_sk_win", "_sk_runs", "_sk_pace"];
+  "_sk_win", "_sk_runs", "_sk_pace", "_ac_def", "_ac_cum", "_ac_first", "_ac_strong", "_ac_val", "_ac_reach",
+  "_ac_tiers", "_ac_points"];
 const AG_SWAPPED: Array<[string, string]> = [
   ["agent_prices", "_ag_prices"], ["agent_request_metrics", "_ag_rm"],
   ["agent_daily_rollups", "_ag_daily"], ["agent_progress", "_ag_prog"],
   ["skill_daily", "_sk_daily"], ["skill_progress", "_sk_progress"],
   ["skill_level_ups", "_sk_ups"], ["skill_pace", "_sk_pace"],
+  ["achievement_tiers", "_ac_tiers"], ["character_points", "_ac_points"],
 ];
 const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 const NOW = esc("CAST(strftime('%s','now') AS INTEGER)");
```

- [ ] **Step 2.2: Run them and watch them fail**

Run: `npx vitest run tests/achievements-rollup.test.ts tests/rollup-lock.test.ts`

Expected: FAIL.
- The achievement tests fail on an empty `achievement_tiers`: every assertion sees `[]`, or
  `undefined` for the bronze tier.
- The lock tests fail on the missing `_ac_*` tables and swaps.

- [ ] **Step 2.3: Implement**

```bash
git apply --exclude='tests/*' "$L/task-2.patch"
```

This writes the following in `capture/rollup.sh`:
- the achievement tables, in the agent read phase after `_sk_pace`;
- the two swaps, at the end of its write phase.

```diff
--- a/capture/rollup.sh
+++ b/capture/rollup.sh
@@ -2472,6 +2472,150 @@ CROSS JOIN _sk_d d
 LEFT JOIN _sk_prog p ON p.source = w.source AND p.kind = 'tool'
 ORDER BY CASE w.source WHEN 'all' THEN 1 ELSE 0 END, w.source;
 
+-- ============================================================================
+-- Stage 8 (spec 4.5-4.6): achievements and the two point totals. Every value
+-- and every date comes from a table this section already built, or one an
+-- earlier section committed (claude_daily_rollups, claude_discipline_scores,
+-- claude_quests). No level or streak rule is restated here.
+-- ============================================================================
+
+-- The catalogue: each achievement's four thresholds, the only place they live.
+-- per_tool = 1: one row for every tool with an agent_progress row; 0: Claude's alone.
+DROP TABLE IF EXISTS _ac_def;
+CREATE TEMP TABLE _ac_def (achievement TEXT NOT NULL, per_tool INTEGER NOT NULL, tier INTEGER NOT NULL,
+  threshold INTEGER NOT NULL, PRIMARY KEY (achievement, tier));
+INSERT INTO _ac_def (achievement, per_tool, tier, threshold) VALUES
+  ('seasoned', 1, 1, 50), ('seasoned', 1, 2, 70), ('seasoned', 1, 3, 90), ('seasoned', 1, 4, 99),
+  ('daily-habit', 1, 1, 7), ('daily-habit', 1, 2, 30), ('daily-habit', 1, 3, 100), ('daily-habit', 1, 4, 365),
+  ('regular', 1, 1, 10), ('regular', 1, 2, 100), ('regular', 1, 3, 1000), ('regular', 1, 4, 5000),
+  ('wordsmith', 1, 1, 1000000), ('wordsmith', 1, 2, 10000000), ('wordsmith', 1, 3, 100000000), ('wordsmith', 1, 4, 1000000000),
+  ('explorer', 1, 1, 3), ('explorer', 1, 2, 10), ('explorer', 1, 3, 25), ('explorer', 1, 4, 50),
+  ('skill-collector', 0, 1, 5), ('skill-collector', 0, 2, 15), ('skill-collector', 0, 3, 30), ('skill-collector', 0, 4, 50),
+  ('skill-master', 0, 1, 50), ('skill-master', 0, 2, 70), ('skill-master', 0, 3, 90), ('skill-master', 0, 4, 99),
+  ('pack-master', 0, 1, 50), ('pack-master', 0, 2, 70), ('pack-master', 0, 3, 90), ('pack-master', 0, 4, 99),
+  ('skill-user', 0, 1, 50), ('skill-user', 0, 2, 70), ('skill-user', 0, 3, 90), ('skill-user', 0, 4, 99),
+  ('all-rounder', 0, 1, 4), ('all-rounder', 0, 2, 6), ('all-rounder', 0, 3, 8), ('all-rounder', 0, 4, 10),
+  ('quester', 0, 1, 10), ('quester', 0, 2, 50), ('quester', 0, 3, 150), ('quester', 0, 4, 300),
+  ('perfect-week', 0, 1, 1), ('perfect-week', 0, 2, 5), ('perfect-week', 0, 3, 20), ('perfect-week', 0, 4, 52);
+
+-- Running totals by day. Sessions and output tokens: Claude's from its daily
+-- rollup (sessions by start day), Codex's and Hermes's from _ag_s and _ag_r,
+-- exactly what the swap below writes as agent_daily_rollups. Quest Points and
+-- perfect weeks: by each week's Sunday.
+DROP TABLE IF EXISTS _ac_cum;
+CREATE TEMP TABLE _ac_cum AS
+WITH x AS (
+  SELECT 'regular' AS achievement, 'claude' AS source, day, sessions_count AS n FROM claude_daily_rollups
+  UNION ALL SELECT 'regular', source, day, SUM(driven) FROM _ag_s GROUP BY source, day
+  UNION ALL SELECT 'wordsmith', 'claude', day, tokens_out FROM claude_daily_rollups
+  UNION ALL SELECT 'wordsmith', source, day, SUM(tokens_out) FROM _ag_r GROUP BY source, day
+  UNION ALL SELECT 'quester', 'claude', week_end, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)
+            FROM claude_quests GROUP BY week, week_end
+  UNION ALL SELECT 'perfect-week', 'claude', week_end,
+            CASE WHEN SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) = COUNT(*) THEN 1 ELSE 0 END
+            FROM claude_quests GROUP BY week, week_end
+)
+SELECT achievement, source, day,
+       SUM(n) OVER (PARTITION BY achievement, source ORDER BY day
+                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total
+FROM x;
+
+-- Things counted by when each first appeared: projects with time per tool
+-- ((unfiled) and (excluded) are buckets, not projects), and Claude Code
+-- skills with time. n is each one's place in that order.
+DROP TABLE IF EXISTS _ac_first;
+CREATE TEMP TABLE _ac_first AS
+SELECT achievement, source, first_day AS day,
+       ROW_NUMBER() OVER (PARTITION BY achievement, source ORDER BY first_day, key) AS n
+FROM (SELECT 'explorer' AS achievement, source, key, MIN(day) AS first_day FROM _sk_daily
+      WHERE kind = 'project' AND key NOT IN ('(unfiled)', '(excluded)') GROUP BY source, key
+      UNION ALL
+      SELECT 'skill-collector', source, key, MIN(day) FROM _sk_daily
+      WHERE source = 'claude' AND kind = 'skill' GROUP BY source, key);
+
+-- The disciplines strong on each scored day.
+DROP TABLE IF EXISTS _ac_strong;
+CREATE TEMP TABLE _ac_strong AS
+SELECT day, COUNT(*) AS n FROM claude_discipline_scores WHERE status = 'strong' GROUP BY day;
+
+-- Each achievement's current value. A level is NULL with no level; a count or
+-- a sum is a real number, 0 included.
+DROP TABLE IF EXISTS _ac_val;
+CREATE TEMP TABLE _ac_val AS
+SELECT 'seasoned' AS achievement, l.source, p.level AS value
+FROM _ag_life l LEFT JOIN _sk_prog p ON p.source = l.source AND p.kind = 'tool'
+UNION ALL
+SELECT 'daily-habit', l.source, COALESCE((SELECT MAX(r.days) FROM _sk_runs r WHERE r.source = l.source), 0)
+FROM _ag_life l
+UNION ALL
+SELECT a.achievement, l.source,
+       COALESCE((SELECT MAX(c.total) FROM _ac_cum c WHERE c.achievement = a.achievement AND c.source = l.source), 0)
+FROM _ag_life l CROSS JOIN (SELECT 'regular' AS achievement UNION ALL SELECT 'wordsmith') a
+UNION ALL
+SELECT 'explorer', l.source, (SELECT COUNT(*) FROM _ac_first f WHERE f.achievement = 'explorer' AND f.source = l.source)
+FROM _ag_life l
+UNION ALL SELECT 'skill-collector', 'claude', (SELECT COUNT(*) FROM _ac_first WHERE achievement = 'skill-collector')
+UNION ALL SELECT 'skill-master', 'claude', (SELECT MAX(level) FROM _sk_prog WHERE source = 'claude' AND kind = 'skill')
+UNION ALL SELECT 'pack-master', 'claude',
+          (SELECT MAX(level) FROM _sk_prog WHERE source = 'claude' AND kind = 'pack' AND key <> '(no pack)')
+UNION ALL SELECT 'skill-user', 'claude', (SELECT level FROM _sk_prog WHERE source = 'claude' AND kind = 'skill-use')
+UNION ALL SELECT 'all-rounder', 'claude', COALESCE((SELECT MAX(n) FROM _ac_strong), 0)
+UNION ALL
+SELECT a.achievement, 'claude', COALESCE((SELECT MAX(c.total) FROM _ac_cum c WHERE c.achievement = a.achievement), 0)
+FROM (SELECT 'quester' AS achievement UNION ALL SELECT 'perfect-week') a;
+
+-- The day each tier was reached: the first day history met its threshold.
+DROP TABLE IF EXISTS _ac_reach;
+CREATE TEMP TABLE _ac_reach AS
+-- a level: its day in the level-up log above (the earliest, over skills or packs)
+SELECT d.achievement, u.source, d.tier, MIN(u.day) AS day
+FROM _ac_def d
+JOIN _sk_ups u ON u.level = d.threshold
+ AND ((d.achievement = 'seasoned'     AND u.kind = 'tool')
+   OR (d.achievement = 'skill-master' AND u.kind = 'skill')
+   OR (d.achievement = 'pack-master'  AND u.kind = 'pack' AND u.key <> '(no pack)')
+   OR (d.achievement = 'skill-user'   AND u.kind = 'skill-use'))
+GROUP BY d.achievement, u.source, d.tier
+UNION ALL
+-- a streak: the day the first run long enough reached it
+SELECT 'daily-habit', r.source, d.tier, MIN(date(r.last_day, '-' || (r.days - d.threshold) || ' days'))
+FROM _ac_def d JOIN _sk_runs r ON r.days >= d.threshold AND r.source <> 'all'
+WHERE d.achievement = 'daily-habit'
+GROUP BY r.source, d.tier
+UNION ALL
+-- a running total: the first day it met the threshold
+SELECT d.achievement, c.source, d.tier, MIN(c.day)
+FROM _ac_def d JOIN _ac_cum c ON c.achievement = d.achievement AND c.total >= d.threshold
+GROUP BY d.achievement, c.source, d.tier
+UNION ALL
+-- a count of firsts: the day the N-th arrived
+SELECT d.achievement, f.source, d.tier, f.day
+FROM _ac_def d JOIN _ac_first f ON f.achievement = d.achievement AND f.n = d.threshold
+UNION ALL
+-- disciplines strong on one day: the first day with at least N
+SELECT 'all-rounder', 'claude', d.tier, MIN(s.day)
+FROM _ac_def d JOIN _ac_strong s ON s.n >= d.threshold
+WHERE d.achievement = 'all-rounder'
+GROUP BY d.tier;
+
+-- One row per achievement, tool and tier, in catalogue order. A tier's points
+-- are its number (1 bronze .. 4 platinum) once unlocked.
+DROP TABLE IF EXISTS _ac_tiers;
+CREATE TEMP TABLE _ac_tiers AS
+SELECT d.achievement, l.source, d.tier, d.threshold, v.value, r.day AS unlocked_day,
+       CASE WHEN r.day IS NOT NULL THEN d.tier ELSE 0 END AS points
+FROM _ac_def d
+JOIN _ag_life l ON d.per_tool = 1 OR l.source = 'claude'
+LEFT JOIN _ac_val v   ON v.achievement = d.achievement AND v.source = l.source
+LEFT JOIN _ac_reach r ON r.achievement = d.achievement AND r.source = l.source AND r.tier = d.tier
+ORDER BY d.rowid, l.source;
+
+-- Quest Points (quests done) and Achievement Points (unlocked tiers' points).
+DROP TABLE IF EXISTS _ac_points;
+CREATE TEMP TABLE _ac_points AS
+SELECT (SELECT COUNT(*) FROM claude_quests WHERE status = 'done') AS qp,
+       (SELECT COALESCE(SUM(points), 0) FROM _ac_tiers) AS ap;
+
 -- End of the READ phase: everything above wrote only the TEMP schema.
 COMMIT;
 
@@ -2517,6 +2661,13 @@ INSERT INTO skill_pace (source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_
   eta_99_days, streak_current, streak_best)
 SELECT source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days, eta_99_days,
        streak_current, streak_best FROM _sk_pace ORDER BY rowid;
+DELETE FROM achievement_tiers;
+INSERT INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at)
+SELECT achievement, source, tier, threshold, value, unlocked_day, points,
+       CAST(strftime('%s','now') AS INTEGER) FROM _ac_tiers ORDER BY rowid;
+DELETE FROM character_points;
+INSERT INTO character_points (qp, ap, updated_at)
+SELECT qp, ap, CAST(strftime('%s','now') AS INTEGER) FROM _ac_points ORDER BY rowid;
 COMMIT;
 SQL
 } | sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: agent rebuild failed" >&2; exit 1; }
```

- [ ] **Step 2.4: Run the tests and watch them pass**

Run: `bash -n capture/rollup.sh && npx vitest run tests/achievements-rollup.test.ts tests/rollup-lock.test.ts tests/quests-rollup.test.ts && npm run typecheck`

Expected: PASS. `achievements-rollup` has 7 tests.

Then run the whole suite: `npx vitest run --exclude '.claude/**'`. Expected: all green (1151
tests in 72 files).

- [ ] **Step 2.5: Commit**

```bash
git add capture/rollup.sh tests/achievements-rollup.test.ts tests/rollup-lock.test.ts
git commit -m "Stage 8: tiered achievements for every tool, Quest and Achievement Points"
```

- [ ] **Step 2.6: Plant guards 7–9**

For each `n` in 7–9:

```bash
python3 "$L/plants.py" $n capture/rollup.sh
npx vitest run tests/achievements-rollup.test.ts tests/quests-rollup.test.ts tests/rollup-lock.test.ts 2>&1 | grep -E "^\s+×|Tests "
git checkout -- capture/rollup.sh
```

Expected: exactly the guard map's test is red, one per plant. Record each result in
`task-2-report.md`, as in step 1.6.

---

### Task 3: The Quests page, Character's points, the nav and the report

**Files:**
- Create: `lib/read/quests.ts`, `lib/render/quests.ts`, `tests/quests-page.test.ts`
- Modify: `lib/render/empty.ts`, `lib/read/character.ts`, `lib/render/character.ts`, `lib/views.ts`,
  `lib/render/layout.ts`, `lib/render/report.ts`, `tests/read-character.test.ts`,
  `tests/render-character.test.ts`, `tests/sources-report.test.ts`, `tests/report-budget.test.ts`

**Interfaces:**
- Consumes: the three tables from Tasks 1 and 2.
- Produces:
  - `readQuests(db: string, opts?: { now?: number }): QuestsData`;
  - `questsView(d: QuestsData, opts?: { served?: boolean; tz?: string }): View`;
  - `QUESTS`, `ACHIEVEMENTS`, `TIER_NAMES` and `RECENT_UNLOCKS = 10` in `lib/read/quests.ts`;
  - `CharacterData.points: { qp: number; ap: number } | null`;
  - the `/quests` route, served and in the report.

- [ ] **Step 3.1: Write the failing tests**

```bash
git apply --include='tests/*' "$L/task-3.patch"
```

This writes `tests/quests-page.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECENT_UNLOCKS, readQuests } from "@/lib/read/quests";
import {
  ACHIEVEMENTS_PENDING, NO_CLOSED_WEEKS, NO_QUESTS_THIS_WEEK, NO_QUESTS_YET, NO_READING, QUESTS_PENDING, UNDER_20_SO_FAR,
} from "@/lib/render/empty";
import { page, TOOLS } from "@/lib/render/layout";
import { questsView } from "@/lib/render/quests";
import { REPORT_ROWS } from "@/lib/render/sessions";

// Stage 8, the Quests page (spec 5). The reader parses and labels what the
// rollup stored, so these tests write the three tables straight into a
// cc_init_db database: no rollup runs, and no rollup plant can red them.

const LIB = path.resolve(__dirname, "..", "capture", "lib.sh");
const NOW = 1791720000; // 2026-10-11T12:00:00Z

/** A fresh v10 database in its own directory (the .schema-vN marker is per directory). */
function freshDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-quests-")), "fixture.sqlite");
  execFileSync("bash", ["-c", '. "$CC_LIB" && cc_init_db'], { env: { ...process.env, THEONE_DB_PATH: db, CC_LIB: LIB } });
  return db;
}
const sql = (db: string, s: string) => execFileSync("sqlite3", ["-bail", db, s], { encoding: "utf8" });

const QUESTS = `INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status) VALUES
  ('2026-09-21', '2026-09-27', 1, 'verification',    12, 'at-least', 0.041, 0.061, 0, 0.07, 140, 'done'),
  ('2026-09-21', '2026-09-27', 2, 'cost-discipline',  0, 'at-most',  249,   224,   0, 230,  140, 'missed'),
  ('2026-09-21', '2026-09-27', 3, 'reuse',           20, 'at-least', 2,     3,     0, 3,    140, 'done'),
  ('2026-09-28', '2026-10-04', 1, 'verification',    10, 'at-least', 0.07,  0.09,  0, NULL, 12,  'no data'),
  ('2026-09-28', '2026-10-04', 2, 'cost-discipline',  0, 'at-most',  230,   207,   0, NULL, 12,  'no data'),
  ('2026-10-05', '2026-10-11', 1, 'cost-discipline',  0, 'at-most',  249,   224,   0, 224,  90,  'open'),
  ('2026-10-05', '2026-10-11', 2, 'model-routing',   28, 'at-least', 0.5,   0.35,  1, 0.41, 90,  'open'),
  ('2026-10-05', '2026-10-11', 3, 'context-hygiene', 31, 'at-most',  200000, 180000, 0, NULL, 90, 'open');`;
const TIERS = `INSERT INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at) VALUES
  ('seasoned', 'claude', 1, 50, 72, '2026-09-01', 1, 0), ('seasoned', 'claude', 2, 70, 72, '2026-09-27', 2, 0),
  ('seasoned', 'claude', 3, 90, 72, NULL, 0, 0),         ('seasoned', 'claude', 4, 99, 72, NULL, 0, 0),
  ('seasoned', 'codex', 1, 50, NULL, NULL, 0, 0),        ('seasoned', 'codex', 2, 70, NULL, NULL, 0, 0),
  ('seasoned', 'codex', 3, 90, NULL, NULL, 0, 0),        ('seasoned', 'codex', 4, 99, NULL, NULL, 0, 0),
  ('regular', 'claude', 1, 10, 640, '2026-08-02', 1, 0), ('regular', 'claude', 2, 100, 640, '2026-09-27', 2, 0),
  ('regular', 'claude', 3, 1000, 640, NULL, 0, 0),       ('regular', 'claude', 4, 5000, 640, NULL, 0, 0),
  ('wordsmith', 'claude', 1, 1000000, 4200000, '2026-08-20', 1, 0), ('wordsmith', 'claude', 2, 10000000, 4200000, NULL, 0, 0),
  ('wordsmith', 'claude', 3, 100000000, 4200000, NULL, 0, 0),      ('wordsmith', 'claude', 4, 1000000000, 4200000, NULL, 0, 0),
  ('perfect-week', 'claude', 1, 1, 1, '2026-09-27', 1, 0), ('perfect-week', 'claude', 2, 5, 1, NULL, 0, 0),
  ('perfect-week', 'claude', 3, 20, 1, NULL, 0, 0),       ('perfect-week', 'claude', 4, 52, 1, NULL, 0, 0);`;

function seeded(): string {
  const db = freshDb();
  sql(db, `${QUESTS} ${TIERS} INSERT INTO character_points (qp, ap, updated_at) VALUES (2, 7, 0);`);
  return db;
}
const served = (db: string) => questsView(readQuests(db, { now: NOW }), { served: true, tz: "UTC" }).body;

describe("readQuests", () => {
  it("is pending before the v10 rollup: no table, or no points row", () => {
    const db = freshDb();
    expect(readQuests(db, { now: NOW }).pending).toBe(true); // tables, but the rollup has not run
    sql(db, "DROP TABLE claude_quests;");
    expect(readQuests(db, { now: NOW }).pending).toBe(true);
    const html = served(db);
    expect(html).toContain(QUESTS_PENDING);
    expect(html).toContain(ACHIEVEMENTS_PENDING);
  });

  it("splits the open week from the closed ones, newest first, with each week's Quest Points", () => {
    const d = readQuests(seeded(), { now: NOW });
    expect(d.thisWeek?.week).toBe("2026-10-05");
    expect(d.thisWeek?.weekEnd).toBe("2026-10-11");
    expect(d.thisWeek?.quests.map((q) => q.discipline)).toEqual(["cost-discipline", "model-routing", "context-hygiene"]);
    expect(d.log.map((w) => [w.week, w.qp])).toEqual([["2026-09-28", 0], ["2026-09-21", 2]]);
    expect([d.qp, d.ap]).toEqual([2, 7]);
  });

  it("orders achievements by the catalogue, then Claude, Codex, Hermes", () => {
    const d = readQuests(seeded(), { now: NOW });
    expect(d.achievements.map((a) => `${a.key} ${a.source}`)).toEqual([
      "seasoned claude", "seasoned codex", "regular claude", "wordsmith claude", "perfect-week claude",
    ]);
    expect(d.achievements[1].value).toBeNull();
  });

  it("lists recent unlocks newest first, ties to the higher tier, then the catalogue", () => {
    const d = readQuests(seeded(), { now: NOW });
    expect(d.recent.map((u) => `${u.day} ${u.key} ${u.tier}`)).toEqual([
      "2026-09-27 seasoned 2", "2026-09-27 regular 2", "2026-09-27 perfect-week 1", "2026-09-01 seasoned 1",
      "2026-08-20 wordsmith 1", "2026-08-02 regular 1",
    ]);
    const db = seeded();
    sql(db, `INSERT INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at)
      SELECT 'explorer', 'claude', t, t, 9, '2026-07-0' || t, t, 0 FROM (SELECT 1 AS t UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)
      UNION ALL SELECT 'skill-collector', 'claude', t, t, 9, '2026-06-0' || t, t, 0 FROM (SELECT 1 AS t UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4);`);
    expect(readQuests(db, { now: NOW }).recent).toHaveLength(RECENT_UNLOCKS);
  });
});

describe("questsView", () => {
  it("shows this week's targets with last week's baseline, and a hold at full marks", () => {
    const html = served(seeded());
    expect(html).toContain("<h2>This week · 2026-10-05 – 2026-10-11</h2>");
    expect(html).toContain("≤ 224 (last week 249)");
    expect(html).toContain("hold ≥ 35.0%");
    expect(html).toContain("≤ 180k (last week 200k)");
    expect(html).toContain("<b>41.0%</b>");
  });

  it("shows a missing value as no reading, and an open week under the gate as such, never 0", () => {
    const db = seeded();
    const html = served(db);
    expect(html).toContain(NO_READING);
    sql(db, "UPDATE claude_quests SET requests = 12, value = NULL WHERE status = 'open';");
    const quiet = served(db);
    expect(quiet.split(UNDER_20_SO_FAR)).toHaveLength(4);
    expect(quiet).not.toMatch(/this week<\/span><b>0(\.0)?%?<\/b>/);
  });

  it("logs a week with no reading as no data, never missed", () => {
    const html = served(seeded());
    const log = html.slice(html.indexOf("<h2>Quest log</h2>"));
    const row = log.slice(log.indexOf("2026-09-28"), log.indexOf("</tr>", log.indexOf("2026-09-28")));
    expect(row).toContain("no data");
    expect(row).not.toContain("missed");
  });

  it("shows the stored targets and thresholds: change one and the page follows", () => {
    const db = seeded();
    sql(db, `UPDATE claude_quests SET target = 0.4 WHERE discipline = 'model-routing';
             UPDATE achievement_tiers SET threshold = 95 WHERE achievement = 'seasoned' AND tier = 3;`);
    const html = served(db);
    expect(html).toContain("hold ≥ 40.0%");
    expect(html).toContain("Lv 72 / Lv 95 to gold");
  });

  it("dates an unlocked tier, mutes a locked one, and counts toward the next", () => {
    const html = served(seeded());
    expect(html).toContain("<b>2026-09-27</b>");
    expect(html).toContain("Lv 72 / Lv 90 to gold");
    expect(html).toContain(`<span class="absent">Lv 99</span>`);
    expect(html).toContain("4.2M / 10.0M to silver");
  });

  it("says why there are no quests: none yet, or none this week", () => {
    const db = freshDb();
    sql(db, "INSERT INTO character_points (qp, ap, updated_at) VALUES (0, 0, 0);");
    const none = served(db);
    expect(none).toContain(NO_QUESTS_YET);
    expect(none).toContain(NO_CLOSED_WEEKS);
    const closed = seeded();
    sql(closed, "DELETE FROM claude_quests WHERE status = 'open';");
    const html = served(closed);
    expect(html).toContain(NO_QUESTS_THIS_WEEK);
    expect(html).toContain("<h2>This week</h2>");
  });

  it("cuts the quest log to REPORT_ROWS in the report, and says so", () => {
    const db = freshDb();
    const values = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => {
      const monday = new Date(Date.UTC(2025, 0, 6) + i * 7 * 86400000).toISOString().slice(0, 10);
      const sunday = new Date(Date.UTC(2025, 0, 12) + i * 7 * 86400000).toISOString().slice(0, 10);
      return `('${monday}', '${sunday}', 1, 'reuse', 0, 'at-least', 2, 3, 0, 3, 40, 'done')`;
    }).join(",");
    sql(db, `INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
             VALUES ${values}; INSERT INTO character_points (qp, ap, updated_at) VALUES (${REPORT_ROWS + 5}, 0, 0);`);
    const d = readQuests(db, { now: NOW });
    const report = questsView(d, { served: false, tz: "UTC" }).body;
    const log = (html: string) => html.slice(html.indexOf("<h2>Quest log</h2>"));
    expect(log(report).split("<tr>")).toHaveLength(REPORT_ROWS + 2);
    expect(report).toContain(`This report lists the ${REPORT_ROWS} newest of ${REPORT_ROWS + 5} weeks`);
    expect(log(served(db)).split("<tr>")).toHaveLength(REPORT_ROWS + 7);
  });

  it("sits in the tool row after Character, and is current on its own page", () => {
    expect(TOOLS.map((t) => t.label)).toEqual(["Overview", "Character", "Quests", "Claude Code", "Codex", "Hermes"]);
    expect(page({ title: "x", active: "/quests", body: "" }))
      .toContain(`<span class="pill on t-quests" aria-current="true">Quests</span>`);
  });

  // Spec 6.1: every step, full-marks value and tier threshold lives in rollup.sh.
  it("holds no rule of the rollup's: no number but the formatting ones", () => {
    for (const f of ["lib/read/quests.ts", "lib/render/quests.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const nums = [...new Set(src.match(/(?<![\w.])\d+(\.\d+)?(?![\w.])/g) ?? [])].sort();
      expect({ f, nums: nums.filter((n) => !["0", "1", "10", "20", "100", "1000"].includes(n)) }).toEqual({ f, nums: [] });
    }
  });
});
```

and these edits, which include guard 10's test in `read-character`:

```diff
--- a/tests/read-character.test.ts
+++ b/tests/read-character.test.ts
@@ -101,6 +101,25 @@ describe("readCharacter", () => {
     expect(capped.levelUpCount).toBe(c.levelUpCount + LEVEL_UP_CAP + 10);
   });
 
+  // Stage 8, guard 10: a tier unlock is an achievement, not a level-up.
+  it("achievement unlocks stay out of the level-up log", () => {
+    const db = buildAndRoll("mixed-projects-one-day");
+    const before = readCharacter(db, { now: NOW, home: home() });
+    execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at)
+      VALUES ('regular', 'claude', 1, 10, 12, '2026-09-30', 1, 0), ('regular', 'claude', 2, 100, 12, '2026-09-30', 2, 0);`]);
+    const after = readCharacter(db, { now: NOW, home: home() });
+    expect(after.levelUps).toEqual(before.levelUps);
+    expect(after.levelUpCount).toBe(before.levelUpCount);
+  });
+
+  it("reads Quest and Achievement Points, and none before the v10 rollup", () => {
+    const db = buildAndRoll("mixed-projects-one-day");
+    expect(readCharacter(db, { now: NOW, home: home() }).points)
+      .toEqual(rows<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;")[0]);
+    execFileSync("sqlite3", [db, "DROP TABLE character_points;"]);
+    expect(readCharacter(db, { now: NOW, home: home() }).points).toBeNull();
+  });
+
   // Review Focus 5.
   it("Skill use is pending on a database the v9 rollup has not run on", () => {
     const db = buildAndRoll("skill-mix");
```

```diff
--- a/tests/render-character.test.ts
+++ b/tests/render-character.test.ts
@@ -27,7 +27,7 @@ const up = (i: number, over: Partial<LevelUp> = {}): LevelUp => ({
 });
 const data = (over: Partial<CharacterData> = {}): CharacterData => ({
   generatedAt: 1790766000, pending: false, tools: [tool()], totalLevel: 57, all: pace(), levelUps: [up(0)], levelUpCount: 1,
-  skillUse: { pending: false, level: null, packs: [], skills: [] }, ...over,
+  skillUse: { pending: false, level: null, packs: [], skills: [] }, points: null, ...over,
 });
 const html = (d: CharacterData, served = true) => characterView(d, { served, tz: "UTC" }).body;
 /** A pace row with nothing in any window: skill_pace has one for every registered tool. */
@@ -62,6 +62,13 @@ describe("characterView", () => {
     expect(h).toContain("Total level");
   });
 
+  // Stage 8: the two point totals sit after the Total level, outside it, once stored.
+  it("shows Quest and Achievement Points after the Total level, and nothing before the v10 rollup", () => {
+    const h = html(data({ points: { qp: 14, ap: 43 } }));
+    expect(h).toContain(`<div class="kv"><span>Total level</span><b>57</b></div><div class="kv"><span>Quest Points</span><b>14</b></div><div class="kv"><span>Achievement Points</span><b>43</b></div>`);
+    expect(html(data())).not.toContain("Quest Points");
+  });
+
   // Review Focus 3.
   it("at 99 shows stars and no ETA", () => {
     const top = lv({ level: 99, tier: "Master", xpToNext: null, sToNext: null, stars: 2 });
@@ -162,7 +169,7 @@ describe("characterView", () => {
 
 describe("Character in the nav and on the Overview", () => {
   it("sits in the tool row after the Overview, and is current on its own page", () => {
-    expect(TOOLS.map((t) => t.label)).toEqual(["Overview", "Character", "Claude Code", "Codex", "Hermes"]);
+    expect(TOOLS.map((t) => t.label)).toEqual(["Overview", "Character", "Quests", "Claude Code", "Codex", "Hermes"]);
     const p = page({ title: "x", active: "/character", body: "" });
     expect(p).toContain(`<span class="pill on t-character" aria-current="true">Character</span>`);
   });
```

```diff
--- a/tests/sources-report.test.ts
+++ b/tests/sources-report.test.ts
@@ -157,7 +157,7 @@ describe("watchtower report", () => {
   // is the same in every range once, so the body as one string no longer
   // appears whole -- its pieces do, in order.)
   it("carries every static view exactly as the server renders it", () => {
-    expect(STATIC_VIEWS.map((v) => v.href)).toEqual(["/overview", "/character", "/history", "/projects", "/sessions", "/skills", "/profile", "/performance", "/codex", "/hermes", "/sources"]);
+    expect(STATIC_VIEWS.map((v) => v.href)).toEqual(["/overview", "/character", "/quests", "/history", "/projects", "/sessions", "/skills", "/profile", "/performance", "/codex", "/hermes", "/sources"]);
     for (const v of STATIC_VIEWS) {
       const view = v.build(ctx);
       const body = view.body;
@@ -273,12 +273,15 @@ describe("watchtower report", () => {
   //
   // Stage 6 Task 4: Character is one more (unranged) article, 279,421 B against
   // the 272,425 ceiling, so the multiple is 4.4x (285,397 B).
-  it("stays within 4.4x the Stage 3C report on the fixture", () => {
+  //
+  // Stage 8: Quests is one more (unranged) article, 287,250 B against the
+  // 285,397 ceiling, so the multiple is 4.5x (291,884 B).
+  it("stays within 4.5x the Stage 3C report on the fixture", () => {
     const REPORT_3C_BYTES = 64_863;
     const fixtureNow = 1750000000 + 2 * 86400 + 1000;
     const busy = buildReport({ db: buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" }), now: fixtureNow, configured: CONFIGURED });
-    expect(Buffer.byteLength(busy, "utf8")).toBeLessThanOrEqual(4.4 * REPORT_3C_BYTES);
-    expect(Buffer.byteLength(report, "utf8")).toBeLessThanOrEqual(4.4 * REPORT_3C_BYTES);
+    expect(Buffer.byteLength(busy, "utf8")).toBeLessThanOrEqual(4.5 * REPORT_3C_BYTES);
+    expect(Buffer.byteLength(report, "utf8")).toBeLessThanOrEqual(4.5 * REPORT_3C_BYTES);
   }, 15000);
 
   // The report is interactive with no server: the settings popover (theme and
```

```diff
--- a/tests/report-budget.test.ts
+++ b/tests/report-budget.test.ts
@@ -249,6 +249,10 @@ describe("the report over a long history", () => {
 // Stage 7 tags density's j = 2 request, so every session carries skill time,
 // and Character gains Skill use (tile, section, two tables cut to REPORT_ROWS):
 // 2 B/week and 5,885 B/week total measured; the pins hold.
+// Stage 8 adds Quests: 271 B/week measured (its quest log grows a row a week,
+// three quests on each of density's weeks; it is cut to REPORT_ROWS in the
+// report, so it flattens after 60 weeks), pinned at +15% rounded up to the
+// next 10: 320. Total 6,156 B/week measured; its pin holds.
 // The limits sit between the two columns; 9deabcc's rendering fails five of them.
 describe("the report's growth at live density", () => {
   const PER_WEEK_LIMIT: Record<string, number> = {
@@ -261,6 +265,7 @@ describe("the report's growth at live density", () => {
     sessions: 50,
     performance: 50,
     character: 50,
+    quests: 320,
     codex: 1610,
     hermes: 1610,
     sources: 50,
```

- [ ] **Step 3.2: Run them and watch them fail**

Run: `npx vitest run tests/quests-page.test.ts tests/read-character.test.ts tests/render-character.test.ts tests/sources-report.test.ts tests/report-budget.test.ts`

Expected: FAIL.
- `quests-page` cannot resolve `@/lib/read/quests`.
- The Character tests fail on the missing `points`.
- The nav and `STATIC_VIEWS` lists lack Quests.
- The budget's page keys lack `quests`.

- [ ] **Step 3.3: Implement**

```bash
git apply --exclude='tests/*' "$L/task-3.patch"
```

This writes `lib/read/quests.ts`:

```ts
/**
 * The Quests page (Stage 8, spec §5): this week's quests, the quest log,
 * achievements by tier and the two point totals, as rollup.sh stored them in
 * claude_quests, achievement_tiers and character_points. This module reads,
 * groups, sorts and labels. It computes no target, status, threshold or date.
 */
import { querySql } from "../core/sql.ts";
import { AGENT_LABEL, hasTable, type AgentSource } from "./level.ts";

export type QuestStatus = "open" | "done" | "missed" | "no data";
/** How a quest's numbers read: a share as a percent, a ratio, tokens in thousands, a count. */
export type QuestUnit = "share" | "ratio" | "tokens" | "count";

/** Each discipline's quest (spec 4.2): its name, its unit and what it measures. */
export const QUESTS: Record<string, { name: string; unit: QuestUnit; measure: string }> = {
  "verification": { name: "Look before you leap", unit: "share", measure: "Read, Grep and Glob share of tool calls" },
  "cost-discipline": { name: "Lean cache", unit: "ratio", measure: "cache re-read ÷ fresh tokens" },
  "context-hygiene": { name: "Travel light", unit: "tokens", measure: "median context per session" },
  "session-hygiene": { name: "Fresh start", unit: "share", measure: "long sessions with a reset" },
  "model-routing": { name: "Right tool", unit: "share", measure: "requests off your top model" },
  "security": { name: "Ask first", unit: "share", measure: "prompts that bypass permissions" },
  "output-quality": { name: "Clean run", unit: "share", measure: "tool error rate" },
  "prompt-hygiene": { name: "Variety pack", unit: "count", measure: "distinct slash commands" },
  "reuse": { name: "Signature move", unit: "count", measure: "uses of your most-used slash command" },
  "automation": { name: "Delegate", unit: "count", measure: "subagent launches and headless sessions" },
};

export type AchievementGroup = "tools" | "skills" | "habits";
export type AchievementUnit = "level" | "days" | "sessions" | "tokens" | "projects" | "skills" | "disciplines" | "points" | "weeks";

/** The catalogue (spec 4.5), in display order. Thresholds are stored, never here. */
export const ACHIEVEMENTS: ReadonlyArray<{ key: string; name: string; group: AchievementGroup; unit: AchievementUnit }> = [
  { key: "seasoned", name: "Seasoned", group: "tools", unit: "level" },
  { key: "daily-habit", name: "Daily habit", group: "tools", unit: "days" },
  { key: "regular", name: "Regular", group: "tools", unit: "sessions" },
  { key: "wordsmith", name: "Wordsmith", group: "tools", unit: "tokens" },
  { key: "explorer", name: "Explorer", group: "tools", unit: "projects" },
  { key: "skill-collector", name: "Skill collector", group: "skills", unit: "skills" },
  { key: "skill-master", name: "Skill master", group: "skills", unit: "level" },
  { key: "pack-master", name: "Pack master", group: "skills", unit: "level" },
  { key: "skill-user", name: "Skill user", group: "skills", unit: "level" },
  { key: "all-rounder", name: "All-rounder", group: "habits", unit: "disciplines" },
  { key: "quester", name: "Quester", group: "habits", unit: "points" },
  { key: "perfect-week", name: "Perfect week", group: "habits", unit: "weeks" },
];

export const TIER_NAMES = ["bronze", "silver", "gold", "platinum"] as const;
/** The Recent unlocks list's length (spec §5). */
export const RECENT_UNLOCKS = 10;

export interface Quest {
  discipline: string;
  name: string;
  unit: QuestUnit;
  measure: string;
  slot: number;
  /** The 30-day score on the Sunday before the week, which chose this quest. */
  score: number;
  direction: "at-least" | "at-most";
  baseline: number;
  target: number;
  /** The baseline was already at full marks: the quest is to hold it. */
  hold: boolean;
  /** Null: not measured (under 20 requests, or nothing to divide). */
  value: number | null;
  requests: number;
  status: QuestStatus;
}

export interface QuestWeek {
  /** The Monday and the Sunday, YYYY-MM-DD, as stored. */
  week: string;
  weekEnd: string;
  /** Slot order. */
  quests: Quest[];
  /** Quest Points earned: the week's done quests. */
  qp: number;
}

export interface Tier {
  tier: number;
  name: string;
  threshold: number;
  /** Null while locked. */
  unlockedDay: string | null;
}

export interface Achievement {
  key: string;
  name: string;
  group: AchievementGroup;
  unit: AchievementUnit;
  source: AgentSource;
  tool: string;
  /** Null: nothing measured (a tool or skill with no level). */
  value: number | null;
  /** Bronze to platinum. */
  tiers: Tier[];
}

export interface Unlock {
  day: string;
  key: string;
  name: string;
  source: AgentSource;
  tool: string;
  tier: number;
  tierName: string;
}

export interface QuestsData {
  generatedAt: number;
  /** No claude_quests table, or no character_points row: the v10 rollup has not run. */
  pending: boolean;
  /** The open week; null when this week has no quests. */
  thisWeek: QuestWeek | null;
  /** Closed weeks with quests, newest first. */
  log: QuestWeek[];
  /** Whether claude_quests holds any row. */
  anyQuests: boolean;
  qp: number;
  ap: number;
  /** Catalogue order, then Claude, Codex, Hermes. */
  achievements: Achievement[];
  /** Newest first, at most RECENT_UNLOCKS. */
  recent: Unlock[];
}

interface QuestRow {
  week: string; week_end: string; slot: number; discipline: string; score: number; direction: string;
  baseline: number; target: number; hold: number; value: number | null; requests: number; status: string;
}
interface TierRow {
  achievement: string; source: string; tier: number; threshold: number; value: number | null; unlocked_day: string | null;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const SOURCE_ORDER: AgentSource[] = ["claude", "codex", "hermes"];

const EMPTY = (generatedAt: number, pending: boolean): QuestsData =>
  ({ generatedAt, pending, thisWeek: null, log: [], anyQuests: false, qp: 0, ap: 0, achievements: [], recent: [] });

function toQuest(r: QuestRow): Quest {
  const q = QUESTS[r.discipline] ?? { name: r.discipline, unit: "count" as const, measure: "" };
  return {
    discipline: r.discipline, name: q.name, unit: q.unit, measure: q.measure, slot: r.slot, score: r.score,
    direction: r.direction === "at-most" ? "at-most" : "at-least", baseline: r.baseline, target: r.target,
    hold: r.hold === 1, value: r.value, requests: r.requests, status: r.status as QuestStatus,
  };
}

/** Rows in (week, slot) order, grouped into weeks. */
function weeksOf(rows: QuestRow[]): QuestWeek[] {
  const out: QuestWeek[] = [];
  for (const r of rows) {
    let w = out[out.length - 1];
    if (w === undefined || w.week !== r.week) {
      w = { week: r.week, weekEnd: r.week_end, quests: [], qp: 0 };
      out.push(w);
    }
    const q = toQuest(r);
    w.quests.push(q);
    if (q.status === "done") w.qp += 1;
  }
  return out;
}

export function readQuests(db: string, opts: { now?: number } = {}): QuestsData {
  const generatedAt = opts.now ?? Math.floor(Date.now() / 1000);
  if (!hasTable(db, "claude_quests") || !hasTable(db, "character_points")) return EMPTY(generatedAt, true);
  const points = read<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;")[0];
  if (points === undefined) return EMPTY(generatedAt, true);

  const weeks = weeksOf(read<QuestRow>(db, `SELECT week, week_end, slot, discipline, score, direction, baseline, target,
      hold, value, requests, status FROM claude_quests ORDER BY week, slot;`));
  const open = weeks.filter((w) => w.quests.some((q) => q.status === "open"));
  const closed = weeks.filter((w) => !open.includes(w)).reverse();

  const tiers = read<TierRow>(db, `SELECT achievement, source, tier, threshold, value, unlocked_day
      FROM achievement_tiers ORDER BY achievement, source, tier;`);
  const achievements: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    for (const source of SOURCE_ORDER) {
      const mine = tiers.filter((t) => t.achievement === a.key && t.source === source);
      if (mine.length === 0) continue;
      achievements.push({
        key: a.key, name: a.name, group: a.group, unit: a.unit, source, tool: AGENT_LABEL[source], value: mine[0].value,
        tiers: mine.map((t) => ({
          tier: t.tier, name: TIER_NAMES[t.tier - 1], threshold: t.threshold, unlockedDay: t.unlocked_day,
        })),
      });
    }
  }
  const order = (key: string) => ACHIEVEMENTS.findIndex((a) => a.key === key);
  const recent = achievements
    .flatMap((a) => a.tiers.filter((t) => t.unlockedDay !== null).map((t): Unlock => ({
      day: t.unlockedDay as string, key: a.key, name: a.name, source: a.source, tool: a.tool, tier: t.tier, tierName: t.name,
    })))
    .sort((x, y) => (x.day === y.day ? (y.tier - x.tier) || (order(x.key) - order(y.key)) : x.day < y.day ? 1 : -1))
    .slice(0, RECENT_UNLOCKS);

  return {
    generatedAt, pending: false, thisWeek: open[open.length - 1] ?? null, log: closed, anyQuests: weeks.length > 0,
    qp: points.qp, ap: points.ap, achievements, recent,
  };
}
```

`lib/render/quests.ts`:

```ts
/**
 * The Quests page (Stage 8, spec §5): this week's quests, Quest and
 * Achievement Points, achievements by tier and the quest log. It labels what
 * the rollup stored; its only arithmetic is a share shown as a percent and
 * tokens shown in thousands.
 */
import type { Achievement, Quest, QuestUnit, QuestWeek, QuestsData } from "../read/quests.ts";
import { sortableTable, type SortCell, type SortColumn } from "./charts.ts";
import {
  ACHIEVEMENTS_PENDING, NO_CLOSED_WEEKS, NO_QUESTS_THIS_WEEK, NO_QUESTS_YET, NO_READING, NO_UNLOCKS,
  QUESTS_PENDING, UNDER_20_SO_FAR,
} from "./empty.ts";
import { compact, esc, grouped, localZone, num, stamp } from "./html.ts";
import { card, type View } from "./layout.ts";
import { REPORT_ROWS } from "./sessions.ts";

/**
 * The profile's 20-request gate. It only picks which absent label an open
 * week's missing value gets; no number is derived from it.
 */
const GATE_REQUESTS = 20;

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;

/** A stored quest number in its unit. Values are stored at the precision shown here. */
export function questNumber(unit: QuestUnit, v: number): string {
  switch (unit) {
    case "share": return `${num(v * 100, 1)}%`;
    case "tokens": return `${grouped(v / 1000)}k`;
    case "ratio":
    case "count": return grouped(v);
  }
}

const op = (q: Quest) => (q.direction === "at-least" ? "≥" : "≤");

/** "≥ 6.1% (last week 4.1%)", or "hold ≥ 50.0%" at full marks. */
export function targetText(q: Quest): string {
  const t = `${op(q)} ${questNumber(q.unit, q.target)}`;
  return q.hold ? `hold ${t}` : `${t} (last week ${questNumber(q.unit, q.baseline)})`;
}

function valueHtml(q: Quest): string {
  if (q.value !== null) return `<b>${esc(questNumber(q.unit, q.value))}</b>`;
  return absent(q.status === "open" && q.requests < GATE_REQUESTS ? UNDER_20_SO_FAR : NO_READING);
}

const statusHtml = (q: Quest) =>
  q.status === "done" ? `<b>done</b>` : absent(q.status);

function questTile(q: Quest): string {
  return `<div class="c tile"><h2>${esc(q.name)}</h2><div class="muted label">${esc(q.discipline)} · ${esc(q.measure)}</div>` +
    `<div class="block">${kv("target", `<b>${esc(targetText(q))}</b>`)}${kv("this week", valueHtml(q))}` +
    `${kv("status", statusHtml(q))}</div></div>`;
}

function thisWeekCard(d: QuestsData): string {
  const w = d.thisWeek;
  if (w === null) {
    return card({ title: "This week", wide: true, body: `<div class="state absent">${esc(d.anyQuests ? NO_QUESTS_THIS_WEEK : NO_QUESTS_YET)}</div>` });
  }
  return card({
    title: `This week · ${w.week} – ${w.weekEnd}`, wide: true,
    body: `<div class="g g-tiles">${w.quests.map(questTile).join("")}</div>`,
  });
}

function pointsCard(d: QuestsData): string {
  const big = (n: number, label: string) =>
    `<div class="c tile"><div class="value">${grouped(n)}</div><div class="muted label">${esc(label)}</div></div>`;
  return card({
    title: "Points", wide: true,
    body: `<div class="g g-tiles">${big(d.qp, "Quest Points")}${big(d.ap, "Achievement Points")}</div>`,
  });
}

/** An achievement's value or threshold in its unit. */
function achievementNumber(a: Achievement, v: number): string {
  return a.unit === "level" ? `Lv ${v}` : a.unit === "tokens" ? compact(v) : grouped(v);
}

const ACH_COLS: SortColumn[] = [
  { key: "name", label: "Achievement" }, { key: "tool", label: "Tool" }, { key: "value", label: "Now", num: true },
  { key: "t1", label: "Bronze" }, { key: "t2", label: "Silver" }, { key: "t3", label: "Gold" }, { key: "t4", label: "Platinum" },
];

function achievementRow(a: Achievement): { cells: Record<string, SortCell> } {
  const next = a.tiers.find((t) => t.unlockedDay === null);
  const cells: Record<string, SortCell> = {
    name: { html: esc(a.name), sort: a.name },
    tool: { html: esc(a.tool), sort: a.tool },
    value: a.value === null ? { html: `<span class="absent">—</span>`, sort: null } : { html: esc(achievementNumber(a, a.value)), sort: a.value },
  };
  for (const t of a.tiers) {
    const th = achievementNumber(a, t.threshold);
    cells[`t${t.tier}`] = t.unlockedDay !== null
      ? { html: `<b>${esc(t.unlockedDay)}</b>`, sort: t.unlockedDay }
      : t === next && a.value !== null
        ? { html: `<span class="absent">${esc(`${achievementNumber(a, a.value)} / ${th} to ${t.name}`)}</span>`, sort: null }
        : { html: `<span class="absent">${esc(th)}</span>`, sort: null };
  }
  return { cells };
}

const GROUPS: Array<[Achievement["group"], string]> = [
  ["tools", "Achievements · every tool"], ["skills", "Achievements · Claude Code skills"], ["habits", "Achievements · habits"],
];

function recentCard(d: QuestsData): string {
  const rows = d.recent.map((u) =>
    `<div class="kv"><span>${esc(u.day)}</span><b>${esc(`${u.name} · ${u.tool} · ${u.tierName}`)}</b></div>`).join("");
  return card({ title: "Recent unlocks", wide: true, body: rows === "" ? `<div class="state absent">${esc(NO_UNLOCKS)}</div>` : rows });
}

function achievementCards(d: QuestsData): string {
  return recentCard(d) + GROUPS.map(([g, title]) =>
    card({ title, wide: true, body: sortableTable(ACH_COLS, d.achievements.filter((a) => a.group === g).map(achievementRow), { empty: NO_UNLOCKS }) }),
  ).join("");
}

const LOG_COLS: SortColumn[] = [
  { key: "week", label: "Week" }, { key: "quests", label: "Quests" }, { key: "qp", label: "QP", num: true },
];

function logCard(d: QuestsData, served: boolean): string {
  const shown = served ? d.log : d.log.slice(0, REPORT_ROWS);
  const cut = shown.length < d.log.length
    ? `<p class="note">This report lists the ${REPORT_ROWS} newest of ${grouped(d.log.length)} weeks; serve the dashboard for all of them.</p>`
    : "";
  const rows = shown.map((w: QuestWeek) => ({
    cells: {
      week: { html: esc(`${w.week} – ${w.weekEnd}`), sort: w.week },
      quests: { html: w.quests.map((q) => `${esc(q.name)} <span class="muted">${esc(q.status)}</span>`).join(" · "), sort: null },
      qp: { html: grouped(w.qp), sort: w.qp },
    } as Record<string, SortCell>,
  }));
  return card({ title: "Quest log", wide: true, body: sortableTable(LOG_COLS, rows, { empty: NO_CLOSED_WEEKS }) + cut });
}

export function questsView(d: QuestsData, opts: { served?: boolean; tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const served = opts.served === true;
  const body = d.pending
    ? card({ title: "Quests", body: `<div class="state absent">${esc(QUESTS_PENDING)}</div>` }) +
      card({ title: "Achievements", body: `<div class="state absent">${esc(ACHIEVEMENTS_PENDING)}</div>` })
    : thisWeekCard(d) + pointsCard(d) + achievementCards(d) + logCard(d, served);
  return {
    href: "/quests",
    title: "Quests",
    body,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · a week runs Monday to Sunday, local; quests are Claude Code's · ` +
      `from claude_quests, achievement_tiers and character_points`,
  };
}
```

and these edits:

```diff
--- a/lib/render/empty.ts
+++ b/lib/render/empty.ts
@@ -36,3 +36,13 @@ export const SKILL_USE_COUNTED =
   "Time in the turns that loaded a skill. Your next prompt ends that turn, so a skill guiding a long conversation is credited for the turn that loaded it.";
 export const SKILL_USE_NOT_IN_TOTAL = "Skill use is time already in Claude's level, so it is not in Total.";
 export const noSkillRows = (what: "packs" | "skills"): string => `No ${what} with time yet.`;
+
+/** Stage 8, the Quests page (spec §5). */
+export const QUESTS_PENDING = "Quests pending until the v10 rollup";
+export const ACHIEVEMENTS_PENDING = "Achievements pending until the v10 rollup";
+export const NO_QUESTS_YET = "No quests yet: a quest needs a week with at least 20 requests before it.";
+export const NO_QUESTS_THIS_WEEK = "No quests this week: nothing was measurable last week.";
+export const UNDER_20_SO_FAR = "under 20 requests so far";
+export const NO_READING = "no reading";
+export const NO_UNLOCKS = "No tiers unlocked yet.";
+export const NO_CLOSED_WEEKS = "No closed weeks with quests yet.";
```

```diff
--- a/lib/read/character.ts
+++ b/lib/read/character.ts
@@ -100,6 +100,8 @@ export interface CharacterData {
   /** Every level-up on record, (excluded) aside. */
   levelUpCount: number;
   skillUse: SkillUse;
+  /** Stage 8: Quest and Achievement Points, or null before the v10 rollup. Neither is in the Total level. */
+  points: { qp: number; ap: number } | null;
 }
 
 interface ProgRow {
@@ -168,7 +170,7 @@ function readSkillUse(db: string, prog: ProgRow[]): SkillUse {
 export function readCharacter(db: string, opts: { now?: number; home?: string } = {}): CharacterData {
   const generatedAt = opts.now ?? Math.floor(Date.now() / 1000);
   if (!hasTable(db, "skill_progress")) {
-    return { generatedAt, pending: true, tools: [], totalLevel: null, all: null, levelUps: [], levelUpCount: 0, skillUse: SKILL_USE_PENDING };
+    return { generatedAt, pending: true, tools: [], totalLevel: null, all: null, levelUps: [], levelUpCount: 0, skillUse: SKILL_USE_PENDING, points: null };
   }
   const levels = readLevels(db);
   const shown: AgentSource[] = ["claude"];
@@ -213,5 +215,8 @@ export function readCharacter(db: string, opts: { now?: number; home?: string }
     })),
     levelUpCount: count,
     skillUse: readSkillUse(db, prog),
+    points: hasTable(db, "character_points")
+      ? read<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;")[0] ?? null
+      : null,
   };
 }
```

```diff
--- a/lib/render/character.ts
+++ b/lib/render/character.ts
@@ -72,7 +72,8 @@ function skillsCard(d: CharacterData): string {
   const use = d.skillUse.level;
   const tiles = d.tools.map(tile).join("") + (use === null ? "" : tileOf(SKILL_USE_LABEL, SKILL_USE_ANCHOR, use));
   const grid = tiles === "" ? `<div class="state absent">${esc(NO_DRIVEN_HOURS)}</div>` : `<div class="g g-tiles">${tiles}</div>`;
-  const foot = kv("Total level", d.totalLevel === null ? absent("—") : `<b>${d.totalLevel}</b>`);
+  const foot = kv("Total level", d.totalLevel === null ? absent("—") : `<b>${d.totalLevel}</b>`) +
+    (d.points === null ? "" : kv("Quest Points", `<b>${grouped(d.points.qp)}</b>`) + kv("Achievement Points", `<b>${grouped(d.points.ap)}</b>`));
   const note = use === null ? "" : `<p class="note">${esc(SKILL_USE_NOT_IN_TOTAL)}</p>`;
   return card({ title: "Skills", wide: true, body: grid + `<div class="block">${foot}${note}</div>` });
 }
```

```diff
--- a/lib/views.ts
+++ b/lib/views.ts
@@ -25,6 +25,7 @@ import { readPerformance } from "./read/perf.ts";
 import { readProfile } from "./read/profile.ts";
 import { DEFAULT_RANGE, RANGES, type Range } from "./read/range.ts";
 import { readProjects } from "./read/projects.ts";
+import { readQuests } from "./read/quests.ts";
 import { readSessions } from "./read/sessions.ts";
 import { readSkills } from "./read/skills.ts";
 import { readSources, type ConfiguredSource } from "./read/sources.ts";
@@ -37,6 +38,7 @@ import { viewPage, type View } from "./render/layout.ts";
 import { overviewView } from "./render/overview.ts";
 import { performanceView } from "./render/perf.ts";
 import { profileView } from "./render/profile.ts";
+import { questsView } from "./render/quests.ts";
 import { rangeBlocks, renderReport } from "./render/report.ts";
 import { projectsView } from "./render/projects.ts";
 import { sessionsView } from "./render/sessions.ts";
@@ -79,6 +81,7 @@ export interface StaticView {
 export const STATIC_VIEWS: StaticView[] = [
   { href: "/overview", ranged: true, build: (c) => overviewView(readOverview(c.db, { now: c.now, range: c.range, home: c.home }), { tz: c.tz, served: c.served }) },
   { href: "/character", ranged: false, build: (c) => characterView(readCharacter(c.db, { now: c.now, home: c.home }), { served: c.served, tz: c.tz }) },
+  { href: "/quests", ranged: false, build: (c) => questsView(readQuests(c.db, { now: c.now }), { served: c.served, tz: c.tz }) },
   { href: "/history", ranged: true, build: (c) => historyView(readHistory(c.db, { now: c.now, range: c.range }), { tz: c.tz }) },
   { href: "/projects", ranged: true, build: (c) => projectsView(readProjects(c.db, { now: c.now, range: c.range }), { served: c.served, tz: c.tz }) },
   {
```

```diff
--- a/lib/render/layout.ts
+++ b/lib/render/layout.ts
@@ -279,7 +279,7 @@ table.sortable td a { color: var(--label); text-decoration: none; } table.sortab
   html[data-nav=sidebar] .grp { display: block; font-size: 9px; letter-spacing: .2em; text-transform: uppercase;
     color: var(--label); font-weight: 700; margin: 12px 4px 2px; }
   html[data-nav=sidebar] .grp-all { order: 1; margin-top: 0; }
-  html[data-nav=sidebar] .t-overview, html[data-nav=sidebar] .t-character { order: 2; }
+  html[data-nav=sidebar] .t-overview, html[data-nav=sidebar] .t-character, html[data-nav=sidebar] .t-quests { order: 2; }
   html[data-nav=sidebar] .tool-cc { order: 3; background: none; box-shadow: none; border: 0; padding: 12px 4px 2px;
     font-size: 9px; letter-spacing: .2em; color: var(--label); }
   html[data-nav=sidebar] .pages a, html[data-nav=sidebar] .pages .pill { order: 4; }
@@ -298,6 +298,7 @@ export interface ToolLink { label: string; href: string; cls: string }
 export const TOOLS: ToolLink[] = [
   { label: "Overview", href: "/overview", cls: "t-overview" },
   { label: "Character", href: "/character", cls: "t-character" },
+  { label: "Quests", href: "/quests", cls: "t-quests" },
   { label: "Claude Code", href: "/", cls: "tool-cc" },
   { label: "Codex", href: "/codex", cls: "t-agent" },
   { label: "Hermes", href: "/hermes", cls: "t-agent" },
```

```diff
--- a/lib/render/report.ts
+++ b/lib/render/report.ts
@@ -87,7 +87,7 @@ export function rangeBlocks(sections: Record<Range, string[]>, active: Range = D
 export function renderReport(views: View[], opts: { generatedAt: number; tz?: string }): string {
   const tz = opts.tz ?? localZone();
   // The Overview, Character, Codex and Hermes are on the tool row, not the page row.
-  const TOOL_ROW = new Set(["/overview", "/character", "/codex", "/hermes"]);
+  const TOOL_ROW = new Set(["/overview", "/character", "/quests", "/codex", "/hermes"]);
   const nav = views.filter((v) => !TOOL_ROW.has(v.href)).map((v) => ({
     href: `#${anchorOf(v.href)}`,
     label: NAV.find((n) => n.href === v.href)?.label ?? v.title,
@@ -105,6 +105,7 @@ export function renderReport(views: View[], opts: { generatedAt: number; tz?: st
     tools: [
       { label: "Overview", href: "#overview", cls: "t-overview" },
       { label: "Character", href: "#character", cls: "t-character" },
+      { label: "Quests", href: "#quests", cls: "t-quests" },
       { label: "Claude Code", href: "#history", cls: "tool-cc" },
       { label: "Codex", href: "#codex", cls: "t-agent" },
       { label: "Hermes", href: "#hermes", cls: "t-agent" },
```

- [ ] **Step 3.4: Run the tests and watch them pass**

Run: `npx vitest run tests/quests-page.test.ts tests/read-character.test.ts tests/render-character.test.ts tests/sources-report.test.ts tests/report-budget.test.ts && npm run typecheck`

Expected: PASS. `quests-page` has 13 tests.

Then run the whole suite: `npx vitest run --exclude '.claude/**'`. Expected: all green (1167
tests in 73 files).

The budget pin was measured on `density-182` → `density-270`:
- `quests`: 18,773 → 22,177 B, 271 B/week, pinned at 320 (+15%, rounded up to the next 10);
- total: 6,156 B/week, under its 6,770 pin.

If the measurement moves, re-measure with a temporary `process.stderr.write` of `perWeek` in
the budget test. Re-pin at +15%, rounded up to the next 10, and update the comment's numbers.

- [ ] **Step 3.5: Commit**

```bash
git add lib/read/quests.ts lib/render/quests.ts lib/render/empty.ts lib/read/character.ts \
  lib/render/character.ts lib/views.ts lib/render/layout.ts lib/render/report.ts \
  tests/quests-page.test.ts tests/read-character.test.ts tests/render-character.test.ts \
  tests/sources-report.test.ts tests/report-budget.test.ts
git commit -m "Stage 8: the Quests page — this week's quests, points, achievements and the quest log"
```

- [ ] **Step 3.6: Plant guard 10**

```bash
python3 "$L/plants.py" 10 lib/read/character.ts
npx vitest run tests/read-character.test.ts tests/render-character.test.ts tests/quests-page.test.ts tests/sources-report.test.ts 2>&1 | grep -E "^\s+×|Tests "
git checkout -- lib/read/character.ts
```

Expected: only "achievement unlocks stay out of the level-up log" is red. Record it in
`task-3-report.md`.

---

### Task 4: Live proof, `SESSION.md`, `CLAUDE.md`

**Files:**
- Modify: `SESSION.md` (title line; a new Session 22 entry on top)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the whole branch.
- Produces: the proof numbers in `task-4-report.md` and `SESSION.md`.

- [ ] **Step 4.1: Make two copies of one snapshot**

Use the session scratchpad. `$SP` below is `<scratchpad>/stage8-proof`.

```bash
SP=<scratchpad>/stage8-proof; mkdir -p "$SP/main" "$SP/branch"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup '$SP/snap.sqlite'"
sqlite3 "$SP/snap.sqlite" ".backup '$SP/main/db.sqlite'"
sqlite3 "$SP/snap.sqlite" ".backup '$SP/branch/db.sqlite'"
git show main:capture/rollup.sh > "$SP/main/rollup.sh"; git show main:capture/lib.sh > "$SP/main/lib.sh"
cp capture/rollup.sh capture/lib.sh "$SP/branch/"
```

- [ ] **Step 4.2: Roll both up, timed, on one as-of day**

```bash
TODAY=$(date +%F)
for side in main branch; do
  /usr/bin/time -p env THEONE_DB_PATH="$SP/$side/db.sqlite" WATCHTOWER_DB_PATH="$SP/$side/db.sqlite" \
    CC_LIB_PATH="$SP/$side/lib.sh" WATCHTOWER_ROLLUP_TODAY="$TODAY" bash "$SP/$side/rollup.sh" --quiet
done
```

Expected: both exit 0, and the branch's `real` is at most 1 s above main's. The prototype
measured 4.22 s on main and 4.34 s on the branch. Record both times.

- [ ] **Step 4.3: Nothing that exists moved**

```bash
cd "$SP/branch"
for T in claude_daily_rollups claude_project_rollups claude_rank_progress claude_profile_daily claude_discipline_scores \
         claude_prices claude_request_metrics claude_turns agent_prices agent_request_metrics agent_daily_rollups \
         agent_progress claude_model_rollups skill_daily skill_progress skill_level_ups skill_pace claude_skill_rollups; do
  cols=$(sqlite3 db.sqlite "SELECT group_concat(name, ', ') FROM pragma_table_info('$T') WHERE name <> 'updated_at';")
  sqlite3 -bail db.sqlite "ATTACH '$SP/main/db.sqlite' AS m;
    SELECT '$T', (SELECT COUNT(*) FROM $T),
      (SELECT COUNT(*) FROM (SELECT $cols FROM $T EXCEPT SELECT $cols FROM m.$T)),
      (SELECT COUNT(*) FROM (SELECT $cols FROM m.$T EXCEPT SELECT $cols FROM $T));"
done
```

Expected: every line reads `T|<rows>|0|0`. The prototype got 18 of 18. Any non-zero count is a
stop-and-report.

- [ ] **Step 4.4: The identities, on live data**

```bash
sqlite3 -bail "$SP/branch/db.sqlite" "
SELECT
  (SELECT COUNT(*) FROM claude_quests q JOIN claude_quests p
     ON p.discipline = q.discipline AND p.week = date(q.week, '-7 days') WHERE q.baseline IS NOT p.value),
  (SELECT COUNT(*) FROM (SELECT week FROM claude_quests GROUP BY week HAVING COUNT(*) > 3 OR MAX(slot) <> COUNT(*))),
  (SELECT COUNT(*) FROM claude_quests WHERE status IN ('done','missed') AND
     (status = 'done') <> CASE direction WHEN 'at-least' THEN value >= target ELSE value <= target END),
  (SELECT COUNT(*) FROM claude_quests WHERE status = 'no data' AND value IS NOT NULL),
  (SELECT qp FROM character_points) - (SELECT COUNT(*) FROM claude_quests WHERE status = 'done'),
  (SELECT ap FROM character_points) - (SELECT COALESCE(SUM(points), 0) FROM achievement_tiers),
  (SELECT COUNT(*) FROM achievement_tiers WHERE (points > 0) <> (unlocked_day IS NOT NULL)),
  (SELECT COUNT(*) FROM achievement_tiers WHERE points NOT IN (0, tier));"
```

Expected: `0|0|0|0|0|0|0|0`.

- [ ] **Step 4.5: One week's quests, one value and one tier by hand**

Take the latest closed week that has a Look before you leap quest:

```bash
sqlite3 "$SP/branch/db.sqlite" "SELECT week, week_end, value, baseline, target FROM claude_quests
  WHERE discipline = 'verification' AND status <> 'open' AND value IS NOT NULL ORDER BY week DESC LIMIT 1;"
```

For that week (`:w`, `:we`), check three things.

1. **Its quests are the three lowest eligible scores on its Sunday-before.** List
   `claude_discipline_scores` on `date(:w, '-1 day')` with `status <> 'needs-data'`, ordered by
   score and then display order. The week's quests must be the first three, in slot order,
   after skipping only disciplines that were not measured the week before. For each skipped
   discipline, show from the raw tables why: fewer than 20 requests that week, no tool or hook
   coverage yet, or nothing to divide.
2. **Its value, from the raw tool calls:**

   ```sql
   SELECT round(round(SUM(tool_name IN ('Read','Grep','Glob')) * 1.0 / COUNT(*) / 0.001) * 0.001, 3)
   FROM claude_tool_calls
   WHERE is_sidechain = 0 AND tool_name IS NOT NULL AND ts IS NOT NULL
     AND strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') BETWEEN :w AND :we;
   ```

   It must equal the stored `value`.
3. **Its target:** `min(baseline + 0.02, 0.5)`, rounded to 0.001. It must equal the stored
   `target`.

Then check one running-total tier's date. Take Claude's Regular silver (100 sessions); if it
is locked, take bronze:

```sql
SELECT day, SUM(sessions_count) OVER (ORDER BY day) AS total FROM claude_daily_rollups ORDER BY day;
```

The first day with `total >= 100` must equal `achievement_tiers.unlocked_day` for `('regular',
'claude', 2)`.

- [ ] **Step 4.6: Record the numbers, and check the report**

From `$SP/branch/db.sqlite`, record:
- this week's quests: `SELECT discipline, baseline, target, hold, value, requests, status FROM
  claude_quests WHERE status = 'open' ORDER BY slot`;
- `SELECT qp, ap FROM character_points`;
- the unlocked tiers by tier: `SELECT tier, COUNT(*) FROM achievement_tiers WHERE unlocked_day
  IS NOT NULL GROUP BY tier`;
- the ten most recent unlocks;
- the quest log's counts: `SELECT status, COUNT(*) FROM claude_quests GROUP BY status`.

The prototype, on the 2026-10-07 snapshot, gave:
- this week: cost-discipline 249 → 224, verification 0.055 → 0.075, reuse 2 → 3, all open;
- done 14, missed 22, no data 3, open 3;
- QP 14 and AP 43.

Build the report from the branch copy:

```bash
WATCHTOWER_DB_PATH="$SP/branch/db.sqlite" node bin/watchtower report --out "$SP/report.html"
```

Its size must be under 2,000,000 bytes. Then confirm, in its text:
- `/quests` renders: `id="quests"` and the `t-quests` pill;
- Character's Skills card has the two point rows;
- there is no `NaN`, and no quest value shown as a bare `0` where the stored value is NULL.

- [ ] **Step 4.7: Update `CLAUDE.md`**

- In **Commands**, change the test count `(1130 tests, 70 files)` to the suite's new count.
- After the Stage 7 paragraph in **Durable vs regenerable tables**, add:

  ```markdown
  Stage 8 (schema v10) adds weekly quests and achievements, three regenerable tables.
  `claude_quests` (per week × slot: the discipline, its baseline, target, value and status) is
  filled by the profile section: `_pf_win` gains a `'wk'` window (Monday to Sunday, local,
  keyed by its Monday, through the as-of day's week), `_pf_wk` measures each week and
  discipline once, and each week's quests are the three lowest eligible 30-day scores of the
  Sunday before it. Every step, full-marks value and precision is in `_pf_qdef`.
  `achievement_tiers` (per achievement × tool × tier, dated the first day history reached it)
  and `character_points` (QP and AP) are filled by the agent section's read phase from tables it
  already holds; every threshold is in `_ac_def`. `_sk_today` (which `WATCHTOWER_ROLLUP_TODAY`
  pins) is computed before the profile section, which receives it as `_pf_asof`. The Quests
  page (`/quests`, `lib/read/quests.ts` + `lib/render/quests.ts`, unranged, after Character in
  the tool row, and in the report) reads, groups and labels only. QP and AP are two rows on
  Character's Skills card and are **not in the Total level**; tier unlocks are not level-ups.
  ```

- In **Invariants**, change "`CC_SCHEMA_VERSION` is **9**" to "**10**".

- [ ] **Step 4.8: Update `SESSION.md`**

- Change the title line to cover session 22: Stage 8 implemented.
- Add `## Session 22 — <date> — Stage 8 (Quests and achievements) implemented` above Session
  21, in Session 21's shape:
  - **branch and review shape:** the branch, the commits, the test count;
  - **what it does:** two sentences;
  - **live proofs:** steps 4.2–4.6's numbers, and the copy paths;
  - **guard plants:** a table of the ten plants and every test each reddened, from the task
    reports;
  - **rulings:** R1–R13 by title, plus any controller rulings from the ledger;
  - **open items:**
    - the PR number;
    - the user's `! gh pr merge <n> --squash --delete-branch`, `! bash capture/install.sh`
      (v10) and `! watchtower sync`;
    - "Until the v10 rollup runs, `/quests` reads pending and Character shows no point rows."

- [ ] **Step 4.9: Run the suite and typecheck, then commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`

Expected: all green.

```bash
git add SESSION.md CLAUDE.md
git commit -m "docs: Stage 8 live proof, session 22 handoff, CLAUDE.md for schema v10"
```

---

## After the tasks

1. Run one whole-branch review on the most capable model, scoped to `67eb1ad..HEAD`. Give it
   the spec's §10 and this plan's Review Focus and Rulings.
2. Run at most one fix wave. Each fix is its own commit. A fix that changes a number re-runs
   step 4.3.
3. Push the branch and open the PR. The user merges, installs and syncs. Auto mode blocks those
   steps, so hand over the exact `!` commands.

## Plan self-review (done while writing)

- **Spec coverage:**

  | Spec section | Where |
  |---|---|
  | §4.0 (where each part runs) | Task 1 (as-of move, profile quests), Task 2 (agent section) |
  | §4.1 (tables) | Task 1 (all three declared), R1, R4 |
  | §4.2 (the week, `_pf_wk`, coverage) | Task 1, guards 2 and 5, Review Focus 1 |
  | §4.3 (choosing quests) | Task 1, guard 1, the slot-order identity |
  | §4.4 (targets, hold, status, QP) | Task 1, guards 3–6, Review Focus 2; QP in Task 2 |
  | §4.5 (achievements) | Task 2, guards 7 and 9, the coverage identity, Review Focus 4 |
  | §4.6 (points) | Task 2, guard 8, the QP/AP identity |
  | §5 (the page, Character, states) | Task 3, guard 10, Review Focus 5 |
  | §6.1 guards 1–10 | the guard map; plants in `plants.py`; whole-suite results in `plant-results.md` |
  | §6.1 identities | Tasks 1 and 2's identity tests; R11 for the unchanged tables |
  | §6.1 "also pinned" | schema (Task 1), lock shape (Tasks 1 and 2), v9→v10 (Task 1), stored values on the page and no literals (Task 3), states (Task 3), budget (Task 3) |
  | §6.2 | Task 4, steps 4.2–4.6 |
  | §7 | After the tasks |
  | §10.1–10.6 | guard 1; Review Focus 2, 1, 3, 4, 5 |

- **Placeholders:** none. Every code block is cut from the verified patches. `<scratchpad>`,
  `<date>` and `<n>` are filled in at run time.
- **Types:** `QuestsData`, `QuestWeek`, `Quest`, `Achievement`, `Tier`, `Unlock`,
  `readQuests`, `questsView`, `RECENT_UNLOCKS` and `CharacterData.points` are spelled the same
  in Task 3's code and its tests. The table and column names match across the rollup, the
  tests and the reader.
- **R21 risks, resolved while writing:**
  - Guard 4's plant also reddened guard 2's test, which then asserted `missed`. Guard 2 now
    asserts the week's span, its requests and that it was measured.
  - Guard 7's plant would redden an exact-date Perfect week test. See R8.
