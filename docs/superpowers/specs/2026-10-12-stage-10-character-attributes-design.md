# Stage 10 — Character attributes: six D&D stats trained by hours and form, and level caps past 99

**Status:** chat design approved 2026-10-12 (all three sections); this written spec awaits review.
**Branch:** `stage-10-attributes`, to be cut from `main` @ `b373683` (Stage 8, #22). Stage 9 stays
reserved for installer onboarding, opt-in launchd sync and the TUI launcher
(`2026-09-15-sync-trigger-and-surfaces-design.md` §6).
**Builds on:** the Usage Profile (`2026-09-25-stage-4a-usage-profile-design.md`): its ten
disciplines and their per-window pipeline. Also Stage 6's keyed level pipeline (`_sk_daily`,
`_sk_life`, `_sk_prog`, `_sk_ups`) and Stage 8's quests (`claude_quests`) and as-of day.
This is piece 3 of the "MMORPG stats" request (Stage 6 = skills, Stage 8 = quests and
achievements).

## 1. Purpose and success

Levels say how long you have used each tool, and quests push one habit a week. Nothing yet
gives the player a character sheet: a few stats that say what kind of operator you are and
whether you are in form right now. This stage adds **six attributes**, Strength, Dexterity,
Constitution, Intelligence, Wisdom and Charisma, to the Character page. It also lets levels
pass 99, through **level caps** that rise as stats reach them.

Each attribute has three parts:
- **Base**: a level earned with attribute XP. Each day, your hours train it in proportion
  to that day's 30-day Form.
- **Form**: a score from 0 to 99 for how well you work right now, from the discipline scores
  (or, for STR, output per active hour). It is measured over 30 days and over the last 7.
- **Now**: Base plus a boost or a drain for this week against your month, as in OSRS's
  "78/77".

**Every figure is measured.** A Form with no reading is NULL and shows "no reading", never 0.
A stat that has trained nothing has no level and never shows "Lv 1". Every formula, anchor,
cap and tier lives in `rollup.sh`. The page only reads, parses and labels.

Success:
- Each attribute's Base comes from its XP through the existing curve. Its XP is the sum of
  its daily training, and no day trains more than that day's hours.
- Now equals `MAX(1, Base + boost)`. The boost is NULL, and Now equals Base, whenever either
  Form has no reading.
- Levels continue past 99 at 250 hours a level, up to 200. A cap opens on the day the first
  stat reaches the cap below it.
- **No existing number moves on live data.** On the same snapshot as `main`'s rollup, every
  table that exists today is identical, `updated_at` aside. The only exceptions are the new
  `attribute` rows in `skill_*` and the new `skill_pace` column. That covers
  `agent_progress`, `claude_discipline_scores`, `claude_quests`, `achievement_tiers`,
  `character_points` and the Total level.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | **An attribute is all three:** current form, earned growth, and base plus a current buff. Base is earned and Form is current. Now is Base plus a buff or drain. |
