# Stage 8 — Quests and achievements: weekly habit quests, tiered milestones, Quest and Achievement Points

**Status:** chat design approved 2026-10-08 (all five sections); the written spec was approved
2026-10-09 and implemented on this branch.
**Branch:** `stage-8-quests-achievements`, cut from `main` @ `67eb1ad` (Stage 7, #21).
**Builds on:** the Usage Profile (`2026-09-25-stage-4a-usage-profile-design.md`): its ten
disciplines, their 30-day scores and its per-day `_pf_*day` aggregates. Also Stage 6's keyed
level pipeline (`_sk_daily`, `_sk_prog`, `_sk_ups`, `_sk_runs`) and Stage 7's skill and pack rows.
**Brainstorm:** `2026-10-07-stage-8-quests-achievements-brainstorm.md` (decisions 1–12, the
findings and each section as presented). This is piece 2 of the "MMORPG stats" request
(Stage 6 spec §9).

## 1. Purpose and success

Levels say how much you have used each tool. Nothing yet says how well you have used it, or
pushes you to improve. This stage adds two things, on a new page, `/quests`:
- **Quests**: each week, three habit quests aimed at your three weakest Usage Profile
  disciplines. Each quest's target is one step better than last week.
- **Achievements**: tiered milestones (bronze → silver → gold → platinum), each unlocked from
  history on the real day you reached it.

Both earn separate points: **Quest Points** (QP) and **Achievement Points** (AP). These are
shown on `/quests` and on the Character page. Levels stay measured hours only.

**Every figure is measured.** A quest's value is measured over its own calendar week. A
week that measured nothing is `no data`, never `missed`. Every threshold, step, target and
status is computed in `rollup.sh`. The page only reads, parses and labels.

Success:
- Every past week has its quests and results, and so does the current one. The same database
  always gives the same quests.
- Each week's baseline equals the previous week's value for the same discipline.
- QP equals the number of quests done. AP equals the sum of the weights of the unlocked tiers.
- No existing number moves. Every Stage 7 proof table is identical to `main`'s rollup on the
  same snapshot, `updated_at` aside. That covers `agent_progress`, every `skill_*` table, the
  Total level and every `claude_*` rollup.
- The page never shows `missed` for a week with no data, never shows a missing number as 0,
  and never shows a missed quest whose value displays equal to its target.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | **Both recognise and nudge.** Achievements mark milestones; quests push habits, not hours. |
| 2 | **Quests aim at your weak spots.** Each week's quests are the three lowest Usage Profile disciplines from the week before. This is deterministic, so every past week has quests and results. |
| 3 | **Achievements are tiered milestones**: bronze → silver → gold → platinum on one measured thing each, unlocked from history with the real date. |
| 4 | **Rewards are separate points**, QP and AP, kept apart from XP. Levels stay measured hours only. |
| 5 | **Weekly behaviour quests** (approach A). Each discipline has one quest, measuring its key behaviour over the quest week only. Quests are not score deltas and not weekly discipline scores. |
| 6 | **Targets step up from last week.** The target is last week's value moved one fixed step, never past the value that earns full marks. At full marks the quest is to hold it. |
| 7 | **A new page, `/quests`**, with no date range. It sits in the tool row after Character. The Character page gains QP and AP. |
| 8 | **Quests are Claude-only**, because only Claude has disciplines. Achievements cover every tool. |
| 9 | **No resting rule.** A discipline that is always lowest (cost-discipline is 0 on every scored day) keeps its quest every week. |
| 10 | **A fixed catalogue of achievements** (§4.5). Each has four tiers; thresholds live in `rollup.sh`; AP is 1/2/3/4 per unlocked tier. There are no per-key achievements and no hours, model-count or cost achievements. |
| 11 | **Schema v10 adds three regenerable tables.** `claude_quests` is filled by the profile section. `achievement_tiers` and `character_points` are filled by the agent section. The rules for streaks and levels are not copied. |
| 12 | **Tier unlocks stay on `/quests`** and do not enter Character's level-up log. |

Decision 10 in the brainstorm counted "20 achievements". The catalogue it lists has 12
achievements. Five are per tool and seven are Claude-only, so with all three tools
registered that makes 22 rows and 88 tiers. This spec builds the catalogue exactly as listed.

## 3. Measured on 2026-10-07 (the live DB, read-only)

| Fact | Value |
|---|---|
| Discipline scores | 30-day rolling windows, only on ungated days (`window_requests >= 20`), 0–60 each. One week moves a score by about a quarter at most. |
| `cost-discipline` | 0 on all 103 scored days: cache re-read ÷ fresh tokens is about 219, against a full-marks bar of ≤ 10. |
| Weekly values, 2026-08-17 → 2026-10-05 | Inspect share 2.1–5.5%; cache re-read ratio 127–554; models 1–4; distinct slash commands 2–9. |
| Quests for the week of 2026-10-05 | Lean cache, Look before you leap, Signature move |
| Achievement inputs | Claude: 3,268 sessions, 33.5M output tokens, best streak 33 days, 37 project keys, 33 skills, Lv 78. Codex: 87 driven sessions, Lv 57. Hermes: 39 driven sessions, Lv 46. Best day: 8 disciplines strong (2026-08-02). |

## 4. Derivations (`capture/rollup.sh`)

`CC_SCHEMA_VERSION` goes from 9 to 10, in `capture/lib.sh` and `lib/config.ts`. All three new
tables are declared in `capture/lib.sh`. Every intermediate table is built in its section's
read transaction (`BEGIN DEFERRED`). Only the swaps run under `BEGIN IMMEDIATE`.

### 4.0 Where each part runs

- **Before the profile section, in bash:** the as-of day (`_sk_today`, which
  `WATCHTOWER_ROLLUP_TODAY` pins) moves up from the agent section and is computed once. Both
  sections receive it as a one-row temp table. The profile section is fed the same way the
  agent section already is: a prelude printed ahead of its heredoc, piped into `sqlite3`.
- **The profile section:**
  - `_pf_win` gains a `'wk'` window.
  - `_pf_wk` measures each (week, discipline) once (§4.2).
  - `_q_pick` and `_q_rows` choose and score each week's quests (§4.3–4.4).
  - Its swap writes `claude_quests`.
  - Everything is built after `_pf_scores` and the Total updates, before the read phase's
    `COMMIT`.
- **The agent section:** `_ac_*` builds every tier row from tables this section already holds
  (`_sk_daily`, `_sk_prog`, `_sk_ups`, `_sk_runs`, `_ag_daily`). It also reads the committed
  `claude_daily_rollups`, `claude_discipline_scores` and `claude_quests`. Its swap writes
  `achievement_tiers` and `character_points` (§4.5–4.6). The profile section commits before
  the agent section starts, and the rollup exits on a profile failure, so `claude_quests` is
  always current when it is read.

### 4.1 Tables (all regenerable)

| Table | Key | Columns |
|---|---|---|
| `claude_quests` | (week, slot) | `week` TEXT (the Monday), `slot` INTEGER 1–3, `discipline` TEXT, `score` INTEGER (the 30-day score that chose it), `direction` TEXT (`at-least` or `at-most`), `baseline` REAL, `target` REAL, `hold` INTEGER 0/1, `value` REAL (NULL when not measured), `requests` INTEGER (the week's requests so far), `status` TEXT (`open`, `done`, `missed`, `no data`); unique on (week, discipline) |
| `achievement_tiers` | (achievement, source, tier) | `achievement` TEXT (key, §4.5), `source` TEXT (`claude`, `codex`, `hermes`), `tier` INTEGER 1–4, `threshold` INTEGER, `value` INTEGER (current, NULL when nothing is measured), `unlocked_day` TEXT (NULL while locked), `points` INTEGER (the tier when unlocked, else 0) |
| `character_points` | one row | `qp` INTEGER, `ap` INTEGER, `updated_at` INTEGER |

### 4.2 The week and its measures (`_pf_wk`)

**A week runs Monday to Sunday, local time.** Its key is its Monday,
`date(day, '-6 days', 'weekday 1')`. The `'wk'` window has one row per distinct Monday of the
`_pf_days` days whose Monday is on or before the as-of day, with `lo` = that Monday and `hi` =
the following Sunday. Each request falls in exactly one week, so `_pf_rq` grows by one row per
request. Everything keyed by `(win, day)` then also covers weeks with no further code:
`_pf_sess`, `_pf_medctx`, `_pf_long` and `_pf_agg`. The other measures sum the per-day tables
(`_pf_tcday`, `_pf_slday`, `_pf_evday`, `_pf_modday`, `_pf_sdkday`) over Monday..Sunday, with
the same range join `_pf_dw` uses.

`_pf_wk` has one row per (week, discipline): `requests` (the week's requests, sidechain
included, as with `window_requests`) and `value`. The value is NULL when the week has fewer
than 20 requests, and also NULL as the table says below. A week is **tool-covered** if its
Monday is on or after `_pf_coverage.coverage_start`, and **event-covered** likewise against
`_pf_evcov.event_start`. These are the profile's coverage rules, applied to the week.

| Discipline | Quest | Value over the week | NULL also when |
|---|---|---|---|
| verification | Look before you leap | `inspect / calls` (Read, Grep, Glob share of main-thread tool calls) | not tool-covered, or 0 calls |
| cost-discipline | Lean cache | `sum_tcr / sum_fresh` from `_pf_agg` | `sum_fresh = 0` |
| context-hygiene | Travel light | `median_ctx` from `_pf_medctx` | no attributed session |
| session-hygiene | Fresh start | `long_with_reset / long_sessions` from `_pf_long` | no long session |
| model-routing | Right tool | `1 − top_n / requests`: the share of all the week's requests off the top model (`<synthetic>` and empty models are not models) | no model |
| security | Ask first | `bypass / prompts_with_mode` | not event-covered, or no prompt with a mode |
| output-quality | Clean run | `errors / calls` (tool error rate) | not tool-covered, or 0 calls |
| prompt-hygiene | Variety pack | distinct slash commands | not tool-covered |
| reuse | Signature move | uses of the week's most-used slash command (0 with none) | not tool-covered |
| automation | Delegate | subagent launches + headless sessions | not tool-covered |

A value is stored **rounded to its quest's precision** (§4.4), and every comparison uses the
stored number.

### 4.3 Choosing a week's quests (`_q_pick`)

For week W (Monday M), the scores come from the 30-day `_pf_scores` of **the Sunday before W**,
`date(M, '-1 day')`. A discipline is **eligible** if, on that day:
1. its status is not `needs-data`, and
2. `_pf_wk` has a non-NULL value for it in the week before W. That value is the **baseline**.

The quests are the three eligible disciplines with the lowest scores. Ties go by display order
(`_pf_ev.ord`, joined in, not copied). They take slots 1–3 in that order. Fewer eligible
disciplines means fewer quests, and none eligible means no quests that week.

This is decision 9's "last scored day on or before the Sunday", stated exactly. Every eligible
discipline needs 20 requests in the week before. That week lies inside the Sunday's 30-day
window, so whenever any quest is eligible the Sunday itself is the last scored day.

Weeks are generated from the first week with a request through the as-of day's week. Only a
week with quests has rows.

### 4.4 Targets and status (`_q_rows`)

Each quest's rule lives in one `VALUES` table in `rollup.sh` (`_q_def`), and nowhere else.

| Discipline | Direction | Step | Full marks | Precision |
|---|---|---|---|---|
| verification | at-least | +0.02 | 0.50 | 0.001 |
| cost-discipline | at-most | ×0.9 | 10 | 1 |
| context-hygiene | at-most | ×0.9 | 60000 | 1000 |
| session-hygiene | at-least | +0.10 | 1.00 | 0.001 |
| model-routing | at-least | +0.05 | 0.35 | 0.001 |
| security | at-most | −0.01 | 0.02 | 0.001 |
| output-quality | at-most | −0.005 | 0.05 | 0.001 |
| prompt-hygiene | at-least | +1 | 5 | 1 |
| reuse | at-least | +1 | 8 | 1 |
| automation | at-least | +2 | 5 | 1 |

- **Target:**
  - at-least: `MIN(baseline + step, full)`;
  - at-most: `MAX(baseline × 0.9, full)` for the relative steps, `MAX(baseline − step, full)`
    for the absolute ones.
  - The target is then rounded to the quest's precision.
- **Hold:** 1 when the baseline is already at or past full marks (at-least: `baseline >= full`;
  at-most: `baseline <= full`). The target is then exactly the full-marks value.
- **Status:**
  - `open` for the week that contains the as-of day;
  - otherwise `no data` when the value is NULL;
  - `done` when the value meets the target (at-least: `value >= target`; at-most:
    `value <= target`);
  - `missed` otherwise.

  The open week shows its value so far, gated at 20 requests like any other week.
- **Quest Points:** 1 per `done` quest.

### 4.5 Achievements (`_ac_def`, `_ac_val`, `_ac_reach`)

The thresholds live in one `VALUES` table in `rollup.sh` (`_ac_def`: achievement, tier,
threshold). Each tier is dated **the first day history reached its threshold**. Every rule
below reuses a table the agent section already builds; none copies a level or streak rule.

**Every tool:** one row per achievement for each source in `_ag_life` (Claude always; Codex and
Hermes once registered, exactly the tools with an `agent_progress` row).

| Key | Name | Value | Day tier N is reached | Tiers |
|---|---|---|---|---|
| `seasoned` | Seasoned | the tool's level (`_sk_prog`, kind `tool`) | its `_sk_ups` day at level N | 50 / 70 / 90 / 99 |
| `daily-habit` | Daily habit | best streak (`MAX(days)` of `_sk_runs`) | the earliest run with `days >= N`, at `date(last_day, '-(days − N) days')` | 7 / 30 / 100 / 365 |
| `regular` | Regular | sessions: Claude's `claude_daily_rollups.sessions_count`; Codex's and Hermes's `_ag_daily` driven sessions | the first day the running sum reaches N | 10 / 100 / 1,000 / 5,000 |
| `wordsmith` | Wordsmith | output tokens: `claude_daily_rollups.tokens_out`; `_ag_daily.tokens_out` | the first day the running sum reaches N | 1M / 10M / 100M / 1B |
| `explorer` | Explorer | projects with time (`_sk_daily` kind `project`, not `(unfiled)` or `(excluded)`) | the N-th smallest first day among them | 3 / 10 / 25 / 50 |

**Claude only** (`source = 'claude'`):

| Key | Name | Value | Day tier N is reached | Tiers |
|---|---|---|---|---|
| `skill-collector` | Skill collector | skills with time (`_sk_daily` kind `skill`) | the N-th smallest first day | 5 / 15 / 30 / 50 |
| `skill-master` | Skill master | highest skill level (`_sk_prog` kind `skill`) | the earliest `_sk_ups` day at level N, kind `skill` | 50 / 70 / 90 / 99 |
| `pack-master` | Pack master | highest pack level, `(no pack)` excluded | the same for kind `pack` | 50 / 70 / 90 / 99 |
| `skill-user` | Skill user | Skill use's level | the same for kind `skill-use` | 50 / 70 / 90 / 99 |
| `all-rounder` | All-rounder | most disciplines `strong` on one day (`claude_discipline_scores`) | the first day with at least N | 4 / 6 / 8 / 10 |
| `quester` | Quester | QP (§4.4) | the Sunday of the week whose running QP reaches N | 10 / 50 / 150 / 300 |
| `perfect-week` | Perfect week | weeks with at least one quest, every one `done` | the Sunday of the N-th such week | 1 / 5 / 20 / 52 |

A tool with no level has a NULL value on `seasoned`, `skill-master`, `pack-master` and
`skill-user`, and every tier locked. Counts and sums are real numbers, 0 included.

### 4.6 Points (`character_points`)

There is one row: `qp`, the number of `done` rows in `claude_quests`, and `ap`, the sum of
`achievement_tiers.points`. Neither enters `agent_progress`, `skill_*` or the Total level.

## 5. The page — `/quests`

`/quests` has no date range. Its tool-row entry (`TOOLS` in `lib/render/layout.ts`, class
`t-quests`, with Overview and Character in the sidebar's first group) comes right after
Character, and so does its entry in `STATIC_VIEWS`. It is served by `watchtower serve` and is a
section of `watchtower report`. Code lives in `lib/read/quests.ts` and `lib/render/quests.ts`.

TypeScript holds only labels:
- each quest's name and unit kind (share, ratio, tokens, count);
- each achievement's name and group;
- the tier names.

Every number, threshold, target, direction and status comes from the three tables.

1. **This week** (Monday–Sunday dates in the heading, from `claude_quests.week`). Up to three
   quest cards. Each shows:
   - the quest's name and discipline;
   - the target with last week's baseline: "≥ 6.1% (last week 4.1%)", or "hold ≥ 50%" when
     `hold`;
   - the value so far;
   - a status pill: `open`, `done`, `missed` or `no data`.

   An open week under 20 requests so far reads "under 20 requests so far", never 0.
2. **Points.** QP and AP as two big numbers.
3. **Achievements.** Three groups: every tool; Claude Code skills (`skill-collector`,
   `skill-master`, `pack-master`, `skill-user`); habits (`all-rounder`, `quester`,
   `perfect-week`).
   - One row per achievement and tool: name, tool, current value and four tier badges.
   - An unlocked badge shows its date.
   - A locked badge is muted and shows its threshold, and the next tier also shows
     "33 / 50 to platinum".
   - **Recent unlocks** at the top: the last 10 tier unlocks, newest first. Ties go to the
     higher tier, then catalogue order.
4. **Quest log.** One row per closed week with quests, newest first: each quest with its
   status, and the QP earned.

**Character:** the Skills card gets two rows after Total level, "Quest Points" and
"Achievement Points". Neither is in the Total. They are shown only once `character_points` has
a row. Tier unlocks never enter the level-up log.

**States:**
- Before the v10 rollup (no `claude_quests` table): "Quests pending until the v10 rollup", and
  the same for achievements.
- A v10 table with no quest rows: "No quests yet: a quest needs a week with at least 20
  requests before it."
- No quests this week: "No quests this week: nothing was measurable last week." The heading has
  no dates in this case; the reader does no week arithmetic.
- `no data` is never shown as `missed`. A NULL value is "no reading", never 0.

## 6. Tests and proof

### 6.1 Guards

Each guard is planted and must turn **exactly one** test red. The plant and the test it
reddened are recorded in the ledger. Following R21, each guard's literal values live in that one
test only.

| # | What it guards | Plant | The one test |
|---|---|---|---|
| 1 | A week's quests come from the scores of the Sunday before it. Fixture: the week's own days would rank a different discipline lowest. | Use the scores of the week's last day | "a week's quests come from the scores before it starts" |
| 2 | A week runs Monday to Sunday, local. A request on a Sunday counts in the week that ends that day. | Start the week on Sunday | "a week runs Monday to Sunday" |
| 3 | A target never passes full marks; at full marks the quest is to hold it, `hold = 1` | Drop the clamp | "a target stops at full marks and holds there" |
| 4 | An at-most quest steps down, relative (Lean cache) and absolute (Clean run) | Flip the step's sign | "an at-most quest steps down" |
| 5 | A closed week with fewer than 20 requests is `no data` | Treat a NULL value as missed | "a quiet week is no data, never missed" |
| 6 | The week containing `WATCHTOWER_ROLLUP_TODAY` is `open`, and the week before it is closed | Close every week | "the current week stays open" |
| 7 | Each tier is dated the first day history reached it (a running sum crossing a threshold mid-history) | Date it at the latest day | "each tier is dated the first day it was reached" |
| 8 | AP weights tiers 1/2/3/4 | Count unlocked tiers | "achievement points weight each tier" |
| 9 | Quester and Perfect week date from each week's Sunday, not from the latest total | Use the current QP for every week | "quest achievements date from their week" |
| 10 | Tier unlocks stay out of Character's level-up log | Union them in | "achievement unlocks stay out of the level-up log" |

**Identities**, asserted on the same fixtures with no literal values:
- each week's baseline equals the previous week's `value` for the same discipline;
- at most three quests per week, and the slots follow score, then display order;
- `qp` equals the number of `done` rows;
- `ap` equals the sum of the weights of the unlocked tiers;
- `agent_progress`, `skill_daily`, `skill_progress`, `skill_level_ups`, `skill_pace` and the
  Total level are identical with and without the inputs that create quests.

**Also pinned:**
- both schema versions are 10;
- the read phases hold no write lock (`tests/profile-rollup.test.ts`'s lock shape), with the
  quest tables in the profile section's read phase and `_ac_*` in the agent section's;
- a rollup on a v9 database adds the v10 tables without touching v9 data;
- the page shows stored thresholds and targets: change one in the database and the rendered
  page follows;
- no step, full-marks value or tier threshold, and no `MIN(gap,`, under `lib/`;
- every state in §5;
- `/quests` gets its own `PER_WEEK_LIMIT` in `tests/report-budget.test.ts`, pinned from the
  density fixture at implementation.

### 6.2 Live proof (by hand, on `.backup` copies, each in its own directory)

`main/` runs `main`'s `rollup.sh` and `lib.sh` (from `git show`), and `branch/` runs the
branch's. Both run on copies of one snapshot with the same `WATCHTOWER_ROLLUP_TODAY`.

1. **Nothing that exists moves.** All 17 Stage 7 proof tables, compared whole (every
   `skill_*` kind), with `EXCEPT` both ways under `-bail`, `updated_at` aside. Every count must
   be `0|0`.
2. **The identities** of §6.1 on live data: 0 mismatches.
3. **By hand:**
   - one closed week's quests: the three lowest eligible scores on its Sunday; one quest's
     value recomputed from the raw tables (`claude_tool_calls`, `claude_requests` or
     `claude_slash_commands`); its target from its baseline;
   - one tier's date, from its daily running sum.
4. **Recorded for `SESSION.md`:** this week's quests with targets; QP and AP; unlocked tiers by
   tier; the recent unlocks; the quest log's done / missed / no-data counts.
5. **Budgets:** the rollup timed on both copies, under 1 s added. The report stays under
   2,000,000 bytes, renders `/quests`, and its text has no `NaN` and no fabricated 0.

## 7. Rollout

Watchtower only:
1. Merge.
2. The user runs `install.sh` (v10). I hand over the exact `!` command.
3. `watchtower sync`, or the next session's rollup, fills the tables. Until then `/quests`
   reads "pending until the v10 rollup", and Character shows no points rows.

TheOneOS reads none of the new tables and no existing number changes, so it needs no change
and no lockstep proof beyond §6.2 step 1.

## 8. Task shape

Four tasks, subagent-driven with the user's lighter review: no per-task gates, one final
whole-branch review on the most capable model, and at most one fix wave.
1. Schema v10 (three tables, both version declarations); the as-of day moved up; the `'wk'`
   window, `_pf_wk`, `_q_def`, `_q_pick`, `_q_rows` and `claude_quests` (guards 1–6).
2. The agent section: `_ac_def`, `_ac_val`, `_ac_reach`, `achievement_tiers` and
   `character_points` (guards 7–9).
3. `lib/read/quests.ts` and `lib/render/quests.ts`; the nav; `STATIC_VIEWS`; Character's two
   rows; every state; the budget pin (guard 10).
4. The live proof, `SESSION.md` and `CLAUDE.md` (the new tables, schema 10, the as-of day in
   the profile section).

## 9. Not in this stage

- Quests for Codex or Hermes (they have no disciplines).
- Per-key achievements (one per project, skill or model), and hour, model-count or cost
  achievements.
- An early `done` before the week ends, a "resting" rule for a discipline that is always lowest,
  or re-rolling a week's quests.
- QP or AP feeding XP, levels or the Total.
- Any change to `/profile`, Overview or TheOneOS.

## 10. Review focus

1. **The selection day.** The scores are the Sunday's, from `_pf_scores` in the same
   transaction. A week's own days never influence its quests.
2. **Rounding.** The value, baseline and target are stored at the quest's precision, and
   status compares the stored numbers. A displayed value equal to its target is never
   `missed`.
3. **Coverage.** A week before the tool-call or hook coverage start has NULL tool or event
   measures, so it is `no data` (as a quest's own week) or ineligible (as a baseline week).
   It is never 0.
4. **The open week.** It is keyed off the as-of day, not `date('now')`. `_pf_days` still runs
   to today, and weeks after the as-of day get no rows.
5. **A tool with no level.** Its level achievements have a NULL value and stay locked; it is
   never shown as Lv 0 or Lv 1.
6. **A reader on a v9 database.** "Pending", never an error page.
