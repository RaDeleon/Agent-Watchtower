# Stage 7 — Skill XP: Claude Code skills and packs level like sub-skills

**Status:** chat design approved 2026-10-07 (data, page, tests). This written spec is awaiting
review.
**Branch:** `stage-7-skill-xp`, cut from `main` @ `5e5ce96` (Stage 6, #20).
**Builds on:** `2026-10-03-stage-6-character-skills-design.md`. Its keyed level pipeline
(§4.4–4.5) and its driving-model stream (§4.3) are reused, and the curve is the same.
**Order:** split out of piece 2 on 2026-10-07 and built first. Achievements and quests
(`2026-10-07-stage-8-quests-achievements-brainstorm.md`, paused at its design section 1)
resume after this ships, and can then award skill milestones.

## 1. Purpose and success

The user asked whether Claude Code skills (gstack, superpowers and the like) should earn
XP: each skill its own, and skill use as a whole its own. Stage 6 levels each tool's projects and models; nothing levels from Claude Code
skills. This stage adds three things to the Character page:
- each **skill** you load (`superpowers:brainstorming`, `health`, …) as a sub-skill with its
  own level;
- each **pack** (`superpowers`, `gstack`, `document-skills`, …) levelling from its skills' time;
- **Skill use**, one level for all skill time together, as its own tile.

**Every figure is measured.** A skill earns the time spent in the turns that loaded it, which
Claude Code records on every request. Nothing is inferred across turns.

Success:
- Per day, the skill rows sum exactly to the Skill use row, the pack rows sum exactly to it
  too, and Skill use never exceeds Claude's time.
- No existing number moves. Every Stage 6 table, every `claude_*` rollup, `agent_progress` and
  the Total level are identical to `main`'s rollup on the same snapshot, except for
  `updated_at`.
- A skill's pack, once resolved, never changes, even if the pack is uninstalled.
- The page never shows "Lv 1", "0 XP" or a skill level for time that was not measured.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | **Its own stage, first.** Skill XP ships as Stage 7; achievements and quests become Stage 8. |
| 2 | **Skill use is its own tile, not in Total.** A Skill use tile sits in the Skills grid beside Claude, Codex and Hermes. Its time is a slice of Claude's, so it stays out of the Total level and nothing on Overview moves. |
| 3 | **Skills and packs both level.** Each skill levels, each pack levels from its skills' time, and skills outside any pack go to `(no pack)`. |
| 4 | **A skill earns the time in the turns that loaded it** (approach A). Each counted gap goes to the skill on the main-thread request at or before the event that ends it, by Stage 6's driving-model stream. An untagged gap goes to no skill. Not "sticky until replaced" (B), not use counts (C). |
| 5 | **The same curve for every skill:** Stage 5 §4.4's XP rule, thresholds, tiers and stars. XP is measured hours. |
| 6 | **Claude only.** Codex and Hermes record no skills. |
| 7 | **No pace or streaks for Skill use.** `skill_pace` stays keyed by tool. |
| 8 | **Skill and pack level-ups enter the level-up log**, as projects and models do. |

## 3. Measured on 2026-10-07 (the live DB, read-only)

| Fact | Value |
|---|---|
| Requests with `attribution_skill` | 6,037 of 37,321, from 2026-06-12 to 2026-10-07 |
| Main-thread requests (non-NULL model, not `<synthetic>`) with a skill | 3,967 of 28,673 (13.8%) |
| Distinct skills | 42; 41 have main-thread requests. One, `code-review`, ran only under subagents and gets no row. |
| Sessions with a tagged main-thread request | 102; 97 have hook events. The other 5 have no gaps, so no time, as in Claude's own hours. |
| How long a tag lasts | Until the end of the turn that loaded the skill. Traced on one session: after a prompt, 1 untagged request (the one that loads the skill), then 10 tagged `superpowers:brainstorming`; the next prompt's 2 requests are untagged. A second load in the same turn replaces the tag (10 untagged, then `superpowers:writing-plans` × 12, then `superpowers:subagent-driven-development` × 7). |
| Skills named `pack:name` | Every one's prefix equals its `attribution_plugin` (0 mismatches). `superpowers` has 7 skills, `openviking-memory` 2, `document-skills`, `commit-commands` and `engineering` 1 each. |
| Bare skill names (no plugin) | 30. 53 entries under `~/.claude/skills/` are gstack skills, each a folder whose `SKILL.md` is a symlink into `~/.claude/skills/gstack/<name>/`; 4 of the tagged names are among them (`make-pdf`, `context-restore`, `gstack-upgrade`, `health`). 9 are plain folders (`ai-image-gen`, `seo-audit`, `graphify`, …). The other 17 are on no disk path: Claude Code's built-ins (`claude-api`, `init`, `run`, `update-config`, `artifact-design`, …) and a few installed elsewhere or removed (`browserclaw`, `multica-*`). |
| Top main-thread skills by requests | `superpowers:executing-plans` 659, `superpowers:writing-plans` 633, `superpowers:brainstorming` 540, `superpowers:systematic-debugging` 311, `browserclaw` 202, `superpowers:subagent-driven-development` 195 |

## 4. Derivations (`capture/rollup.sh`)

`CC_SCHEMA_VERSION` goes from 8 to 9, in `capture/lib.sh` and `lib/config.ts`. Both new tables
are declared in `capture/lib.sh`. Every intermediate is built in its section's read
transaction (`BEGIN DEFERRED`); only the swaps run under `BEGIN IMMEDIATE`.

### 4.0 Where each part runs

- **Before section 1, in bash:** pack resolution (§4.3) fills the durable
  `claude_skill_packs` for any skill name it has not seen, as `claude_project_paths` is filled
  for new `cwd`s.
- **Section 1 (daily rollups):**
  - `_evm` carries a second column, the skill of the same request it already finds (§4.2).
  - `_gap` gains `skill`.
  - The section's swap writes `claude_skill_rollups` beside `claude_model_rollups`.
- **The agent section:** `_sk_daily` gains the `skill`, `pack` and `skill-use` rows (§4.4).
  Everything after it is generic and unchanged.

### 4.1 Tables

| Table | Kind | Key | Columns |
|---|---|---|---|
| `claude_skill_rollups` | regenerable | (day, skill) | `active_ms` INTEGER, `updated_at` |
| `claude_skill_packs` | **durable** | (skill) | `pack` TEXT NOT NULL, `via` TEXT NOT NULL (`plugin`, `link` or `none`), `resolved_at` INTEGER |

`skill_daily`, `skill_progress` and `skill_level_ups` keep their columns. Their `kind` gains
three values, all under `source = 'claude'`:

| `kind` | `key` |
|---|---|
| `skill` | the skill name as recorded, e.g. `superpowers:brainstorming`, `health` |
| `pack` | the pack, e.g. `superpowers`, `gstack`, or `(no pack)` |
| `skill-use` | `all` (one row) |

### 4.2 A gap's skill

`_evm` merges events and main-thread requests per session and carries, for each event, the
latest main-thread request at or before it (Stage 6 §4.3, steps 1–2: `is_sidechain = 0`,
non-NULL `model` other than `<synthetic>`, requests before events at equal `ts`, ties to the
greater `request_id`). It gains one column: that request's `NULLIF(attribution_skill, '')`,
taken by the same `FIRST_VALUE` over the same window.

- **`_gap.skill`** is `_evm`'s skill for the event that ends the gap, or NULL.
- **There is no fallback.** An event with no request before it (no `_evm` row) has no skill.
  `_sfm`'s first-request and recorded-model fallbacks are for models only: a session's first
  turn is not skill time because a later turn loaded one.
- **What a turn credits.** Every gap ending inside a turn after the skill loaded, and the gap
  that ends at your next prompt (reading that turn's answer, think time capped at 300 s as
  always). The first gap ending after the next prompt's first request does not.
- **`claude_skill_rollups`** sums `_gap.active_s × 1000` per (day, skill) for non-NULL skills,
  with `HAVING SUM(active_s) > 0`. The day is `_sx`'s day for the session, the session's
  **start** day, exactly as `claude_model_rollups` and `claude_daily_rollups` book it. So per
  day the skill rows sum to at most `claude_daily_rollups.active_ms`.
- Time in excluded projects is included, as it is in the model rows. Skills carry no project.

### 4.3 A skill's pack (`claude_skill_packs`)

Run once per rollup, before section 1, over every distinct non-empty `attribution_skill` in
`claude_requests` not already in the table. Each name is resolved by the first rule that
applies:

1. **`plugin`:** the name contains `:`. The pack is the text before the first `:`
   (`superpowers:brainstorming` → `superpowers`). The filesystem is never read.
2. **`link`:** the name is a safe path segment (`^[A-Za-z0-9][A-Za-z0-9._-]*$`), the file
   `$SK/<name>/SKILL.md` exists, and its fully resolved path (every symlink followed) lies
   under the fully resolved `$SK` as `<pack>/…` with `<pack>` ≠ `<name>`. The pack is
   `<pack>` (`health` → `$SK/gstack/health/SKILL.md` → `gstack`). A pack's own router skill
   joins its pack: if `$SK/<name>/SKILL.md` is a plain file and some `$SK/<name>/<sub>/SKILL.md`
   has a top-level symlink `$SK/<sub>/SKILL.md` resolving to it, `<name>` is the pack
   (`gstack` → `gstack`).
   `$SK` is `${CLAUDE_DIR:-$HOME/.claude}/skills`.
3. **`none`:** otherwise, `(no pack)`. That covers skills installed one at a time, Claude
   Code's built-ins, skills that resolve outside `$SK`, unsafe names, and anything no longer on
   disk.

Rows are written with `INSERT OR IGNORE` through `lib.sh`'s encoders and are never updated or
deleted: **the first answer is kept forever**, like `claude_project_paths`. Uninstalling gstack
leaves its skills in `gstack`. A skill first seen before its pack was installed stays in
`(no pack)`; this is accepted, as it is for project paths.

Resolution is best-effort, like the project-path resolution beside it. A missing `$SK`, an
unreadable link or a failed insert leaves names unresolved, and `_sk_daily` counts an
unresolved skill under `(no pack)` (§4.4). It never fails the rollup.

### 4.4 Levels

The agent section's `_sk_daily` gains three `UNION ALL` branches, all from
`claude_skill_rollups`, which section 1 committed:

- `('claude', 'skill', skill, day, active_ms)`, one per row;
- `('claude', 'pack', COALESCE(p.pack, '(no pack)'), day, SUM(active_ms))`, through a
  `LEFT JOIN claude_skill_packs p ON p.skill = r.skill`, grouped by pack and day;
- `('claude', 'skill-use', 'all', day, SUM(active_ms))`, grouped by day.

From there, nothing changes:
- `_sk_life`, `_sk_prog`, `_sk_progress` and `_sk_ups` are generic over `(source, kind, key)`,
  so the new rows get levels, tiers, stars and level-up days by Stage 6's rules.
- `_ag_life`, `_ag_prog`, `_sk_win`, `_sk_runs` and `_sk_pace` read only `kind = 'tool'`, so
  `agent_progress`, `skill_pace` and the `all` pace are untouched, and Skill use has no pace.
- The Total level is the sum of `agent_progress`'s levels and does not move.

**The identities.** For every day:
- the `skill` rows sum to the `skill-use` row;
- the `pack` rows sum to the `skill-use` row;
- the `skill-use` row is at most Claude's `tool` row.

## 5. The page — `/character`

`lib/read/character.ts` and `lib/render/character.ts`, served and in the report, as in Stage 6.
Display arithmetic only.

1. **Skills grid:** a **Skill use** tile after the tools, only when its row has a level, in the
   same style (Lv N/99, tier, meter, stars). It links to `#character-skill-use`. When the tile
   is shown, the card's footer gains one line under Total level: *"Skill use is time already in
   Claude's level, so it is not in Total."*
2. **A Skill use section** after Claude's section, anchored `character-skill-use` in both the
   served page and the report:
   - the level block (level, XP, hours, XP to next), with no pace block;
   - one line on what is counted: *"Time in the turns that loaded a skill. Your next prompt ends
     that turn, so a skill guiding a long conversation is credited for the turn that loaded
     it."*;
   - **Skill use · packs:** Stage 6's sub-skill table (skill, Lv, tier, XP, XP to next, hours,
     first, last), with `(no pack)` shown when present;
   - **Skill use · skills:** the same table plus a **Pack** column, read from
     `claude_skill_packs` (`(no pack)` for an unresolved skill).
   - In the report, both tables are cut to `REPORT_ROWS` with the usual note.