| 2 | **The D&D six:** STR, DEX, CON, INT, WIS, CHA. |
| 3 | **Base is attribute XP.** Hours × that day's 30-day Form / 99 feed the existing curve. |
| 4 | **The buff is this week against your month:** the 7-day Form against the 30-day Form. |
| 5 | **Levels pass 99 through global caps 99 → 120 → 150 → 170 → 200.** The first stat of any kind to reach the current cap raises it that day. |
| 6 | **Past 99, every level costs 250 hours.** Level 99+n is reached at exactly 2,500 + 250n hours. |
| 7 | **Approach 1:** extend the existing pipelines. Score the disciplines over 7 days as well, route attribute XP through `_sk_daily`, and extend the curve and the tiers. The rejected options were a second XP curve (2) and noisy one-day weekly data (3). |
| 8 | **One character sheet for the player.** Tools are skills. STR pools every tool; the other five read Claude's disciplines. |
| 9 | **Tier names past Master:** 120–149 Grandmaster, 150–169 Legend, 170–199 Mythic, 200 Eternal. Master now covers 99–119. |
| 10 | **STR's full marks are 120,000 output tokens per active hour** (2,000 a minute). |
| 11 | **The 7-day scores are computed for the as-of day only** (the chat design's tests-and-rollout section), because the boost is the only thing that reads them. |
| 12 | **Attributes are not in the Total level**, the same as QP, AP and Skill use. They have no pace, no streak, no achievements and no quests of their own. |

### Attributes and their sources

| Attribute | Form source (each discipline is 0–60) | Trains on |
|---|---|---|
| STR Strength | output tokens per active hour, all tools pooled | every tool's hours |
| DEX Dexterity | automation, reuse | Claude's hours |
| CON Constitution | session-hygiene, output-quality | Claude's hours |
| INT Intelligence | context-hygiene, cost-discipline | Claude's hours |
| WIS Wisdom | verification, model-routing, security | Claude's hours |
| CHA Charisma | prompt-hygiene | Claude's hours |

Every discipline belongs to exactly one attribute. The mapping lives in `rollup.sh`
(`_at_def`) and nowhere else.

## 3. Measured on 2026-10-11/12 (the live DB, read-only)

| Fact | Value |
|---|---|
| Claude | Lv 78 at 330 h, 2,170 h short of 99, 3.89 h a day: nothing reaches 99 before about April 2028 |
| Discipline scores, latest day | automation 60, context 60, cost 0, model-routing 57, output-quality 60, prompt 60, reuse 39, security 59, session 52, verification 30 |
| Output per active hour | Claude 82k–98k, Codex 25k–70k, Hermes 6k–47k |
| Estimated attributes | STR Lv 77 (290 h trained), Form 30d 58 and 7d 63, so Now 78/77. DEX Lv 78, Form 82, 325 h. CON Lv 77, Form 92, 301 h. CHA Lv 77, Form 99, 294 h. WIS Lv 76, Form 80, 264 h. INT Lv 69, Form 50, 138 h (cost-discipline is 0). |
| `wt_tools` | Claude rows only, so Codex and Hermes have no tool calls; neither has disciplines |
| Rollup time | about 4.4 s; this stage may add at most 1 s |

## 4. Derivations (`capture/rollup.sh`)

`CC_SCHEMA_VERSION` goes from 10 to 11, in `capture/lib.sh` and `lib/config.ts`. All three new
tables are declared in `capture/lib.sh`, and the new `skill_pace` column is added through
`cc_added_columns`. Every intermediate table is built in its section's read transaction
(`BEGIN DEFERRED`). Only the swaps run under `BEGIN IMMEDIATE`.

### 4.0 Where each part runs

- **The profile section:** the 7-day discipline scores for the as-of day (§4.2), built after
  `_pf_scores` and before the read phase's `COMMIT`. Its swap writes
  `claude_discipline_scores_7d`.
- **The agent section**, in this order:
  - Right after `_sk_daily` is created, insert the attribute training rows (§4.4).
  - Build `_sk_life`, `_sk_prog` and `_sk_ups` as today. They now include the attribute rows
    and the curve to 200 (§4.6).
  - Build `level_caps` from `_sk_ups` (§4.7).
  - Build pace, including `eta_cap_days` (§4.8).
  - Build `character_attributes` (§4.5).
  - The swap writes `character_attributes`, `level_caps` and the `skill_*` tables.
  - The profile section commits before the agent section starts, so `claude_discipline_scores`
    and `claude_discipline_scores_7d` are always current when they are read.

### 4.1 Tables

| Table | Key | Columns |
|---|---|---|
| `claude_discipline_scores_7d` (regenerable) | (day, discipline) | `day` TEXT (the as-of day only), `discipline` TEXT, `score` INTEGER 0–60 (0 when `needs-data`, as in the 30-day table), `status` TEXT (the same rules as `claude_discipline_scores`). It holds 10 rows, or none when the as-of day's 7-day window is gated. |
| `character_attributes` (regenerable) | `attribute` | `attribute` TEXT (`str`, `dex`, `con`, `int`, `wis`, `cha`), `ord` INTEGER 1–6, `as_of_day` TEXT, `form_30` INTEGER (0–99, NULL with no reading), `form_7` INTEGER (likewise), `boost` INTEGER (−10…10, NULL when either Form is NULL), `base_level` INTEGER (NULL with no XP), `now_level` INTEGER (NULL with no XP), `evidence_json` TEXT |
| `level_caps` (regenerable) | `cap` | `cap` INTEGER, `reached_level` INTEGER (the level that opened it; NULL for 99), `opened_day` TEXT (NULL for 99), `source`, `kind`, `key` TEXT (the stat that opened it; NULL for 99). The row for 99 always exists. |
| `skill_pace` (existing) | — | gains `eta_cap_days` INTEGER (§4.8) |

`evidence_json`:
- For the five Claude attributes: the constituent disciplines' 30-day scores on the as-of day,
  e.g. `{"context-hygiene":60,"cost-discipline":0}`. A `needs-data` constituent is JSON
  `null`. The page matches quests to an attribute through these keys, so the mapping is
  never copied into TypeScript.
- For STR: `{"per_hour_30":85000,"per_hour_7":92000}` as integers, `null` when unmeasured.

### 4.2 The 7-day discipline scores (profile section)

The pipeline that scores the ten disciplines (`_pf_dw` → `_pf_wtool` … `_pf_wcost` →
`_pf_in` → `_pf_parts` → `_pf_ev` → scores) is parameterized by window and keyed by
(`win`, `day`).
- `win = '30'` is today's path, unchanged, over every day.
- `win = '7'` adds one row, for the as-of day.
  - Its gate is the same: at least 20 requests, counted in the 7-day window (`_pf_agg`,
    `win = '7'`).
  - Its coverage flags (`tool_covered`, `event_covered`) are checked against
    `date(day, '-6 day')`, the 7-day window's first day.
  - Its Matrix factors (`f_context`, `f_compaction`, `f_session_length`, `f_efficiency`)
    come from `_pf_matrix` at `win = '7'`, which already exists, not from `_pf_profile`.
  - Its formulas are identical to the 30-day path's: the same parts, mean, scale and status.

`claude_discipline_scores` is written from the `'30'` rows exactly as today.
`claude_discipline_scores_7d` is written from the `'7'` row. The 7-day path must filter to the
as-of day *before* the range joins, so it costs one window, not one per day of history.

**Accepted window sensitivity.** Several parts are counts: slash-command kinds, models used,
headless runs and subagent launches, MCP calls, MCP servers, compactions and the most
repeated command. Over 7 days these can read lower than over 30. This is accepted rather
than corrected:
- most of these parts reach full marks at small counts (5 slash-command kinds, 5 runs,
  40 MCP calls, 4 servers, 5 compactions);
- a quiet week is a real "this week" signal;
- the boost is clamped to ±10.

The live proof records each discipline's 7-day and 30-day scores side by side (§6.2).

### 4.3 Form

For a window `w` (`30` or `7`) and a day `d`:

- **The five Claude attributes:** take the attribute's constituent rows for `d` (from
  `claude_discipline_scores` for `30`, `claude_discipline_scores_7d` for `7`), excluding
  `status = 'needs-data'`.
  `form = CAST(round(AVG(score) * 99.0 / 60) AS INTEGER)`. With no measured constituent, or
  no rows for `d` (a gated day), the Form is NULL.
