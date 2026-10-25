# Stage 6 — Character: skills, sub-skills, pace and level-ups

**Status:** chat design approved 2026-10-03 (data, page, tests). This written spec is awaiting
review. §2.1 lists the places where it refines the chat design.
**Branch:** `stage-6-character-skills`, cut from `main` @ `e26c362` (Stage 5, #19).
**Builds on:** `2026-10-03-stage-5-agents-and-levels-design.md`. Its levels (§4.4) are reused
exactly: the same XP rule, the same 99 thresholds, the same tiers and the same stars.
**First of three:** this is piece 1 of the "MMORPG stats" request. Piece 2 is achievements and
quests, and piece 3 is character attributes. Each gets its own spec (§9).

## 1. Purpose and success

After Stage 5 the user saw "xp but no mmorpg stats, just xp". Each tool had a level and an XP
bar, and nothing else. This stage gives Watchtower a **Character** page in the spirit of an
MMORPG skills tab:
- every tool as a skill;
- the tool's projects and models as sub-skills that level on their own;
- how fast you are levelling and when the next level lands;
- the dates you reached each level;
- your streaks.

**Every figure is measured.** Nothing is estimated, borrowed or invented.

Success:
- Every sub-skill's hours add up exactly to its tool's hours, every day, for every tool. A
  second of driven time is never counted twice and never lost.
- No existing number moves. Claude's tables and `agent_progress` are identical to `main`'s
  rollup on the same snapshot, except for `updated_at`.
- The page never shows "Lv 1", "0 XP" or an ETA where nothing was measured.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | **Watchtower only.** TheOneOS is untouched and keeps its level ring. |
| 2 | **Sub-skills:** each tool's **projects** and **models**, levelling from that tool's driven hours. There are no cross-tool project skills. |
| 3 | **A model earns the time you were driving it.** Each counted second goes to the model of the session's latest main-thread request at that moment (§4.3). |
| 4 | **All math lives in `rollup.sh`** (approach 1). The Stage 5 level pipeline is generalised from three tool rows to keyed rows. The page only reads, parses and labels. |
| 5 | **The page is Character** (`/character`), in the tool row after Overview. It is **unranged**, because levels are lifetime. `/skills` stays "Models & Skills". |
| 6 | **The same curve for every skill:** Stage 5 §4.4's XP rule, thresholds, tiers and stars. |
| 7 | **Pace** is XP per **calendar** day over the last 28 days. ETAs are shown only "at your 28-day pace", and are empty with no pace. |
| 8 | **Hermes sessions that used several models** go to a "(several models)" sub-skill, not a guessed split. Hermes stores no per-call times. |
| 9 | Achievements and quests (piece 2) and character attributes (piece 3) are later stages. |

### 2.1 Refinements of the chat design

1. **Claude's recorded session model is a fallback.**
   - 2,433 Claude sessions have no main-thread request, because their transcripts were never
     ingested. 126 of them have active time: 46.3 h of Claude's 300.7 h.
   - Under the chat design, all of that time would have gone to `(no model)`.
   - `claude_sessions.model` records the model for all but 2.4 h of it. Because it is the model
     the session ran on, decision 3 still holds.
   - It is the last fallback before `(no model)`.
2. **The gap rule is not copied a third time.**
   - Each rollup section runs in its own `sqlite3` connection, so section 1's `_act` never
     reaches a later section.
   - `tests/capture-scripts.test.ts` pins `MIN(gap, 300)` at 4 copies and `MIN(gap, 14400)` at
     3.
   - So the models are attributed where the gaps are already computed (§4.0). Claude's model
     hours reach the level pipeline through one new regenerable table, `claude_model_rollups`.

## 3. Measured on 2026-10-03 (the live DB, after Stage 5's install, read-only)

| Fact | Value |
|---|---|
| Claude lifetime active time | 300.7 h, over 82 active days from 2026-07-04 to 2026-10-03 |
| Claude projects with active time | 36. The two largest have 81.6 h and 71.7 h. |
| Codex / Hermes projects with active time | 9 / 3 |
| Claude sessions with a main-thread request, by distinct main-thread models (excluding `<synthetic>`) | 743 one, 19 two, 3 three |
| Claude sessions with no main-thread request | 2,433. 126 have active time, 46.3 h in all. By `claude_sessions.model`: 37.9 h `claude-opus-5[1m]`, 3.3 h `claude-opus-4-8[1m]`, 2.4 h NULL, the rest under 2 h each. One has only sidechain requests (0 h). |
| Claude request models | `claude-opus-5` 14,935, `claude-opus-4-8` 7,946, `claude-opus-5-5` 5,570, `claude-sonnet-5` 3,970, `claude-fable-5` 2,299, and others |
| Codex request models | `gpt-5.5` 2,381, `gpt-5.6-sol` 1,339, `codex-auto-review` 419, `gpt-6.1-sol` 413, `gpt-6-astra` 201, `gpt-5.2-codex` 114, `gpt-5.2` 16, `gpt-5.4-mini` 1 |
| Codex `wt_requests.is_subagent` | NULL on all 4,884 rows, because Codex records no subagent flag. 34 sessions have only `codex-auto-review` requests. |
| Driven sessions with no usable request | Codex 10 of 78, Hermes 2 of 39 |
| Hermes sessions by number of models (`wt_requests`, from Hermes's `session_model_usage`) | 55 one, 9 two, 3 three (67 sessions, 85 rows). Every row's `ts` is the session start. |
| Time columns | INTEGER epoch seconds in `claude_events.ts`, `claude_requests.ts` and `wt_requests.ts` |

## 4. Derivations (`capture/rollup.sh`)

`CC_SCHEMA_VERSION` goes from 7 to 8, in `capture/lib.sh` and `lib/config.ts`. Every new table
is regenerable and declared in `capture/lib.sh`. Every intermediate is built in its section's
read transaction (`BEGIN DEFERRED`). Only the swaps run under `BEGIN IMMEDIATE`.

### 4.0 Where each part runs

- **Section 1 (daily rollups).**
  - `_act`'s per-gap rows become their own temp table, `_gap`. It holds the session,
    project_key, the ending event's `ts` and `id`, and the gap's `active_s` and `window_s`.
  - `_act` becomes the sum of `_gap`, so the rule's text still appears once and no number moves.
  - Each `_gap` row also gets its driving model (§4.3).
  - The section's swap writes `claude_model_rollups` beside the daily and project rollups.
- **The agent section (Stage 5).**
  - `_ag_gap` gains the ending event's `ts` and each gap's driving model.
  - Its read phase then builds every skill table. It uses the one `_ag_xp` thresholds list.
  - Its swap writes those tables beside `agent_progress`.
  - It already runs last, after every Claude table has committed.

### 4.1 Tables

| Table | Key | Columns |
|---|---|---|
| `claude_model_rollups` | (day, model) | `active_ms` INTEGER, `updated_at` |
| `skill_daily` | (source, kind, key, day) | `active_ms` INTEGER |
| `skill_progress` | (source, kind, key) | `active_s`, `xp`, `level`, `tier`, `xp_into_level`, `xp_to_next`, `s_to_next`, `stars`, `first_day`, `last_day`, `updated_at` |
| `skill_level_ups` | (source, kind, key, level) | `day` |
| `skill_pace` | (source) | `as_of_day`, `xp_today`, `xp_7d`, `xp_28d`, `pace_xp_per_day` REAL, `eta_next_days`, `eta_99_days`, `streak_current`, `streak_best` |

- **`source`** is `claude`, `codex` or `hermes`. `skill_pace` also has one `all` row, covering
  every tool together.
- **`kind`** is `tool`, `project` or `model`.
- **`key`:**
  - for `tool`, the source itself;
  - for `project`, the `project_key`, so `(unfiled)` and `(excluded)` are real keys;
  - for `model`, the model name, `(no model)` or `(several models)`.
- **Units:** `skill_daily` stores milliseconds, so Claude's `active_ms` carries over exactly.
  Agent seconds are stored ×1000. Lifetime `active_s` = `SUM(active_ms) / 1000`, by integer
  division. That is the rule `agent_progress` already uses for Claude.

### 4.2 Hours per sub-skill (`skill_daily`)

**Tool rows:**
- Claude: `claude_daily_rollups.active_ms` per day.
- Codex and Hermes: `agent_daily_rollups.active_s × 1000`, summed over projects per day.

**Project rows:**
- Claude: `claude_project_rollups.active_ms` per (project_key, day).
- Codex and Hermes: `agent_daily_rollups.active_s × 1000` per (project_key, day).

**Model rows:**
- Claude: `claude_model_rollups.active_ms` per (model, day).
- Codex and Hermes: `_ag_gap`'s seconds × 1000, summed per (source, model, day).

Model rows include time in excluded projects, as the tool row does.

**The identity.** For every source and day:
- the `model` rows sum to the `tool` row;
- the `project` rows sum to the `tool` row.

A test and the live proof both check it.

### 4.3 The driving model of a gap

Each counted gap is credited to exactly one model.

**Claude**, in section 1's `_gap`:

1. **Main-thread requests count:** `claude_requests` with `is_sidechain = 0` and a non-NULL
   `model` other than `<synthetic>`.
2. **The gap's model** is that of the session's main-thread request with the greatest `ts` at
   or before the `ts` of the event that **ends** the gap. Ties go to the greater `request_id`.
   A request in the same second as the event counts as before it, so a turn's Stop credits the
   model that answered.
3. **If none exists yet,** the gap takes the model of the session's earliest main-thread
   request (least `ts`, then least `request_id`), the model that answered first.
4. **If the session has no main-thread request at all,** the gap takes `claude_sessions.model`.
   - Any trailing `[…]` is removed, so `claude-opus-5[1m]` becomes `claude-opus-5`.
   - NULL, `''` and `unknown` count as absent.
5. **Otherwise** the gap goes to `(no model)`.

`claude_model_rollups` sums `_gap.active_s × 1000` per (model, day), where the day is the one
`_sx` gives the session. That is exactly how `claude_daily_rollups` books the session, so
per day the model rows sum to `claude_daily_rollups.active_ms`.

The attribution must not use a correlated subquery per event. Events and main-thread requests
are merged into one stream per session, ordered by `ts` with requests before events at equal
`ts`. A running window then carries the latest request.

**Codex**, in `_ag_gap`:
- The same rule, steps 1–3 and 5, over `wt_requests` (source `codex`, non-NULL `model`) by
  canonical session.
- `codex-auto-review` is a reviewer and never counts as the driving model. Codex records no
  subagent flag (§3), so that is the only exclusion.
- Time is booked to the day `_ag_gap` uses: the local day of the event that ends the gap.

**Hermes**, in `_ag_gap`:
- Every gap of a session goes to the session's one distinct non-NULL model in `wt_requests`.
- If the session has two or more models, its gaps go to `(several models)`.
- If it has none, they go to `(no model)`.

### 4.4 Levels (`skill_progress`)

Stage 5's `_ag_prog` becomes one keyed pipeline over every (source, kind, key). It reads the
lifetime seconds from `skill_daily`.
- **XP** = `active_s × 13,034,431 / 9,000,000`, by integer division.
- **The level, tier, `xp_into_level`, `xp_to_next`, `s_to_next` and `stars`** come from
  `_ag_xp`. That is the only thresholds list; there is never a second copy.
- **`first_day` / `last_day`** are the first and last days with `active_ms > 0`.
- **A key with `active_s = 0` gets no row.** The page shows no level for it, never Lv 1.

`agent_progress` keeps its columns. It is written from the `kind = 'tool'` rows, which carry the
same lifetime seconds Stage 5 reads, so its values do not move.

### 4.5 Level-ups (`skill_level_ups`)

- For each (source, kind, key), take cumulative `active_ms` by day in ascending order.
- At the end of each day, XP = `(cum_ms / 1000) × 13,034,431 / 9,000,000`, by integer division.
- Level L (2 ≤ L ≤ the current level) was **reached on** the first day whose end-of-day XP is
  at least `xp(L)`.
- Several levels can share one day. Level 1 is never logged.
- The last day's XP equals `skill_progress.xp`, so the log ends at the current level.

### 4.6 Pace and streaks (`skill_pace`)

- **`as_of_day`** is the local day of the rollup run. A day counts as **active** for a tool
  when its `tool` row has `active_ms > 0`. For `all`, a day is active when any tool's row is.
- **`xp_today` / `xp_7d` / `xp_28d`** are the XP of the active seconds summed over D, D−6..D
  and D−27..D, where D = `as_of_day`. The XP rule is §4.4's, applied to the window's seconds.
  The `all` row sums the three tools' XP.
- **`pace_xp_per_day`** = `xp_28d / 28.0`. Zero-activity days count, because this is per
  calendar day.
- **`eta_next_days`** = `CEIL(xp_to_next / pace)`, and **`eta_99_days`** =
  `CEIL((13,034,431 − xp) / pace)`. Both are tool rows only.
  - Both are **NULL when the pace is 0**, and both are NULL at 99.
  - `eta_next_days` is also NULL when there is no level yet.
  - The `all` row has no ETAs.
- **`streak_current`:**
  - with D active, the length of the run of consecutive active days ending at D;
  - otherwise, with D−1 active, the run ending at D−1 (a streak survives a today that has no
    activity yet);
  - otherwise 0.
- **`streak_best`** is the longest run ever.
- **"Days"** are local calendar days, as everywhere else.

## 5. The page — `/character`

`lib/read/character.ts` and `lib/render/character.ts` are wired through `lib/views.ts` into
`watchtower serve` and `watchtower report`.
- **Placement:** `ranged: false`, and **Character** joins `TOOLS` after Overview.
- **What it computes:** display arithmetic only. That means a meter's percent from two stored
  columns, stored seconds shown as hours, stored day counts shown as a date, and display names
  derived from keys the way Projects derives them.

1. **Character card:**
   - Total level (as on the Overview: the sum of the tools' levels);
   - XP today and over 7 days, from `skill_pace` `all`;
   - the 28-day pace;
   - the current and best streak.
2. **Skills grid:** one tile per tool with a level, styled as an OSRS skills tab. Each tile
   shows Lv N/99, the tier, an XP meter, and stars past 99. The Total level sits in the footer.
   A tile links to its tool's section.
3. **A section per tool:**
   - **Pace:** XP today, 7d and 28d; "next level in N days" and "99 by ⟨date⟩", each captioned
     "at your 28-day pace". With no pace: "no pace in the last 28 days".
   - **Streak:** current and best.
   - **Projects:** a table of skill, Lv, tier, XP (OSRS style), XP to next, hours, first day and
     last day, sorted by level, then XP. `(unfiled)` is shown. `(excluded)` is hidden at read
     time, and a caption says excluded time still counts toward the tool.
   - **Models:** the same columns, with `(no model)` and `(several models)` rows when present.
4. **Level-up log:** the newest level-ups across every skill. Each row gives the day, the
   skill path (e.g. "Codex › project › TheOneOS"), the new level, and "→ ⟨tier⟩" when the tier
   changed.
   - Served, it shows up to 300 rows.
   - The report shows the 30 newest, with a note naming the full count.

**Links in.** Each Overview level card links to its tool's section on Character: the route
(`/character#⟨source⟩`) when served, and the in-file anchor when in the report.

**Empty states:**
- **No `skill_progress` table** (installed rollup still v7): the existing "Level pending"
  wording, naming the v8 rollup.
- **A tool not installed:** no tile and no section.
- **A tool with no driven hours:** "No driven hours yet."
- **No sub-skills of a kind:** "No ⟨projects|models⟩ with driven hours yet."
- **No level-ups:** "No level-ups yet."
- **Never:** "Lv 1", "0 XP", a 0-day ETA, or a date for an ETA that is NULL.

**Report.** The page is unranged, so it renders once. Sub-skill tables are cut to
`REPORT_ROWS` with the usual note. `tests/report-budget.test.ts` gains a `/character`
per-week pin, measured on the `density-N` fixture with agent rows seeded, as Stage 5's fix
round did.

## 6. Tests and proof

### 6.1 Guards

Each guard is planted and must turn **exactly one** test red. The plant and the test it
reddened are recorded.

| # | What it guards | Plant |
|---|---|---|
| 1 | Model rows sum to the tool row per day, for all three tools, including a session with no model at all | Inner-join gaps to a model, so a model-less session loses its time |
| 2 | The driving-model rule, on a fixture session: a gap before the first reply, Opus, then `/model` to Sonnet, with a Haiku sidechain call between. Exact seconds per model. | (a) Let sidechain requests drive. (b) Drop the "first main-thread model" fallback. |
| 3 | A session with no main-thread request books to `claude_sessions.model`, `[1m]` removed | Keep the suffix |
| 4 | `codex-auto-review` never earns time | Remove the exclusion |
| 5 | A multi-model Hermes session goes to `(several models)` | Pick the session's first model |
| 6 | Project rows equal `claude_project_rollups` / `agent_daily_rollups` | Read `window_ms` for Claude |
| 7 | `skill_progress`'s tool rows equal `agent_progress` column for column, and `agent_progress` keeps its Stage 5 values, on a fixture with excluded time | Build Claude's tool rows from the project rows without `(excluded)` |
| 8 | Level-up days from known daily times, including a day whose end-of-day XP equals `xp(L)` exactly (58 s = 83 XP = `xp(2)`). Lv 1 is never logged. | Require XP strictly greater than `xp(L)` |
| 9 | Pace per calendar day, and NULL ETAs at zero pace | Divide by active days |
| 10 | A streak survives a today with no activity yet and breaks after an idle day | Require D to be active |

Also pinned:
- the read phases hold no write lock (`tests/profile-rollup.test.ts`'s lock shape);
- `MIN(gap, 300)` stays at 4 copies and `MIN(gap, 14400)` at 3;
- no thresholds, pace or streak math, and no `MIN(gap,`, under `lib/`;
- both schema versions are 8;
- the empty states of §5;
- `/character`'s budget pin.

### 6.2 Live proof (by hand, on `.backup` copies, each in its own directory)

1. For every day and tool, the model rows and the project rows each sum to the tool row: 0
   mismatching rows.
2. Claude's existing tables and `agent_progress` are identical, apart from `updated_at`, to
   `main`'s rollup on one snapshot. The comparison query runs with `-bail`, and empty output
   counts as a failure.
3. `(no model)` for Claude is about 2.4 h, not 46.3 h.
4. One tool's level-up day is recomputed by hand from cumulative daily sums.
5. The rollup is timed before and after: under 1 s added.
6. Record the live report's size, and the top sub-skills per tool for `SESSION.md`.

## 7. Rollout

Watchtower only:
1. Merge.
2. The user runs `install.sh` (v8).
3. `watchtower sync` or the next session's rollup fills the tables. Until then, Character reads
   "Level pending".

TheOneOS reads only `agent_progress`, which does not change.

## 8. Task shape

About five tasks, subagent-driven with the user's lighter review: no per-task gates, one final
whole-branch review, and at most one fix wave.
1. Section 1: `_gap`, Claude's model attribution and `claude_model_rollups` (guards 1–3 for
   Claude).
2. The agent section: model attribution in `_ag_gap`, `skill_daily`, the keyed level pipeline,
   level-ups, pace and streaks (guard 1 for the agents, guards 4–10).
3. `lib/read/character.ts`.
4. `lib/render/character.ts`, the nav, the report, the Overview links and the budget pin.
5. The live proof, `SESSION.md` and `CLAUDE.md`.

## 9. Not in this stage

- Achievements and quests (piece 2), and character attributes (piece 3).
- Anything in TheOneOS.
- Model "generation time" as a skill, and splitting a gap across models by request share.
- Cross-tool project skills.
- Ranges on Character, and a level-up feed outside Character.
- Removing `agent_progress` or `claude_rank_progress`.

## 10. Review focus

1. **A session whose first gap ends before any reply.** Its time goes to the first model that
   answered, never to the session model or `(no model)` while a main-thread request exists.
2. **Ties.** A request and an event in the same second: the request counts as before the event.
3. **A day with time and no model.** The `(no model)` row appears, and the identity still
   holds.
4. **A model key that only ever ran as a subagent.** It has no row; it never shows Lv 1.
5. **The rollup on a v7 database.** It adds the v8 tables without touching v7 data. A reader on
   a v7 DB shows "Level pending", never an error page.