3. **Level-up log:** the new kinds appear like the others. Their paths read
   `Claude › pack › gstack`, `Claude › skill › superpowers:brainstorming`, and `Skill use` for
   the `skill-use` row. The served log stays capped at 300 rows and the report at 30.

**Empty states:**
- **No `claude_skill_packs` table** (installed rollup still v8): no tile; the section reads
  "Level pending" in Stage 6's wording, naming the v9 rollup.
- **v9, but no `skill-use` row:** no tile; the section is one line, *"No skill time yet."*
- **No skills or packs of a kind:** "No ⟨packs|skills⟩ with time yet."
- **Never:** "Lv 1", "0 XP", or a Skill use number inside the Total level.

**Report.** `tests/report-budget.test.ts`'s `/character` per-week pin is re-measured on the
`density-N` fixture, which gains skill-tagged main-thread requests at live-like per-day
cardinality.

## 6. Tests and proof

### 6.1 Guards

Each guard is planted and must turn **exactly one** test red. The plant and the test it
reddened are recorded. The shared stream's own rules (sidechain filter, request-before-event
order, ties) are already guarded by Stage 6's guard 2 and are not re-planted here.

| # | What it guards | Plant | The one test |
|---|---|---|---|
| 1 | A turn after the skill's turn earns it nothing. Fixture: prompt 1, a Skill load, tagged requests, Stop; prompt 2, untagged requests, Stop. Exact seconds to the skill, including the think gap ending at prompt 2. | Carry the last non-NULL tag forward | "a turn after the skill's turn earns it nothing" |
| 2 | Skill rows book to the session's start day, on a session crossing local midnight | Book to the gap's end day | "skill rows book to the session's start day" |
| 3 | A gstack-style skill resolves through its link: a fixture `$SK` with `pack/x/SKILL.md` and `x/SKILL.md` → `../pack/x/SKILL.md` | Skip rule 2 | "a linked skill resolves to its pack" |
| 4 | A plugin skill resolves to the text before its colon | Take the text after it | "a plugin skill resolves to its plugin" |
| 5 | A resolved pack survives its pack's removal: roll up, delete the fixture pack, roll up again | Clear `claude_skill_packs` at the start of each run | "an uninstalled pack keeps its history" |
| 6 | Per day, packs and skills each sum to Skill use, with a `(no pack)` skill and an unresolved one present | Inner-join the pack rows to the map | "packs and skills each sum to Skill use, every day" |
| 7 | `agent_progress` and the Total level are identical with and without skill tags on the same fixture | Add `claude_skill_rollups`' time to Claude's `_ag_life` row | "skill time never moves agent_progress or Total" |
| 8 | A name that is not a safe path segment never reaches the filesystem: `../pack/x` stays `(no pack)` | Drop the segment check | "an unsafe skill name resolves to (no pack)" |