- **STR:** over the window's days (`[d−29, d]` or `[d−6, d]`):
  - tokens = Claude's `tokens_out` from `claude_daily_rollups`, plus Codex's and Hermes's from
    their **driven** sessions only (amended at the final review: their hours are driven-only by
    decision 3, so a rate over them counts driven output only; `agent_daily_rollups` still
    counts every session's tokens);
  - active ms = every tool's `kind = 'tool'` rows in `_sk_daily`;
  - with under 3,600,000 active ms (one hour), the Form is NULL;
  - otherwise `form = CAST(round(99 * MIN(1.0, rate / 120000.0)) AS INTEGER)`, where
    `rate = tokens * 3600000.0 / active_ms`.

The 30-day Form is computed for every day of history, for training (§4.4). The 7-day Form is
computed for the as-of day only.

### 4.4 Training (Base)

For each attribute and each day `d` whose 30-day Form is not NULL:
`train_ms = hours_ms(d) * form_30(d) / 99`, using integer division.
- For the five Claude attributes, `hours_ms` is Claude's `kind = 'tool'` row in `_sk_daily`
  for `d`.
- For STR, `hours_ms` is the sum of every source's `kind = 'tool'` rows for `d`.

Each row is inserted into `_sk_daily` as (`'character'`, `'attribute'`, key, `d`,
`train_ms`), but only when `train_ms > 0`. A day with no Form trains nothing. From there,
Stage 6's keyed pipeline gives each attribute its XP, level, tier, meter, stars and dated
level-ups unchanged. `_sk_life` already sums every kind other than `tool` from `_sk_daily`.

### 4.5 Boost and Now (`character_attributes`, as-of day only)

- `boost = CAST(round((form_7 − form_30) / 5.0) AS INTEGER)`, clamped to −10…10. It is NULL
  when either Form is NULL: no reading means no boost, never a drain. SQLite's `round` rounds
  halves away from zero, so a difference of −12.5 gives −3.
- `base_level` is the attribute's level from `_sk_prog`, and NULL with no XP.
- `now_level = MAX(1, base_level + COALESCE(boost, 0))`, and NULL when `base_level` is NULL.
  Now may exceed the current cap, as a boosted OSRS stat does.
- `form_30` is the as-of day's value. Without a row for that day (it is gated), it is NULL.

### 4.6 The curve past 99, tiers and stars

- `_ag_xp` gains levels 100–200:
  `xp(99+n) = (9000000 + 900000*n) * 13034431 / 9000000` (integer division). Since XP is
  `active_s * 13034431 / 9000000`, level 99+n is reached at exactly 9,000,000 + 900,000n
  seconds, which is 2,500 + 250n hours. Level 200 is 27,750 hours.
- `_ag_tier` gains four tiers: `≥200 Eternal`, `≥170 Mythic`, `≥150 Legend`,
  `≥120 Grandmaster`, with `≥99 Master` below them. The tiers below 99 do not change.
- **Stars** count past 200: `(active_s − 99900000) / 900000` once `active_s ≥ 99900000`,
  else 0. One star is still one 250-hour level.
- `xp_to_next` and `s_to_next` are NULL only at 200. `eta_next_days` therefore runs until 200.
- **`eta_99_days` keeps its meaning:** it is NULL once XP ≥ xp(99), because otherwise it
  would turn negative past 99. Its other cases do not change.
- The 'seasoned' achievement thresholds (50/70/90/99) do not change.

### 4.7 Level caps (`level_caps`)

`_lc_def` is a `VALUES` table of (cap, next): (99, 120), (120, 150), (150, 170), (170, 200).
- The row for 99 always exists.
- Each `next` opens on the first day any `_sk_ups` row of any kind reaches level `cap`.
  Ties on a day are broken by `kind = 'tool'` first, then `source`, `kind` and `key` in
  ascending order. That row's day and stat are stored.
- A stat that reaches `cap` has passed every lower cap, so the caps open in order. Levels are
  never held at a cap. The cap is a milestone and a display ceiling, not a limit, so nothing
  waits at one.
- The current cap is `MAX(cap)`. Max Cape's threshold is `MIN(cap)`, which is 99.

### 4.8 Pace to the cap

`skill_pace.eta_cap_days` is the number of days to reach xp(current cap) at the 28-day pace,
rounded up the same way as `eta_99_days`. It is NULL for `'all'`, with no pace, with no
level, or at 200. The page's "99 by <date>" becomes "Lv <cap> by <date>", which today still
reads 99.

### 4.9 What stays out

Attribute rows are source `character`, kind `attribute`. These tables already read only
`kind = 'tool'`, so attributes never reach them:
- `_ag_life`, so `agent_progress` and the Total level;
- `_sk_win` and `_sk_runs`, so pace and streaks;
- `_sk_pace`.

`_ac_*` names its kinds explicitly, so attributes never reach achievements either. Quests do
not change.

## 5. The page

Everything stays on `/character`, which is unranged and in the report. Every number shown is
one that `rollup.sh` stored.

**The Attributes card** is a new wide card between the Character hero card and the Skills
card. Its title row reads "Attributes · level cap N". It holds six tiles in `ord` order. They
have the skill tiles' look, and each has:
- the abbreviation and name, e.g. "STR Strength";
- **Now/Base**:
  - "78/77 ▲1" in green when boosted;
  - "66/69 ▼3" in red when drained;
  - Base alone, with no arrow, when the boost is 0 or NULL;
- the tier and the XP meter to the next level, from `skill_progress`;
- **Form**: "form 63 · 58 (7d · 30d)". A NULL side reads "no reading", never 0;
- **Sources**:
  - for the Claude attributes, the constituent disciplines with their 30-day scores (from
    `evidence_json`), linked to `/profile`, with labels from `lib/read/profile.ts`;
  - for STR, "output per active hour, every tool", with its 30-day rate.

**The lowest-Form footer** names the attribute with the lowest measured 30-day Form (ties go
by `ord`). It lists this week's quests (`claude_quests` at its latest `week`) whose
discipline is a key of that attribute's `evidence_json`, linked to `/quests`. When STR is the
lowest, or no quest matches, it names the attribute only.

**Level caps across the dashboard:**
- Every skill tile and level card shows "Lv X/{current cap}" in place of "/99". This includes
  Overview's level displays.
- The stars label reads "past 200".
- The hero card shows "level cap N".
- The pace kv reads "Lv {cap} by <date>", from `eta_cap_days`.
- **Max Cape** stays "every tool at 99+". It compares each tool's level with `MIN(cap)` from
  `level_caps`, not with `xpToNext === null` (`lib/read/level.ts`).

**The level-up log:**
- Attribute level-ups appear as "Strength · Lv 78".
- A cap raise is its own row: "Level cap raised to 120 · Claude reached Lv 99". `level_caps`
  rows with an `opened_day` are added to the log by date.
- The log's `LEVEL_UP_CAP` bounds it as today.

**The readers.** `readCharacter` groups `skill_progress` rows by tool source, and **skips
source `character`**, so attributes never get a tool section. The attributes reader joins
`character_attributes` to `skill_progress` (source `character`). It reads `level_caps` for
the current cap and Max Cape's threshold.

**States:**
- **Before the first v11 rollup** (no `character_attributes` or `level_caps` table):
  - the card reads "Attributes are pending until the v11 rollup";
  - tiles show "Lv X" with no "/cap";
  - Max Cape falls back to "pending";
  - the page never errors.
- **A stat with no XP**: "No attribute XP yet." It is never "Lv 1".
- **No reading**: covered under Form above.

**The report** includes the card. It is a fixed six tiles, so its bytes do not grow with
history, and `character`'s `PER_WEEK_LIMIT` in `tests/report-budget.test.ts` stays 50.

## 6. Tests and proof

### 6.1 Guards

Each guard is planted and must turn **exactly one** test red. The plant and the test it
reddened are recorded in the ledger. Following R21, each guard's literal values live in that
one test only. The rollup guards go in a new `tests/attributes-rollup.test.ts`, seeded
through `tests/helpers/agent-seed.ts` with `WATCHTOWER_ROLLUP_TODAY` pinned.

| # | What it guards | Plant | The one test |
|---|---|---|---|
| 1 | A `needs-data` constituent is left out of Form, not counted as 0 | Count it as 0 | "needs-data is left out of Form" |
| 2 | Each day trains at its own 30-day Form | Use the as-of day's Form for every day | "each day trains at that day's Form" |
| 3 | STR is NULL with under 1 active hour in its window | Drop the gate | "Strength needs an active hour" |
| 4 | The boost is clamped to ±10 | Drop the clamp | "the boost is clamped to ten" |
| 5 | A gated 7-day window gives no boost, never a drain | `COALESCE(form_7, 0)` | "no 7-day reading means no boost" |
| 6 | Level 99+n is reached at exactly 2,500 + 250n hours | Use `900000*(n−1)` | "past 99 each level is 250 hours" |
| 7 | 120 is Grandmaster | `≥ 121` | "tiers past Master" |
| 8 | Stars count from 200 | Count from 99 (the old rule) | "stars start past 200" |
| 9 | `eta_99_days` is NULL at 99 and past it | Drop the guard | "the 99 ETA stops at 99" |
| 10 | A cap opens only when a stat reaches the cap below it, on that day | Open at `cap − 1` | "a cap opens on the day a stat reaches it" |
| 11 | Attributes stay out of pace and streaks | Let `_sk_win` read kind `attribute` | "attributes have no pace" |
| 12 | Attributes get no tool section on `/character` | Drop the `character` filter in `readCharacter` | "attributes get no tool section" |
| 13 | An unmeasured Form renders "no reading" | `?? 0` in the renderer | "an unmeasured form reads no reading" |
| 14 | Cap raises appear in the level-up log | Drop the union | "the log shows a cap raise" |

**Identities**, asserted on the same fixtures with no literal values:
- each attribute's `skill_progress.active_s` equals the sum of its training rows / 1000;
- on every day, each attribute's training ms is at most its hours ms;
- `now_level = MAX(1, base_level + COALESCE(boost, 0))` whenever `base_level` is not NULL;
- each opened cap's `opened_day` equals the first `skill_level_ups` day at its `reached_level`;
- every discipline maps to exactly one attribute.

That attributes leave `agent_progress` and the Total level untouched is proved on live data
(§6.2 step 1), where `main`'s rollup is the "without".

**Also pinned:**
- both schema versions are 11;
- the read phases hold no write lock (the shape `tests/profile-rollup.test.ts` pins);
- a rollup on a v10 database adds the v11 tables and column without touching v10 data;
- the page shows stored values: change a stored Form or cap and the rendered page follows;
- no Form anchor (`120000`), cap list or curve constant under `lib/`, and no `MIN(gap,`;
- `tests/agent-rollup.test.ts`'s recomputation of the curve now covers 1–200;
- every state in §5.

### 6.2 Live proof (by hand, on `.backup` copies, each in its own directory)

`main/` runs `main`'s `rollup.sh` and `lib.sh` (from `git show`), and `branch/` runs the
branch's. Both run on copies of one snapshot with the same `WATCHTOWER_ROLLUP_TODAY`.

1. **Nothing that exists moves.** Every Stage 8 proof table is compared whole with `EXCEPT`
   both ways under `-bail`, `updated_at` aside. `skill_*` is compared `WHERE kind <>
   'attribute'`, and `skill_pace` on its v10 columns. Every count must be `0|0`.
2. **The identities** of §6.1 on live data: 0 mismatches.
3. **By hand:**
   - one attribute's 30-day Form on one day, from `claude_discipline_scores`;
   - STR's 30-day rate, from `claude_daily_rollups` and the driven sessions' `wt_requests`;
   - one day's training ms;
   - each discipline's 7-day score beside its 30-day score on the as-of day (the window
     sensitivity of §4.2).