Also pinned:
- `MIN(gap, 300)` stays at 4 copies and `MIN(gap, 14400)` at 3;
- no thresholds, XP or level math, and no `MIN(gap,`, under `lib/`;
- both schema versions are 9;
- the read phases hold no write lock (`tests/profile-rollup.test.ts`'s lock shape), with `_evm`'s
  new column still in section 1's read phase;
- a rollup on a v8 database adds the v9 tables without touching v8 data;
- the render: the tile only with a level, the footer line only with the tile, the Pack column,
  the level-up paths, and every empty state of §5;
- `/character`'s budget pin.

### 6.2 Live proof (by hand, on `.backup` copies, each in its own directory)

`main/` runs `main`'s `rollup.sh` and `lib.sh` (from `git show`), `branch/` the branch's, both on
copies of one snapshot.

1. **Nothing that exists moves:** every Stage 6 proof table (`claude_daily_rollups`,
   `claude_project_rollups`, `claude_rank_progress`, `claude_profile_daily`,
   `claude_discipline_scores`, `claude_prices`, `claude_request_metrics`, `claude_turns`,
   `agent_prices`, `agent_request_metrics`, `agent_daily_rollups`, `agent_progress`), plus
   `claude_model_rollups`, and the `skill_daily`, `skill_progress` and `skill_level_ups` rows of
   kinds `tool`, `project` and `model`, and all of `skill_pace`. Compared with `EXCEPT` both
   ways under `-bail`, `updated_at` aside; every count `0|0`.
2. **The identities** of §4.4 on live data: 0 mismatching days.
3. **One skill by hand:** one tagged session's skill seconds recomputed from its events and
   requests, and one skill's level-up day from its cumulative daily sums.
4. **Recorded for `SESSION.md`:** Skill use hours and level; the top packs and skills (level,
   hours); `claude_skill_packs` counts by `via`; which names resolved to `gstack`; the
   `(no pack)` list.
5. **Budgets:** the rollup timed on both copies, under 1 s added; the report under 2,000,000
   bytes, with the Skill use section rendering and no `Lv 1`, `0 XP` or `NaN` in its text.

## 7. Rollout

Watchtower only:
1. Merge.
2. The user runs `install.sh` (v9).
3. `watchtower sync`, or the next session's rollup, fills the tables. Until then the Skill use
   section reads "Level pending".

TheOneOS reads none of the new tables and no existing number changes, so it needs no change
and no lockstep proof beyond §6.2 step 1.

## 8. Task shape

About five tasks, subagent-driven with the user's lighter review: no per-task gates, one final
whole-branch review on the most capable model, at most one fix wave.
1. Schema v9 (both tables, both version declarations) and pack resolution (guards 3, 4, 5, 8).
2. Section 1: `_evm`'s skill column, `_gap.skill` and `claude_skill_rollups` (guards 1, 2).
3. The agent section: the three `_sk_daily` branches (guards 6, 7).
4. `lib/read/character.ts` and `lib/render/character.ts`: the tile, the section, the
   level-up paths, the empty states and the budget pin.
5. The live proof, `SESSION.md` and `CLAUDE.md` (the new tables, the durable list, schema 9).

## 9. Not in this stage

- Achievements and quests (Stage 8), including skill milestones, and character attributes.
- Pace, ETAs and streaks for Skill use, skills or packs.
- Skills for Codex or Hermes.
- Use counts as XP, or crediting a skill across later turns.
- MCP servers as sub-skills (`attribution_mcp_server` is recorded; a later stage could level it
  the same way).
- Any change to `/skills` ("Models & Skills"), Overview or TheOneOS.

## 10. Review focus

1. **The think gap after a skill's turn.** It ends at the next `UserPromptSubmit`, whose latest
   request is still the tagged one, so it credits the skill. A gap that ends after the next
   turn's first request credits nothing.
2. **An event before a session's first request.** No `_evm` row, so no skill, never the
   session's first tagged skill.
3. **A skill that only ever ran under subagents.** It has no row and never shows Lv 1.
4. **A machine with no `~/.claude/skills`.** Every bare name resolves to `(no pack)`, quietly;
   the rollup still exits 0.
5. **A skill name with quotes or a slash.** Encoded through `lib.sh`'s encoders; a slash never
   reaches the filesystem.
6. **A reader on a v8 database.** "Level pending", never an error page.