4. **TheOneOS:** `tests/fixtures/theone-level-proof.mjs` and `theone-watch-proof.mjs --all`
   pass on `branch/`.
5. **Recorded for `SESSION.md`:** the six attributes (Form 30/7, boost, Base, Now, tier), the
   `level_caps` rows (only 99 today), and the rollup time.
6. **Budgets:**
   - the rollup is timed on both copies, median of 3 runs, with under 1 s added;
   - the report stays under 2,000,000 bytes and renders the card;
   - its text has no `NaN` and no fabricated 0.

## 7. Rollout

Watchtower only:
1. Merge.
2. The user runs `install.sh` (v11). I hand over the exact `!` command.
3. `watchtower sync`, or the next session's rollup, fills the tables. Until then the card
   reads "pending until the v11 rollup".

**TheOneOS** reads `agent_progress` for Claude (`lib/claude-hours/hours.ts`). Its values do not
change, so it needs no change and no lockstep proof beyond §6.2 steps 1 and 4. Its
`types.ts` describes `xpToNext` as "null at 99", which becomes "null at 200". Nothing reaches
99 before about April 2028, so that comment is a follow-up, not part of this stage.

## 8. Task shape

Four tasks, subagent-driven with the user's lighter review: no per-task gates, one final
whole-branch review on the most capable model, and at most one fix wave.
1. **Schema and the profile section.** Schema v11 (three tables, the column, both version
   declarations), the window-parameterized pipeline and `claude_discipline_scores_7d`.
   Guard 5, with its gated 7-day fixture.
2. **The agent section:**
   - `_at_def`, Form, the training rows, the curve to 200, tiers, stars and `eta_99_days`;
   - `level_caps`, `eta_cap_days` and `character_attributes`.

   Guards 1–4 and 6–11.
3. **The page:**
   - the attributes reader and the Attributes card;
   - the `character` filter in `readCharacter`;
   - "/cap", the hero cap, the pace label, Max Cape and "past 200";
   - the level-up log rows and every state.

   Guards 12–14.
4. **Proof and docs:** the live proof, `SESSION.md` and `CLAUDE.md` (the new tables, schema 11,
   attribute rows in `skill_*`, levels to 200).

## 9. Not in this stage

- Attributes for Codex or Hermes on their own; they share STR only.
- Quests, achievements, pace or streaks for attributes.
- Attributes in the Total level, or on Overview beyond "/cap".
- Correcting the 7-day window's count-based parts (§4.2).
- A boost for any day but the as-of day, or a history of Form.
- Any change to `/profile`, `/quests` or TheOneOS.

## 10. Review focus

1. **NULL against 0.** NULL must survive through Form, boost and Base, and must never render
   as 0 or "Lv 1". A gated day trains nothing, rather than training at Form 0.
2. **Integer arithmetic.** Training uses integer division per day, before `_sk_life` sums it.
   The curve past 99 lands each level on an exact hour.
3. **The 7-day cost.** The `'7'` row is filtered to the as-of day before any range join.
4. **The as-of day.** The 7-day window, the boost and the quest week come from `_pf_asof` and
   `_sk_today`, never from `date('now')`.
5. **Past 99.** `eta_99_days` never goes negative, `xp_to_next` is NULL only at 200, and Max
   Cape no longer relies on `xpToNext === null`.
6. **A reader on a v10 database.** It shows "Pending", never an error page.
