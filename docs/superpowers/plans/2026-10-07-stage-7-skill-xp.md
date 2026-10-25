# Stage 7 — Skill XP: Claude Code skills and packs level as sub-skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude Code skill you load (`superpowers:brainstorming`, `health`, …), every
pack (`superpowers`, `gstack`, …) and all skill time together level on the Character page, from
the time spent in the turns that loaded each skill.

**Architecture:**
- `capture/rollup.sh` does all the math, and no existing number moves.
  - Before section 1, bash resolves each new skill name to a pack, once, into the durable
    `claude_skill_packs`.
  - Section 1's `_evm` carries the skill of the request it already finds for each event, `_gap`
    gains `skill`, and the write phase fills `claude_skill_rollups` beside
    `claude_model_rollups`.
  - The agent section's `_sk_daily` gains `skill`, `pack` and `skill-use` rows. Everything
    after it is generic.
- `lib/read/character.ts` reads them into `CharacterData.skillUse`;
  `lib/render/character.ts` draws a Skill use tile, a Skill use section and the new level-up
  paths.

**Tech stack:** bash, the `sqlite3` CLI (window functions), Node ≥ 22 with native type
stripping, vitest. **Zero runtime dependencies.**

**Spec (binding):** `docs/superpowers/specs/2026-10-07-stage-7-skill-xp-design.md`, approved
2026-10-07 (commit `7c0850f`).
- Copy every table, column, rule and empty-state string from the spec or from this plan; do
  not re-derive them.
- The spec's §2 decisions are settled and must not be re-asked.

**Branch:** `stage-7-skill-xp`, cut from `main` @ `5e5ce96`. Watchtower only; TheOneOS is
untouched.

**Ledger:** `.superpowers/sdd/2026-10-07-stage-7-skill-xp/`, with `progress.md` and a
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

- **R1 — pack resolution is `_resolve_new_skills`, called right after `_resolve_new_cwds`.**
  It has no per-run cap: there are 42 live names, and the steady state is one `SELECT`
  returning nothing.
- **R2 — tests never read the live `~/.claude/skills`.**
  - `tests/helpers/fixture-db.ts` passes `CLAUDE_DIR` set to `NO_CLAUDE_DIR`, a path that is
    never created, in `buildAndRoll`, `rerollup` (so `roll`) and `ingestAndRoll`.
  - A test that needs skills passes its own `CLAUDE_DIR` from `tests/helpers/skills-home.ts`.
  - Tests that run the installed rollup through `runSync` still inherit the process's `HOME`.
    They read the live skills directory read-only, and resolve their `fx-*` names to
    `(no pack)`. That is accepted.
- **R3 — level-up paths use `AGENT_LABEL`:**
  - `Claude Code › skill › superpowers:brainstorming` and `Claude Code › pack › gstack`, as
    Stage 6 writes `Codex › project › TheOneOS`. The spec's "Claude › …" is shorthand for this.
  - The `skill-use` row reads `Skill use`.
- **R4 — guard 5 asserts equality across two runs, not a literal pack.**
  - Guard 3's test owns `fx-linked → fxpack` (R21).
  - `claude_skill_packs` joins the durable-tables list in `tests/capture-scripts.test.ts`.
    So plant 5 is **re-resolution** (drop the `NOT IN` filter and use `INSERT OR REPLACE`),
    not an unscoped `DELETE`, which would also redden that static check.
- **R5 — guard 6's unresolved skill comes from a `BEFORE INSERT` trigger** that
  `RAISE(IGNORE)`s one name. It is the one way a name stays out of the map while resolution
  runs normally.
- **R6 — guard 2's test also owns the "Skill use ≤ Claude, per day" identity.**
  - Booking skill time to the gap's end day is exactly what breaks that identity.
  - So guard 6's test checks only "skills sum to Skill use" and "packs sum to Skill use".
    Each plant then reddens one test.
- **R7 — the density fixture tags its `j = 2` request instead of `j = 0`.**
  - `j = 2` is the latest main-thread request before each session's Stop, so its gap credits
    the skill.
  - At `j = 0`, no gap ever ended on a tagged request, so the fixture held no skill time and
    `/character`'s budget pin would measure nothing.
  - Only `tests/report-budget.test.ts` reads `density-N`.
- **R8 — Skill use is pending when `claude_skill_packs` is absent** (a v8 database). With the
  table present and no `skill-use` row, it reads "No skill time yet."
- **R9 — a skill's Pack column comes from `claude_skill_packs` at read time.** An unresolved
  skill shows `(no pack)`, matching the rollup's `COALESCE`.
- **R10 — the fixture's subagent-tagged requests (`sk_sc`, `k2_u*`) never sit where a
  sidechain request could take a gap**, even under Stage 6's "let sidechain requests drive"
  plant. That plant must keep reddening only Stage 6's guard 2 test (Stage 6 R21).

## Global Constraints

- **All math lives in `capture/rollup.sh`.** `lib/` reads, filters, sorts and labels. Its only
  arithmetic: a meter's percent, seconds ÷ 3600, and a stored day count added to a stored
  date.
- **No `MIN(gap,` under `lib/` or in any script but `rollup.sh`.** In `rollup.sh`,
  `MIN(gap, 300)` stays at exactly **4** copies and `MIN(gap, 14400)` at exactly **3**
  (`tests/capture-scripts.test.ts`).
- **No existing number moves.**
  - Every Stage 6 table, `claude_model_rollups`, `agent_progress`, the `skill_*` rows of kinds
    `tool`, `project` and `model`, and all of `skill_pace` are identical to `main`'s rollup on
    the same snapshot, except `updated_at`.
  - The only fixture edits are the new `skill-mix` scenario, the `req_skill` helper and R7.
- **Rollup transactions:**
  - every intermediate is `CREATE TEMP TABLE _…` in a `BEGIN DEFERRED` read phase;
  - `_evm` stays in section 1's read phase (`tests/rollup-lock.test.ts`);
  - the agent section's write phase stays `DELETE` + `INSERT … SELECT … FROM _staged ORDER BY
    rowid` pairs only.
- **Schema:** `CC_SCHEMA_VERSION=9` in `capture/lib.sh` and `schemaVersion: 9` in
  `lib/config.ts`. A test pins the two together.
- **Durable:** `claude_skill_packs` is never `DROP`ped, never wholesale-`DELETE`d, never
  updated. It is written only by `INSERT OR IGNORE`.
- **The page never shows** "Lv 1", "0 XP", "NaN", or a Skill use number inside the Total level.
- **Strings, verbatim:**
  - `Skill use` (tile, section title, and the `skill-use` level-up path)
  - `Skill use · packs` / `Skill use · skills`
  - `Skill use is time already in Claude's level, so it is not in Total.`
  - `Time in the turns that loaded a skill. Your next prompt ends that turn, so a skill guiding a long conversation is credited for the turn that loaded it.`
  - `No skill time yet.`
  - `No packs with time yet.` / `No skills with time yet.`
  - `Watchtower's rollup has not run since its v9 install`
  - `(no pack)`
  - `level pending` (existing `LEVEL_PENDING`)
- **Tests:**
  - **R21:** each guard's literal values live in exactly one test. Run the **whole suite**
    under every plant, and record every test it reddened. More than one is a finding for the
    report, not something to hide by weakening a test.
  - `TZ=UTC` is pinned by the helpers.
  - Run the suite as `npx vitest run --exclude '.claude/**'`. A stray worktree under `.claude/`
    doubles a plain `npm test`.
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

1. **A skill name with a quote or a space** (`fx it's`). It is stored through `cc_sqlstr`,
   fails the safe-segment check, and resolves to `(no pack)`. Pinned in guard 8's test
   (Task 1).
2. **No skills directory at all.** Every bare name resolves to `(no pack)`, and the rollup
   exits 0. Pinned in "resolves every bare name to (no pack) with no skills directory"
   (Task 1).
3. **A second rollup over the same data.** `claude_skill_rollups` and `claude_skill_packs` do
   not change. Pinned in "a second rollup changes nothing" (Task 2).
4. **An event before a session's first request.** It has no `_evm` row, so no skill. Pinned by
   guard 1's exact seconds: the 10 s gap ending at the first prompt is in no skill (Task 2).
5. **A reader on a v8 database, and one with no skill time.** "Level pending" and "No skill
   time yet.", never an error and never "Lv 1". Pinned in "Skill use is pending on a database
   the v9 rollup has not run on", "no skill time reads as none" (Task 4) and "Skill use's
   empty states" (Task 4).

## Guard map (R21)

Each plant must turn exactly **one** test red. The task's report records the plant, every test
it reddened, and the revert.

| # | Test (`tests/skill-xp-rollup.test.ts` › name) | Plant | Task |
|---|---|---|---|
| 1 | a turn after the skill's turn earns it nothing | In `_evm`, carry the last non-NULL skill forward (step 2.3's plant SQL) | 2 |
| 2 | skill time books to the session's start day, never past Claude's | In `claude_skill_rollups`'s INSERT, `strftime('%Y-%m-%d', g.ts, 'unixepoch', 'localtime')` for `sx.day` (SELECT and GROUP BY) | 2 |
| 3 | a linked skill resolves to its pack | In `_resolve_new_skills`, replace `if [ -n "$skreal" ] &&` with `if false &&` | 1 |
| 4 | a plugin skill resolves to its plugin | `pack="${name#*:}"` for `pack="${name%%:*}"` | 1 |
| 5 | an uninstalled pack keeps its history | Drop `AND attribution_skill NOT IN (SELECT skill FROM claude_skill_packs)`, and `INSERT OR REPLACE` for `INSERT OR IGNORE` | 1 |
| 6 | packs and skills each sum to Skill use, every day | `JOIN` for `LEFT JOIN claude_skill_packs` in `_sk_daily`'s pack branch | 3 |
| 7 | skill time never moves agent_progress or Total | In `_ag_life`'s Claude row, `(COALESCE(SUM(active_ms), 0) + (SELECT COALESCE(SUM(active_ms), 0) FROM claude_skill_rollups)) / 1000` | 3 |
| 8 | an unsafe skill name resolves to (no pack) | Drop `[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] &&` | 1 |

## File map

| File | Change | Task |
|---|---|---|
| `capture/lib.sh` | `CC_SCHEMA_VERSION=9`; `claude_skill_rollups`, `claude_skill_packs`; `skill_daily`'s `kind` comment | 1 |
| `lib/config.ts` | `schemaVersion: 9` | 1 |
| `capture/rollup.sh` | `_realpath`, `_resolve_new_skills` | 1 |
| `capture/rollup.sh` | Section 1: `_evm.skill`, `_gap.skill`, the `claude_skill_rollups` swap | 2 |
| `capture/rollup.sh` | Agent section: three `_sk_daily` branches | 3 |
| `tests/fixtures/make-fixture.sh` | `req_skill`; scenario `skill-mix` | 1 |
| `tests/fixtures/make-fixture.sh` | `density-*` tags `j = 2` (R7) | 3 |
| `tests/helpers/fixture-db.ts` | `NO_CLAUDE_DIR`, passed by every helper (R2) | 1 |
| `tests/helpers/skills-home.ts` | New: a `CLAUDE_DIR` with a linked pack and a plain skill | 1 |
| `tests/skill-xp-rollup.test.ts` | New: guards 1–8, Review Focus 1–4 | 1, 2, 3 |
| `tests/capture-scripts.test.ts` | Schema v9; v8's marker reads the version; durable list | 1 |
| `tests/config.test.ts` | `schemaVersion` 9 | 1 |
| `lib/read/character.ts` | `SkillKind`, `SKILL_USE_LABEL`, `NO_PACK`, `SkillUse`, `readSkillUse` | 4 |
| `lib/render/character.ts` | `tileOf`, the Skill use tile and note, `cutTable`, `skillUseSection`, `pathOf` | 4 |
| `lib/render/empty.ts` | Five Stage 7 strings | 4 |
| `tests/read-character.test.ts` | Skill use reads | 4 |
| `tests/render-character.test.ts` | Skill use renders; `data()` gains `skillUse` | 4 |
| `tests/report-budget.test.ts` | Re-measured `/character` pin and its comment | 4 |
| `SESSION.md`, `CLAUDE.md` | Session 21; v9 tables, the durable list, the test seam | 5 |

## Fixture reference

- `BASE = 1750000000` is 2025-06-15T15:06:40Z (`make-fixture.sh`). `DAY = 86400`.
- `skill-mix` (Task 1 builds it; every Stage 7 rollup test reads it):

| Day (UTC) | Session | Claude s | Skill seconds |
|---|---|---|---|
| 2025-06-15 | `S_SK` | 300 | `superpowers:brainstorming` 240 (50 + 40 + the 150 s think gap ending at prompt 2). The 10 s gap before any request and the 50 s gap ending at prompt 2's Stop are in no skill. `fx-sub-only` ran only in a subagent. |
| 2025-06-17 | `S_SK2` | 900 | `fxplug:fx-tool` 190, `fx-linked` 200, `fx-plain` 200, `fx-unresolved` 200, `fx-builtin` 100 (890 in all). `fxpack/fx-linked`, `../fxpack/fx-linked` and `fx it's` ran only in subagents. |
| 2025-06-21 | `S_SKMID` | 1200 | `superpowers:brainstorming` 1140. It starts at 23:50 and its Stop is at 00:10 on 06-22, so all of it books to 06-21. |

- `skills-home.ts`'s `CLAUDE_DIR` resolves to these packs:

| Name | Pack | Via |
|---|---|---|
| `fxplug:fx-tool` | `fxplug` | `plugin` |
| `superpowers:brainstorming` | `superpowers` | `plugin` |
| `fx-linked` | `fxpack` | `link` |
| everything else | `(no pack)` | `none` |

- With `NO_CLAUDE_DIR`, every bare name resolves to `(no pack)`.
- XP rule: `xp = active_s × 13,034,431 / 9,000,000`, by integer division (Stage 5 §4.4).

---

## Tasks

### Task 1: Schema v9 and each skill's pack

**Files:**
- Modify: `capture/lib.sh` (line 20, and the schema heredoc after `skill_pace`, ~line 551)
- Modify: `lib/config.ts:117`
- Modify: `capture/rollup.sh` (after `_resolve_new_cwds`, ~line 242)
- Modify: `tests/fixtures/make-fixture.sh` (after `req_meta`; a new scenario before `agent-drift)`)
- Modify: `tests/helpers/fixture-db.ts`
- Create: `tests/helpers/skills-home.ts`
- Create: `tests/skill-xp-rollup.test.ts`
- Modify: `tests/capture-scripts.test.ts` (the v8 block ~line 834; `DURABLE_TABLES` ~line 866)
- Modify: `tests/config.test.ts:30`

**Interfaces:**
- Produces:
  - tables `claude_skill_rollups (day, skill, active_ms, updated_at)` (empty until Task 2) and
    `claude_skill_packs (skill, pack, via, resolved_at)`;
  - fixture helper `req_skill <request-id> <skill>`;
  - scenario `skill-mix`;
  - `NO_CLAUDE_DIR: string` from `tests/helpers/fixture-db.ts`;
  - `skillsHome(): string` from `tests/helpers/skills-home.ts`;
  - `packOf(db, skill)` inside `tests/skill-xp-rollup.test.ts`.

- [ ] **Step 1.1: Add `req_skill` and the `skill-mix` scenario**

In `tests/fixtures/make-fixture.sh`, after the `req_meta()` function:

```bash
# Stage 7: the skill Claude Code tagged a request with (claude_requests.attribution_skill),
# through lib.sh's encoder like every other value here.
req_skill() { # req_skill <request-id> <skill>
  fx_sql "UPDATE claude_requests SET attribution_skill = $(cc_sqlstr "$2") WHERE request_id = $(cc_sqlstr "$1");"
}
```

Then a new scenario, immediately before `  agent-drift)`:

```bash
  skill-mix)
    # Stage 7 (spec 4.2-4.4): skill time, one session per day so each guard reads
    # its own day. Every request is main-thread fx-model unless marked sidechain.
    # Day 0, S_SK: prompt 1 loads superpowers:brainstorming -- sk_r0, the request
    # that loads it, is untagged -- and prompt 2's turn is untagged. Claude
    # 10 + 50 + 40 + 150 + 50 = 300 s. The skill 50 + 40 + 150 = 240 s: the think
    # gap ending at prompt 2 is still the skill's; the 10 s before any request
    # and the 50 s ending at prompt 2's Stop are not. sk_sc ran in a subagent at
    # 255, after the think gap's end and before sk_r3, so no gap could end on it
    # even if sidechain requests drove (plan R10).
    sess S_SK 0
    ev  S_SK 0   SessionStart
    ev  S_SK 10  UserPromptSubmit
    req sk_r0 S_SK 20  /tmp/fx 10 0
    req sk_r1 S_SK 40  /tmp/fx 10 0
    req_skill sk_r1 superpowers:brainstorming
    ev  S_SK 60  PreToolUse
    req sk_r2 S_SK 90  /tmp/fx 10 0
    req_skill sk_r2 superpowers:brainstorming
    ev  S_SK 100 Stop
    ev  S_SK 250 UserPromptSubmit
    req sk_sc S_SK 255 /tmp/fx 10 1
    req_skill sk_sc fx-sub-only
    req sk_r3 S_SK 260 /tmp/fx 10 0
    ev  S_SK 300 Stop
    ev  S_SK 300 SessionEnd
    # Day 2, S_SK2: five turns, one skill each, for the packs (spec 4.3). Each
    # turn's work gap and the think gap after it go to its skill. Claude
    # 10 + 190 + 200 + 200 + 200 + 100 = 900 s; skills 890 s. The three names in
    # subagents exist only to be resolved (guard 8, Review Focus 1).
    sess S_SK2 $((2 * DAY))
    ev  S_SK2 $((2 * DAY))       SessionStart
    ev  S_SK2 $((2 * DAY + 10))  UserPromptSubmit
    req k2_a S_SK2 $((2 * DAY + 50))  /tmp/fx 10 0
    req_skill k2_a fxplug:fx-tool
    ev  S_SK2 $((2 * DAY + 100)) Stop
    ev  S_SK2 $((2 * DAY + 200)) UserPromptSubmit
    req k2_b S_SK2 $((2 * DAY + 250)) /tmp/fx 10 0
    req_skill k2_b fx-linked
    ev  S_SK2 $((2 * DAY + 300)) Stop
    ev  S_SK2 $((2 * DAY + 400)) UserPromptSubmit
    req k2_c S_SK2 $((2 * DAY + 450)) /tmp/fx 10 0
    req_skill k2_c fx-plain
    ev  S_SK2 $((2 * DAY + 500)) Stop
    ev  S_SK2 $((2 * DAY + 600)) UserPromptSubmit
    req k2_d S_SK2 $((2 * DAY + 650)) /tmp/fx 10 0
    req_skill k2_d fx-unresolved
    ev  S_SK2 $((2 * DAY + 700)) Stop
    ev  S_SK2 $((2 * DAY + 800)) UserPromptSubmit
    req k2_u1 S_SK2 $((2 * DAY + 805)) /tmp/fx 10 1
    req_skill k2_u1 fxpack/fx-linked
    req k2_u2 S_SK2 $((2 * DAY + 806)) /tmp/fx 10 1
    req_skill k2_u2 ../fxpack/fx-linked
    req k2_u3 S_SK2 $((2 * DAY + 807)) /tmp/fx 10 1
    req_skill k2_u3 "fx it's"
    req k2_e S_SK2 $((2 * DAY + 850)) /tmp/fx 10 0
    req_skill k2_e fx-builtin
    ev  S_SK2 $((2 * DAY + 900)) Stop
    ev  S_SK2 $((2 * DAY + 900)) SessionEnd
    # Day 6, S_SKMID: starts 23:50:00 UTC (2025-06-21), Stop at 00:10 the next
    # day. Its 1,140 s of skill time book to the START day, as the session's
    # 1,200 s do in claude_daily_rollups.
    sess S_SKMID $((6 * DAY + 31400))
    ev  S_SKMID $((6 * DAY + 31400)) SessionStart
    ev  S_SKMID $((6 * DAY + 31460)) UserPromptSubmit
    req km_r1 S_SKMID $((6 * DAY + 31500)) /tmp/fx 10 0
    req_skill km_r1 superpowers:brainstorming
    ev  S_SKMID $((6 * DAY + 32600)) Stop
    ;;
```

Check the arithmetic against the activity model before going on:
- A gap ending at `UserPromptSubmit` counts `MIN(gap, 300)`.
- A gap with a prompt since the last Stop or SessionStart counts `MIN(gap, 14400)`.
- `SessionStart` and `SessionEnd` count 0.
- So in `S_SK2`, the Stop at 900 closes 100 s (800 → 900) to `fx-builtin`. The requests at
  805–807 are sidechain, so `k2_e` (850) is the latest main-thread request at 900.

Verify the scenario builds:

Run: `d=$(mktemp -d) && bash tests/fixtures/make-fixture.sh skill-mix "$d/f.sqlite" && sqlite3 "$d/f.sqlite" "SELECT COUNT(*), COUNT(attribution_skill) FROM claude_requests"`
Expected: `14|12` (14 requests: 5 on day 0, 8 on day 2, 1 on day 6; 12 tagged)

- [ ] **Step 1.2: Make the helpers hermetic, and add the skills home**

In `tests/helpers/fixture-db.ts`, after the `MAKE` constant:

```ts
/**
 * Stage 7 (plan R2): rollup.sh reads `${CLAUDE_DIR:-$HOME/.claude}/skills` to
 * find each skill's pack. Every helper points it at a directory that is never
 * created, so no test reads the live install; a test that needs skills passes
 * its own CLAUDE_DIR (tests/helpers/skills-home.ts) in extraEnv.
 */
export const NO_CLAUDE_DIR = path.join(tmpdir(), "wt-no-claude-dir-never-created");
```

In `rerollup`, `buildAndRoll` and `ingestAndRoll`, add `CLAUDE_DIR: NO_CLAUDE_DIR` to each env
object, **before** `...extraEnv`:
- `rerollup` and `buildAndRoll`: `{ ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC", CLAUDE_DIR: NO_CLAUDE_DIR, ...extraEnv }`.
- `ingestAndRoll`: insert `CLAUDE_DIR: NO_CLAUDE_DIR,` after `TZ: "UTC",`.

Create `tests/helpers/skills-home.ts`:

```ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A CLAUDE_DIR whose skills/ holds the two install shapes spec 4.3 tells apart
 * (Stage 7): a pack that links each of its skills in, as gstack does, and a
 * skill installed on its own.
 *   skills/fxpack/fx-linked/SKILL.md      the pack's copy
 *   skills/fx-linked/SKILL.md  ->  ../fxpack/fx-linked/SKILL.md
 *   skills/fx-plain/SKILL.md              a plain folder
 */
export function skillsHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-skills-home-"));
  const sk = path.join(home, "skills");
  mkdirSync(path.join(sk, "fxpack", "fx-linked"), { recursive: true });
  writeFileSync(path.join(sk, "fxpack", "fx-linked", "SKILL.md"), "---\nname: fx-linked\n---\n");
  mkdirSync(path.join(sk, "fx-linked"));
  symlinkSync("../fxpack/fx-linked/SKILL.md", path.join(sk, "fx-linked", "SKILL.md"));
  mkdirSync(path.join(sk, "fx-plain"));
  writeFileSync(path.join(sk, "fx-plain", "SKILL.md"), "---\nname: fx-plain\n---\n");
  return home;
}
```

- [ ] **Step 1.3: Write the failing schema tests**

In `tests/capture-scripts.test.ts`:
- In the v8 block, change `expect(existsSync(path.join(dir, ".schema-v8"))).toBe(true);` to
  `expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);`.
- Rename that test to `"creates the five Character tables on a fresh DB, and stamps the current marker"`.
- After the v8 `describe`, add:

```ts
// Stage 7 (schema v9): Claude's hours by Claude Code skill (regenerable) and each
// skill's pack (durable). Tables only, so no cc_added_columns line.
const V9_TABLES = ["claude_skill_rollups", "claude_skill_packs"];

describe("schema v9", () => {
  it("creates the two skill tables on a fresh DB, and stamps .schema-v9", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v9-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V9_TABLES) expect(tablesOf(db)).toContain(table);
    expect(existsSync(path.join(dir, ".schema-v9"))).toBe(true);
  });

  it("adds them to an older database in one cc_init_db call, its rows untouched", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v9up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    for (const table of V9_TABLES) expect(tablesOf(db)).not.toContain(table);
    execFileSync("sqlite3", [db, "INSERT INTO claude_requests(request_id, ts, tokens_out) VALUES('req_v5', 1750000000, 42);"]);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V9_TABLES) expect(tablesOf(db)).toContain(table);
    expect(execFileSync("sqlite3", [db, "SELECT request_id, ts, tokens_out FROM claude_requests;"], { encoding: "utf8" }).trim())
      .toBe("req_v5|1750000000|42");
  });
});
```

- Add `"claude_skill_packs"` to `DURABLE_TABLES`.

In `tests/config.test.ts:30`: `expect(c.schemaVersion).toBe(9);`.

Run: `npx vitest run tests/capture-scripts.test.ts tests/config.test.ts`
Expected: FAIL. `schema v9` finds no tables, `config` expects 9 and gets 8, and the
version-pairing test still passes (both still 8).

- [ ] **Step 1.4: Declare the tables and bump the version**

In `capture/lib.sh`:
- line 20: `CC_SCHEMA_VERSION=9`;
- in `skill_daily`, the `kind` comment becomes
  `-- 'tool' | 'project' | 'model' | 'skill' | 'pack' | 'skill-use'`;
- after the `skill_pace` table, before the heredoc's closing `SQL`:

```sql

-- Stage 7 (schema v9): Claude Code skills as sub-skills. claude_skill_rollups is
-- regenerable, filled by section 1 of rollup.sh beside claude_model_rollups.
CREATE TABLE IF NOT EXISTS claude_skill_rollups (
  day        TEXT NOT NULL,              -- YYYY-MM-DD, local, session START day (as claude_daily_rollups)
  skill      TEXT NOT NULL,              -- attribution_skill of the main-thread request at the gap's end
  active_ms  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, skill)
);

-- DURABLE, like claude_project_paths: each skill name's pack, resolved once by
-- rollup.sh's _resolve_new_skills (spec 4.3) and never updated or deleted, so
-- uninstalling a pack moves no history.
CREATE TABLE IF NOT EXISTS claude_skill_packs (
  skill       TEXT PRIMARY KEY,
  pack        TEXT NOT NULL,             -- a plugin, a skills folder others link into, or '(no pack)'
  via         TEXT NOT NULL,             -- 'plugin' | 'link' | 'none'
  resolved_at INTEGER NOT NULL
);
```

In `lib/config.ts:117`: `schemaVersion: 9,`.

Run: `npx vitest run tests/capture-scripts.test.ts tests/config.test.ts`
Expected: PASS.

- [ ] **Step 1.5: Write the failing pack tests**

Create `tests/skill-xp-rollup.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { roll } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { skillsHome } from "./helpers/skills-home";

// Stage 7: Claude Code skills, their packs, and all skill time as sub-skills
// (spec §4). R21: each guard's literal values live in ONE test here; every
// other test over the same data asserts identities, so one planted defect reds
// one test. The plants, and every test each reddened, are in the task reports
// under .superpowers/sdd/2026-10-07-stage-7-skill-xp/.

type Row = Record<string, unknown>;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const packOf = (db: string, skill: string) =>
  rows<{ pack: string; via: string }>(db, `SELECT pack, via FROM claude_skill_packs WHERE skill = ${q(skill)}`);
const NONE = [{ pack: "(no pack)", via: "none" }];

describe("a skill's pack", () => {
  let db: string;
  beforeAll(() => { db = buildAndRoll("skill-mix", { CLAUDE_DIR: skillsHome() }); });

  // GUARD 3 (R21). gstack installs each skill as skills/<name>/SKILL.md, a link
  // into skills/gstack/<name>/. Planted: skip rule 2 (`if false &&`).
  it("a linked skill resolves to its pack", () => {
    expect(packOf(db, "fx-linked")).toEqual([{ pack: "fxpack", via: "link" }]);
  });

  // GUARD 4 (R21). Every live "pack:name" has prefix = attribution_plugin.
  // Planted: take the text after the colon.
  it("a plugin skill resolves to its plugin", () => {
    expect(packOf(db, "fxplug:fx-tool")).toEqual([{ pack: "fxplug", via: "plugin" }]);
    expect(packOf(db, "superpowers:brainstorming")).toEqual([{ pack: "superpowers", via: "plugin" }]);
  });

  // GUARD 8 (R21), and Review Focus 1: a name is a path segment or it never
  // reaches the filesystem. "fxpack/fx-linked" would resolve through a real
  // SKILL.md to fxpack without the check. Planted: drop the segment check.
  it("an unsafe skill name resolves to (no pack)", () => {
    for (const name of ["fxpack/fx-linked", "../fxpack/fx-linked", "fx it's"]) {
      expect({ name, row: packOf(db, name) }).toEqual({ name, row: NONE });
    }
  });

  it("a plain folder, a skill on no disk path and a subagent-only skill resolve to (no pack)", () => {
    for (const name of ["fx-plain", "fx-builtin", "fx-unresolved", "fx-sub-only"]) {
      expect({ name, row: packOf(db, name) }).toEqual({ name, row: NONE });
    }
  });

  // Review Focus 2. buildAndRoll's CLAUDE_DIR never exists (plan R2), and it
  // throws on a non-zero exit.
  it("resolves every bare name to (no pack) with no skills directory, and the rollup still exits 0", () => {
    const bare = buildAndRoll("skill-mix");
    for (const name of ["fx-linked", "fx-plain", "fx-builtin"]) {
      expect({ name, row: packOf(bare, name) }).toEqual({ name, row: NONE });
    }
  });

  // GUARD 5 (R21, plan R4): a resolved pack is kept forever, like a project
  // path. Equality, not a literal: guard 3's test owns fx-linked -> fxpack.
  // Planted: re-resolve every name each run (no NOT IN, INSERT OR REPLACE).
  it("an uninstalled pack keeps its history", () => {
    const home = skillsHome();
    const d = buildAndRoll("skill-mix", { CLAUDE_DIR: home });
    const all = "SELECT skill, pack, via, resolved_at FROM claude_skill_packs ORDER BY skill";
    const before = rows<Row>(d, all);
    rmSync(path.join(home, "skills"), { recursive: true, force: true });
    expect(existsSync(path.join(home, "skills"))).toBe(false);
    roll(d, { CLAUDE_DIR: home });
    expect(rows<Row>(d, all)).toEqual(before);
  });
});
```

Run: `npx vitest run tests/skill-xp-rollup.test.ts`
Expected: FAIL. Every `packOf` returns `[]`, because nothing fills `claude_skill_packs`. Guard
5's test alone passes, vacuously: it compares two empty tables.

- [ ] **Step 1.6: Resolve each new skill name to a pack**

In `capture/rollup.sh`, immediately after the line `_resolve_new_cwds`:

```bash

# ---- resolve skill -> pack, once per skill name, cached forever (Stage 7) -----
# Spec 4.3. Runs in BASH beside the cwd resolution above, for the same reason:
# following a symlink is a filesystem read SQL cannot make. Bounded by NEW
# names: the steady state is one SELECT returning nothing. Rows are INSERT OR
# IGNORE, never updated or deleted, so uninstalling a pack moves no history.
# Best-effort like the rest of this file's bash: a missing skills directory, a
# dangling link or a failed insert leaves a name at (no pack) or unresolved
# (which _sk_daily counts as (no pack)), never a failed run.
#   plugin  "pack:name"                                           -> pack
#   link    $SK/<name>/SKILL.md resolves to $SK/<pack>/.../SKILL.md,
#           <pack> <> <name>  (gstack's install shape)            -> <pack>
#   none    anything else: a plain folder, a built-in, a removed
#           skill, or a name that is not one safe path segment    -> (no pack)
_realpath() {  # every symlink followed, then the directory resolved; nothing on failure
  local p="$1" t d n=0
  while [ -L "$p" ]; do
    [ "$n" -ge 40 ] && return 1
    t="$(readlink "$p")" || return 1
    case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac
    n=$((n + 1))
  done
  d="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$d" "$(basename "$p")"
}
_resolve_new_skills() {
  local names sk skreal now name pack via real rel
  names="$(cc_sql_val "SELECT DISTINCT attribution_skill FROM claude_requests
                       WHERE attribution_skill IS NOT NULL AND attribution_skill <> ''
                         AND attribution_skill NOT IN (SELECT skill FROM claude_skill_packs)
                       ORDER BY attribution_skill;")"
  [ -z "$names" ] && return 0
  sk="${CLAUDE_DIR:-$HOME/.claude}/skills"
  skreal="$(cd "$sk" 2>/dev/null && pwd -P)"
  now="$(cc_now)"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    pack="(no pack)"; via="none"
    case "$name" in
      ?*:*) pack="${name%%:*}"; via="plugin" ;;
      *)
        if [ -n "$skreal" ] && [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -f "$sk/$name/SKILL.md" ]; then
          real="$(_realpath "$sk/$name/SKILL.md")"
          case "$real" in
            "$skreal"/*/*)
              rel="${real#"$skreal"/}"
              [ "${rel%%/*}" != "$name" ] && { pack="${rel%%/*}"; via="link"; } ;;
          esac
        fi ;;
    esac
    cc_sql "INSERT OR IGNORE INTO claude_skill_packs (skill, pack, via, resolved_at)
            VALUES ($(cc_sqlstr "$name"), $(cc_sqlstr "$pack"), $(cc_sqlstr "$via"), $now);"
  done <<EOF
$names
EOF
}
_resolve_new_skills
```

Notes for the implementer:
- `$skreal` is resolved with `pwd -P` because macOS's `tmpdir()` (`/var/folders/…`) is itself
  a symlink to `/private/var/…`. `_realpath` resolves the same way, so the prefix test compares
  like with like.
- `?*:*` needs at least one character before the colon. `:x` falls to the `*` branch, fails
  the segment check, and is `(no pack)`.

Run: `npx vitest run tests/skill-xp-rollup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 1.7: Plant guards 3, 4, 5 and 8, one at a time**

For each plant in the guard map's Task 1 rows:
1. edit `capture/rollup.sh`;
2. run `npx vitest run --exclude '.claude/**'`;
3. record every failing test;
4. revert with `git checkout capture/rollup.sh` — or re-apply the step 1.6 text if the file has
   uncommitted Task 1 changes. Simplest: commit step 1.8 first, then plant against the commit
   and `git checkout` after each.

Expected: each plant reddens exactly its guard's test. Record it in `task-1-report.md`.

- [ ] **Step 1.8: Run the suite and typecheck, then commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`
Expected: all green; typecheck clean.

```bash
git add capture/lib.sh capture/rollup.sh lib/config.ts tests/fixtures/make-fixture.sh tests/helpers/fixture-db.ts \
        tests/helpers/skills-home.ts tests/skill-xp-rollup.test.ts tests/capture-scripts.test.ts tests/config.test.ts
git commit -m "schema v9: claude_skill_rollups and the durable claude_skill_packs; each skill's pack, resolved once"
```

---

### Task 2: Section 1 — each gap's skill, and `claude_skill_rollups`

**Files:**
- Modify: `capture/rollup.sh` (`_evm` ~line 413; `_gap`'s final SELECT ~line 563; after the
  `claude_model_rollups` INSERT ~line 780)
- Modify: `tests/skill-xp-rollup.test.ts`

**Interfaces:**
- Consumes: `claude_skill_rollups` (Task 1), scenario `skill-mix`, `packOf`, `rows`, `roll`.
- Produces: `claude_skill_rollups` rows `(day, skill, active_ms, updated_at)`, one per (start
  day, skill) with time, no NULL skill.

- [ ] **Step 2.1: Write the failing tests**

Append to `tests/skill-xp-rollup.test.ts`:

```ts
/** (day, skill seconds, Claude seconds) where a day's skill time passes Claude's own. */
const overClaude = (db: string) => rows<Row>(db, `
  SELECT s.day, s.ms, r.active_ms FROM (SELECT day, SUM(active_ms) AS ms FROM claude_skill_rollups GROUP BY day) s
  LEFT JOIN claude_daily_rollups r USING (day) WHERE r.active_ms IS NULL OR s.ms > r.active_ms`);

describe("hours by skill", () => {
  // GUARD 1 (R21), and Review Focus 4. The tag lasts until the next prompt
  // (spec §3): the turn that loaded the skill, and the think gap ending at the
  // next prompt, are the skill's; the next turn is not; the 10 s before the
  // session's first request is no skill's. fx-sub-only ran only in a subagent
  // and has no row (the sidechain filter itself is Stage 6's guard 2).
  // Planted: carry the last non-NULL skill forward in _evm.
  it("a turn after the skill's turn earns it nothing", () => {
    const db = buildAndRoll("skill-mix");
    expect(rows(db, "SELECT skill, active_ms FROM claude_skill_rollups WHERE day = '2025-06-15'"))
      .toEqual([{ skill: "superpowers:brainstorming", active_ms: 240000 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM claude_skill_rollups WHERE skill = 'fx-sub-only'")).toEqual([{ n: 0 }]);
  });

  // GUARD 2 (R21, plan R6): booked to the session's START day through _sx, as
  // claude_model_rollups and claude_daily_rollups are, so a day's skill time
  // never exceeds Claude's. Planted: book to the gap's end day.
  it("skill time books to the session's start day, never past Claude's", () => {
    const db = buildAndRoll("skill-mix");
    expect(rows(db, "SELECT day, skill, active_ms FROM claude_skill_rollups WHERE day >= '2025-06-20' ORDER BY day, skill"))
      .toEqual([{ day: "2025-06-21", skill: "superpowers:brainstorming", active_ms: 1140000 }]);
    for (const d of [db, buildAndRoll("live")]) {
      expect(rows<{ n: number }>(d, "SELECT COUNT(*) AS n FROM claude_skill_rollups")[0].n).toBeGreaterThan(0);
      expect(overClaude(d)).toEqual([]);
    }
  });

  // Review Focus 3.
  it("a second rollup changes nothing", () => {
    const db = buildAndRoll("skill-mix");
    const read = () => [
      rows<Row>(db, "SELECT day, skill, active_ms FROM claude_skill_rollups ORDER BY day, skill"),
      rows<Row>(db, "SELECT skill, pack, via, resolved_at FROM claude_skill_packs ORDER BY skill"),
    ];
    const before = read();
    roll(db);
    expect(read()).toEqual(before);
  });
});
```

Run: `npx vitest run tests/skill-xp-rollup.test.ts -t "hours by skill"`
Expected: FAIL. The first two get `[]` and the `COUNT … > 0` check fails; the third passes
vacuously, which is fine.

- [ ] **Step 2.2: Carry the skill in `_evm`, `_gap` and the swap**

In `capture/rollup.sh`'s `_evm`, replace the CTE body with:

```sql
CREATE TEMP TABLE _evm AS
WITH st AS (
  SELECT session_id, ts, 1 AS k, id AS tb, id AS eid, NULL AS model, NULL AS skill
  FROM claude_events
  WHERE session_id IS NOT NULL AND hook_event_name NOT IN ('LauncherStart','LauncherEnd')
  UNION ALL
  SELECT session_id, ts, 0, request_id, NULL, model, NULLIF(attribution_skill, '')
  FROM claude_requests
  WHERE session_id IS NOT NULL AND is_sidechain = 0 AND model IS NOT NULL AND model <> '<synthetic>'
), g AS (
  SELECT st.*, SUM(1 - k) OVER (PARTITION BY session_id ORDER BY ts, k, tb
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
  FROM st
), m AS (
  SELECT eid, k, grp,
         FIRST_VALUE(model) OVER (PARTITION BY session_id, grp ORDER BY ts, k, tb) AS model,
         -- Stage 7 (spec 4.2): the same request's skill. Claude Code clears the
         -- tag at the next prompt, so this is the skill of the turn in flight.
         FIRST_VALUE(skill) OVER (PARTITION BY session_id, grp ORDER BY ts, k, tb) AS skill
  FROM g
)
SELECT eid AS id, model, skill FROM m WHERE k = 1 AND grp > 0;
```

Add one line to `_evm`'s header comment: `-- Stage 7: it also carries that request's skill (attribution_skill), NULL when untagged.`

In `_gap`'s final SELECT, after `COALESCE(m.model, f.model, '(no model)') AS model`, add:

```sql
,
       -- Stage 7 (spec 4.2): the skill on that same request, or NULL. No _sfm
       -- fallback: a turn that loaded no skill is not skill time.
       m.skill AS skill
```

That is, the line becomes `COALESCE(m.model, f.model, '(no model)') AS model,` followed by the
comment and `m.skill AS skill`.

After the `claude_model_rollups` INSERT (its `HAVING SUM(g.active_s) > 0;`), add:

```sql

-- Stage 7 (spec 4.2): Claude's hours by Claude Code skill, booked exactly as the
-- model rows are -- to the session's START day, through _sx -- so per day they
-- never exceed claude_daily_rollups.active_ms. An untagged gap is in no row.
DELETE FROM claude_skill_rollups;
INSERT INTO claude_skill_rollups (day, skill, active_ms, updated_at)
SELECT sx.day, g.skill, CAST(SUM(g.active_s) * 1000 AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM _gap g JOIN _sx sx ON sx.session_id = g.session_id
WHERE g.skill IS NOT NULL
GROUP BY sx.day, g.skill
HAVING SUM(g.active_s) > 0;
```

Run: `npx vitest run tests/skill-xp-rollup.test.ts`
Expected: PASS (9 tests).

Then run `npx vitest run tests/rollup-lock.test.ts tests/capture-scripts.test.ts tests/skill-rollup.test.ts`.
Expected: PASS. `_evm` stays in the read phase, the gap-rule copy counts do not move, and
Stage 6's model numbers are unchanged.

- [ ] **Step 2.3: Plant guards 1 and 2, one at a time**

Commit first (step 2.4), then plant against the commit and `git checkout capture/rollup.sh`
after each.

**Plant 1** (carry the last non-NULL skill forward). In `_evm`:
1. Add a CTE between `g` and `m`:
   ```sql
   , sg AS (
     SELECT g.*, SUM(CASE WHEN k = 0 AND skill IS NOT NULL THEN 1 ELSE 0 END)
                   OVER (PARTITION BY session_id ORDER BY ts, k, tb ROWS UNBOUNDED PRECEDING) AS sgrp
     FROM g
   )
   ```
2. Make `m` read `FROM sg`.
3. Make its skill column `FIRST_VALUE(skill) OVER (PARTITION BY session_id, sgrp ORDER BY ts, k, tb) AS skill`.

Expected: only guard 1's test reddens (`240000` → `290000`).

**Plant 2** (book to the end day). In the `claude_skill_rollups` INSERT, replace `sx.day` in
the SELECT and the GROUP BY with `strftime('%Y-%m-%d', g.ts, 'unixepoch', 'localtime')`.
Expected: only guard 2's test reddens.

Run the whole suite under each plant: `npx vitest run --exclude '.claude/**'`. Record every
failing test in `task-2-report.md`.

- [ ] **Step 2.4: Run the suite and typecheck, then commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`
Expected: all green.

```bash
git add capture/rollup.sh tests/skill-xp-rollup.test.ts
git commit -m "rollup: credit each gap to the skill of the turn in flight; claude_skill_rollups"
```

---

### Task 3: The agent section — skills, packs and Skill use as sub-skills

**Files:**
- Modify: `capture/rollup.sh` (`_sk_daily`, ~line 2057)
- Modify: `tests/fixtures/make-fixture.sh` (`density-*`, the `claude_requests` INSERT's
  `attribution_skill` CASE)
- Modify: `tests/skill-xp-rollup.test.ts`

**Interfaces:**
- Consumes: `claude_skill_rollups` (Task 2), `claude_skill_packs` (Task 1).
- Produces, all with `source = 'claude'`:
  - `skill_daily`, `skill_progress` and `skill_level_ups` rows of kind `skill` (key = the
    skill), `pack` (key = the pack or `(no pack)`) and `skill-use` (key = `all`);
  - no `skill_pace` row for any of them.

- [ ] **Step 3.1: Write the failing tests**

Append to `tests/skill-xp-rollup.test.ts`:

```ts
/** (kind, day) where the skill rows or the pack rows do not sum to the skill-use row. */
const useDrift = (db: string) => rows<Row>(db, `
  WITH u AS (SELECT day, active_ms AS ms FROM skill_daily WHERE source = 'claude' AND kind = 'skill-use'),
       k AS (SELECT kind, day, SUM(active_ms) AS ms FROM skill_daily
             WHERE source = 'claude' AND kind IN ('skill', 'pack') GROUP BY kind, day),
       want AS (SELECT 'skill' AS kind, day, ms FROM u UNION ALL SELECT 'pack', day, ms FROM u)
  SELECT w.kind, w.day, w.ms AS use_ms, k.ms AS sum_ms FROM want w LEFT JOIN k USING (kind, day) WHERE k.ms IS NOT w.ms
  UNION ALL
  SELECT k.kind, k.day, NULL, k.ms FROM k LEFT JOIN u USING (day) WHERE u.ms IS NULL`);

describe("skills, packs and Skill use as sub-skills", () => {
  // GUARD 6 (R21, plan R5): one skill resolved to (no pack) and one never
  // resolved at all; both count under (no pack). Planted: inner-join the pack
  // rows to claude_skill_packs.
  it("packs and skills each sum to Skill use, every day", () => {
    const home = skillsHome();
    const db = buildAndRoll("skill-mix", { CLAUDE_DIR: home });
    execFileSync("sqlite3", [db, `DELETE FROM claude_skill_packs WHERE skill = 'fx-unresolved';
      CREATE TRIGGER fx_unresolved BEFORE INSERT ON claude_skill_packs WHEN NEW.skill = 'fx-unresolved'
      BEGIN SELECT RAISE(IGNORE); END;`]);
    roll(db, { CLAUDE_DIR: home });
    expect(packOf(db, "fx-unresolved")).toEqual([]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'skill-use'")[0].n).toBeGreaterThan(0);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'pack' AND key = '(no pack)'")[0].n)
      .toBeGreaterThan(0);
    expect(useDrift(db)).toEqual([]);
  });

  // GUARD 7 (R21). Skill time is a slice of Claude's (decision 2): taking every
  // tag away moves no tool row, no agent_progress column and so no Total.
  // Planted: add claude_skill_rollups' time to _ag_life's Claude row.
  it("skill time never moves agent_progress or Total", () => {
    const db = buildAndRoll("skill-mix");
    const AP = `SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
                FROM agent_progress ORDER BY source`;
    const TOOLS = "SELECT source, key, day, active_ms FROM skill_daily WHERE kind = 'tool' ORDER BY source, day";
    const uses = () => rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'skill-use'")[0].n;
    const before = [rows<Row>(db, AP), rows<Row>(db, TOOLS)];
    expect(uses()).toBeGreaterThan(0);
    execFileSync("sqlite3", [db, "UPDATE claude_requests SET attribution_skill = NULL"]);
    roll(db);
    expect(uses()).toBe(0);
    expect([rows<Row>(db, AP), rows<Row>(db, TOOLS)]).toEqual(before);
  });

  it("levels every new kind, logs its level-ups, and gives none of them a pace", () => {
    const db = buildAndRoll("skill-mix", { CLAUDE_DIR: skillsHome() });
    expect(rows(db, "SELECT DISTINCT kind FROM skill_progress WHERE source = 'claude' ORDER BY kind"))
      .toEqual(["model", "pack", "project", "skill", "skill-use", "tool"].map((kind) => ({ kind })));
    expect(rows(db, "SELECT key FROM skill_progress WHERE kind = 'skill-use'")).toEqual([{ key: "all" }]);
    expect(rows(db, `SELECT p.active_s = d.ms / 1000 AS ok FROM skill_progress p
      JOIN (SELECT SUM(active_ms) AS ms FROM skill_daily WHERE kind = 'skill-use') d WHERE p.kind = 'skill-use'`))
      .toEqual([{ ok: 1 }]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_level_ups WHERE kind IN ('skill', 'pack', 'skill-use')")[0].n)
      .toBeGreaterThan(0);
    expect(rows(db, "SELECT source FROM skill_pace ORDER BY source")).toEqual([{ source: "all" }, { source: "claude" }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM skill_progress WHERE kind = 'skill' AND key = 'fx-sub-only'")).toEqual([{ n: 0 }]);
  });
});
```

Run: `npx vitest run tests/skill-xp-rollup.test.ts -t "as sub-skills"`
Expected: FAIL. No `skill-use` rows exist yet.

- [ ] **Step 3.2: Add the three `_sk_daily` branches**

In `capture/rollup.sh`, `_sk_daily`'s inner union gains three branches after
`UNION ALL SELECT 'claude', 'model', model, day, active_ms FROM claude_model_rollups`:

```sql
  -- Stage 7 (spec 4.4): each Claude Code skill, each pack through the durable
  -- map (an unresolved skill counts as '(no pack)'), and all skill time as one
  -- 'skill-use' row. Every kind below _sk_daily is generic over (source, kind,
  -- key); _ag_life, _sk_win, _sk_runs and _sk_pace read only kind = 'tool', so
  -- none of this reaches agent_progress, skill_pace or the Total level.
  UNION ALL SELECT 'claude', 'skill', skill, day, active_ms FROM claude_skill_rollups
  UNION ALL SELECT 'claude', 'pack', COALESCE(p.pack, '(no pack)'), r.day, SUM(r.active_ms)
            FROM claude_skill_rollups r LEFT JOIN claude_skill_packs p ON p.skill = r.skill
            GROUP BY COALESCE(p.pack, '(no pack)'), r.day
  UNION ALL SELECT 'claude', 'skill-use', 'all', day, SUM(active_ms) FROM claude_skill_rollups GROUP BY day
```

Extend `_sk_daily`'s header comment's first sentence to: "driven time per day for every
skill -- each tool, its projects and its models, and (Stage 7) Claude's Claude Code skills,
their packs and all skill time."

Run: `npx vitest run tests/skill-xp-rollup.test.ts tests/skill-rollup.test.ts tests/rollup-lock.test.ts`
Expected: PASS. Stage 6's identities still hold, because they read only kinds `tool`,
`project` and `model`.

- [ ] **Step 3.3: Give the density fixture skill time (R7)**

In `tests/fixtures/make-fixture.sh`'s `density-*` scenario, in the `claude_requests` INSERT,
change `CASE WHEN j = 0 THEN 'fx-skill-' || ((i + s) % 4) END` to
`CASE WHEN j = 2 THEN 'fx-skill-' || ((i + s) % 4) END`. Add this comment above the `fx_sql`:

```bash
    # Stage 7 (plan R7): the skill tag sits on j = 2, the last main-thread
    # request before each session's Stop, so the Stop's gap is skill time and
    # /character's budget pin measures real Skill use rows.
```

Run: `npx vitest run tests/report-budget.test.ts`
Expected: PASS. The Skill use section is not drawn yet, so the bytes are as before, apart from
the Skills page's per-skill tokens, which the per-week limits absorb.

- [ ] **Step 3.4: Plant guards 6 and 7, one at a time**

Commit first (step 3.5), then plant against the commit and `git checkout capture/rollup.sh`
after each.

- **Plant 6:** in the pack branch, `JOIN claude_skill_packs p` for `LEFT JOIN claude_skill_packs p`.
  Expected: only guard 6's test reddens.
- **Plant 7:** in `_ag_life`, make the Claude row
  `SELECT 'claude' AS source, (COALESCE(SUM(active_ms), 0) + (SELECT COALESCE(SUM(active_ms), 0) FROM claude_skill_rollups)) / 1000 AS active_s FROM claude_daily_rollups`.
  Expected: guard 7's test reddens.
  - The `live` and `dashboard` fixtures also carry skill time, so a test pinning Claude's level
    on either could redden too.
  - Record every red test. If there is more than one, report it rather than weakening a test.

Run the whole suite under each plant: `npx vitest run --exclude '.claude/**'`. Record every
failing test in `task-3-report.md`.

- [ ] **Step 3.5: Run the suite and typecheck, then commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`
Expected: all green.

```bash
git add capture/rollup.sh tests/fixtures/make-fixture.sh tests/skill-xp-rollup.test.ts
git commit -m "rollup: Claude Code skills, their packs and Skill use level as sub-skills"
```

---

### Task 4: The reader and the page

**Files:**
- Modify: `lib/read/character.ts`
- Modify: `lib/render/empty.ts`
- Modify: `lib/render/character.ts`
- Modify: `tests/read-character.test.ts`
- Modify: `tests/render-character.test.ts`
- Modify: `tests/report-budget.test.ts` (the comment above `PER_WEEK_LIMIT`; the `character`
  limit only if it is exceeded)

**Interfaces:**
- Consumes: the `skill`, `pack` and `skill-use` rows (Task 3), `claude_skill_packs` (Task 1).
- Produces, from `lib/read/character.ts`:
  - `SkillKind = "tool" | "project" | "model" | "skill" | "pack" | "skill-use"`;
  - `SKILL_USE_LABEL = "Skill use"`;
  - `NO_PACK = "(no pack)"`;
  - `interface PackedSkill extends Skill { pack: string }`;
  - `interface SkillUse { pending: boolean; level: Level | null; packs: Skill[]; skills: PackedSkill[] }`;
  - `CharacterData.skillUse: SkillUse`.
- Produces, from `lib/render/character.ts`: `SKILL_USE_ANCHOR = "character-skill-use"`.

- [ ] **Step 4.1: Write the failing reader tests**

In `tests/read-character.test.ts`, add `import { skillsHome } from "./helpers/skills-home";`,
then inside `describe("readCharacter", …)`:

```ts
  it("Skill use is pending on a database the v9 rollup has not run on", () => {
    const db = buildAndRoll("skill-mix");
    execFileSync("sqlite3", [db, "DROP TABLE claude_skill_packs"]);
    expect(readCharacter(db, { now: NOW, home: home() }).skillUse)
      .toEqual({ pending: true, level: null, packs: [], skills: [] });
  });

  it("reads Skill use, its packs and its skills, each skill with its pack", () => {
    const db = buildAndRoll("skill-mix", { CLAUDE_DIR: skillsHome() });
    // An unresolved skill (plan R9) reads as (no pack), as the rollup counts it.
    execFileSync("sqlite3", [db, "DELETE FROM claude_skill_packs WHERE skill = 'fx-unresolved'"]);
    const c = readCharacter(db, { now: NOW, home: home() });
    const u = c.skillUse;
    expect(u.pending).toBe(false);
    const use = rows<{ level: number; xp: number; active_s: number }>(db,
      "SELECT level, xp, active_s FROM skill_progress WHERE source = 'claude' AND kind = 'skill-use'")[0];
    expect(u.level).toMatchObject({ level: use.level, xp: use.xp, activeS: use.active_s });
    expect(u.packs.map((s) => s.key)).toEqual(rows<{ key: string }>(db, `SELECT key FROM skill_progress
      WHERE source = 'claude' AND kind = 'pack' ORDER BY level DESC, xp DESC, key`).map((r) => r.key));
    expect(u.skills.map((s) => [s.key, s.pack])).toEqual(rows<{ key: string; pack: string }>(db, `
      SELECT s.key, COALESCE(p.pack, '(no pack)') AS pack FROM skill_progress s
      LEFT JOIN claude_skill_packs p ON p.skill = s.key
      WHERE s.source = 'claude' AND s.kind = 'skill' ORDER BY s.level DESC, s.xp DESC, s.key`).map((r) => [r.key, r.pack]));
    expect(u.skills.find((s) => s.key === "fx-unresolved")?.pack).toBe("(no pack)");
    // Claude's own sub-skills hold none of the new kinds.
    const claude = c.tools.find((t) => t.source === "claude")!;
    expect(claude.models.map((s) => s.key)).toEqual(rows<{ key: string }>(db, `SELECT key FROM skill_progress
      WHERE source = 'claude' AND kind = 'model' ORDER BY level DESC, xp DESC, key`).map((r) => r.key));
  });

  it("labels Skill use's level-ups", () => {
    const db = buildAndRoll("skill-mix");
    const ups = readCharacter(db, { now: NOW, home: home() }).levelUps;
    const use = ups.filter((u) => u.kind === "skill-use");
    expect(use.length).toBeGreaterThan(0);
    expect(new Set(use.map((u) => u.label))).toEqual(new Set(["Skill use"]));
    expect(ups.some((u) => u.kind === "skill" && u.label === "superpowers:brainstorming")).toBe(true);
  });
```

In the existing test `"a database with no driven hours reads as none, never Lv 1"`, add:

```ts
    expect(c.skillUse).toEqual({ pending: false, level: null, packs: [], skills: [] });
```

Run: `npx vitest run tests/read-character.test.ts`
Expected: FAIL, because `skillUse` is undefined. Typecheck fails too, until step 4.2.

- [ ] **Step 4.2: Read Skill use**

In `lib/read/character.ts`:
- Change `SkillKind`:
  ```ts
  export type SkillKind = "tool" | "project" | "model" | "skill" | "pack" | "skill-use";
  ```
- After `LEVEL_UP_CAP`, add:
  ```ts
  /** Stage 7: the skill-use row's name -- its tile, its section and its level-up path. */
  export const SKILL_USE_LABEL = "Skill use";
  /** The pack rollup.sh gives a skill it could not place (spec 4.3), and an unresolved skill's. */
  export const NO_PACK = "(no pack)";
  ```
- After the `Skill` interface, add:
  ```ts
  /** A Claude Code skill, with the pack claude_skill_packs gives it. */
  export interface PackedSkill extends Skill {
    pack: string;
  }

  /** Stage 7: Claude Code skills, their packs and all skill time. Not in the Total level. */
  export interface SkillUse {
    /** No claude_skill_packs table: the installed rollup predates schema v9. */
    pending: boolean;
    /** The skill-use row's level; null with no skill time. */
    level: Level | null;
    /** Highest level first. */
    packs: Skill[];
    /** Highest level first. */
    skills: PackedSkill[];
  }
  ```
- In `CharacterData`, after `levelUpCount`, add `skillUse: SkillUse;`.
- `labelOf` becomes:
  ```ts
  const labelOf = (kind: string, key: string): string =>
    kind === "project" ? projectLabel(key) : kind === "skill-use" ? SKILL_USE_LABEL : key;
  ```
- After `toPace`, add:
  ```ts
  const SKILL_USE_PENDING: SkillUse = { pending: true, level: null, packs: [], skills: [] };

  /** Stage 7, plan R8 and R9: pending before the v9 rollup; a skill's pack is read here, not stored on its row. */
  function readSkillUse(db: string, prog: ProgRow[]): SkillUse {
    if (!hasTable(db, "claude_skill_packs")) return SKILL_USE_PENDING;
    const packOf = new Map(
      read<{ skill: string; pack: string }>(db, "SELECT skill, pack FROM claude_skill_packs;").map((r) => [r.skill, r.pack]),
    );
    const mine = prog.filter((r) => r.source === "claude");
    const use = mine.find((r) => r.kind === "skill-use");
    return {
      pending: false,
      level: use === undefined ? null : toSkill(use).level,
      packs: mine.filter((r) => r.kind === "pack").map(toSkill),
      skills: mine.filter((r) => r.kind === "skill").map((r) => ({ ...toSkill(r), pack: packOf.get(r.key) ?? NO_PACK })),
    };
  }
  ```
- In `readCharacter`'s early `pending` return, add `skillUse: SKILL_USE_PENDING`.
- In its final return, add `skillUse: readSkillUse(db, prog),`.

Run: `npx vitest run tests/read-character.test.ts`
Expected: PASS. `npm run typecheck` now fails only in `tests/render-character.test.ts`'s
`data()`, which step 4.3 fixes.

- [ ] **Step 4.3: Write the failing render tests**

In `tests/render-character.test.ts`:
- Update the first import:
  `import type { CharacterData, LevelUp, Pace, Skill, SkillUse, ToolCharacter } from "@/lib/read/character";`
- Add `skillUse: { pending: false, level: null, packs: [], skills: [] },` to `data()`'s
  defaults, before `...over`.
- After `noHours`, add:

```ts
/** Skill use with a level, two packs and two skills. */
const use = (over: Partial<SkillUse> = {}): SkillUse => ({
  pending: false, level: lv({ source: "claude", level: 40, tier: "Apprentice" }),
  packs: [skill("superpowers"), skill("(no pack)")],
  skills: [{ ...skill("superpowers:brainstorming"), pack: "superpowers" }, { ...skill("health"), pack: "gstack" }],
  ...over,
});
const claudeTool = () => tool({ source: "claude", label: "Claude Code" });
```

Then a new `describe`:

```ts
describe("Skill use", () => {
  it("draws its tile after the tools, outside the Total level, with a note saying so", () => {
    const h = html(data({ skillUse: use() }));
    expect(h).toContain(`href="#character-skill-use"`);
    expect(h.indexOf(`href="#character-codex"`)).toBeLessThan(h.indexOf(`href="#character-skill-use"`));
    expect(h).toContain("Skill use is time already in Claude&#39;s level, so it is not in Total.");
    expect(h).toContain("<b>57</b>"); // the Total level, unchanged
  });

  it("draws no tile and no note without skill time", () => {
    const h = html(data());
    expect(h).not.toContain(`href="#character-skill-use"`);
    expect(h).not.toContain("not in Total");
  });

  it("shows its section after Claude's: what it counts, its packs, its skills and their packs", () => {
    const h = html(data({ tools: [claudeTool(), tool()], skillUse: use() }));
    const at = (s: string) => h.indexOf(`id="character-${s}"`);
    expect(at("claude")).toBeLessThan(at("skill-use"));
    expect(at("skill-use")).toBeLessThan(at("codex"));
    const sec = sectionOf(h, "skill-use");
    expect(sec).toContain("Lv 40");
    expect(sec).toContain("Time in the turns that loaded a skill.");
    for (const s of ["Skill use · packs", "Skill use · skills", ">Pack<", ">superpowers:brainstorming<", ">gstack<", ">(no pack)<"]) {
      expect(sec).toContain(s);
    }
  });

  it("renders its empty states", () => {
    const pending = sectionOf(html(data({ tools: [claudeTool()], skillUse: { pending: true, level: null, packs: [], skills: [] } })), "skill-use");
    expect(pending).toContain("level pending");
    expect(pending).toContain("Watchtower&#39;s rollup has not run since its v9 install");
    const none = sectionOf(html(data({ tools: [claudeTool()] })), "skill-use");
    expect(none).toContain("No skill time yet.");
    for (const s of ["<table", "Lv 1<", "0 XP", "NaN"]) expect(none).not.toContain(s);
  });

  it("names Skill use and the skill paths in the level-up log", () => {
    const h = html(data({ levelUps: [
      up(0, { source: "claude", kind: "skill-use", key: "all", label: "Skill use" }),
      up(1, { source: "claude", kind: "skill", key: "superpowers:brainstorming", label: "superpowers:brainstorming" }),
      up(2, { source: "claude", kind: "pack", key: "gstack", label: "gstack" }),
    ], levelUpCount: 3 }));
    expect(h).toContain(">Skill use<");
    expect(h).toContain("Claude Code › skill › superpowers:brainstorming");
    expect(h).toContain("Claude Code › pack › gstack");
    expect(h).not.toContain("› skill-use ›");
  });

  it("escapes skill and pack names", () => {
    const nasty = "<o'brien & co>";
    const h = html(data({ tools: [claudeTool()], skillUse: use({
      packs: [skill(nasty)], skills: [{ ...skill(nasty), pack: nasty }],
    }) }));
    expect(h).not.toContain(nasty);
    expect(h).toContain("&lt;o&#39;brien &amp; co&gt;");
  });

  it("cuts its tables to REPORT_ROWS in the report", () => {
    const skills = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => ({ ...skill(`s${String(i).padStart(3, "0")}`), pack: "p" }));
    const d = data({ tools: [claudeTool()], skillUse: use({ skills }) });
    expect(html(d, false)).toContain(`the ${REPORT_ROWS} highest of ${REPORT_ROWS + 5} skills`);
    expect(html(d, true)).not.toContain("highest of");
  });
});
```

`sectionOf(h, "skill-use")` already works. It slices from `id="character-skill-use"` to the
next `id="character-` or the Level-ups card.

Run: `npx vitest run tests/render-character.test.ts`
Expected: FAIL. There is no tile, no section and no strings yet.

- [ ] **Step 4.4: Add the strings**

In `lib/render/empty.ts`, after the Stage 6 block:

```ts

/** Stage 7, Skill use (spec §5). */
export const LEVEL_PENDING_WHY_V9 = "Watchtower's rollup has not run since its v9 install";
export const NO_SKILL_TIME = "No skill time yet.";
export const SKILL_USE_COUNTED =
  "Time in the turns that loaded a skill. Your next prompt ends that turn, so a skill guiding a long conversation is credited for the turn that loaded it.";
export const SKILL_USE_NOT_IN_TOTAL = "Skill use is time already in Claude's level, so it is not in Total.";
export const noSkillRows = (what: "packs" | "skills"): string => `No ${what} with time yet.`;
```

- [ ] **Step 4.5: Draw the tile, the section and the paths**

In `lib/render/character.ts`:
- Imports:
  ```ts
  import {
    LEVEL_UP_CAP, SKILL_USE_LABEL, type CharacterData, type LevelUp, type Pace, type Skill, type SkillUse, type ToolCharacter,
  } from "../read/character.ts";
  import { AGENT_LABEL, type AgentSource, type Level } from "../read/level.ts";
  ```
  and add to the `./empty.ts` import: `LEVEL_PENDING_WHY_V9, NO_SKILL_TIME, SKILL_USE_COUNTED, SKILL_USE_NOT_IN_TOTAL, noSkillRows`.
- After `characterHref`, add:
  ```ts
  /** Stage 7: Skill use's section, the same id served and in the report. */
  export const SKILL_USE_ANCHOR = "character-skill-use";
  ```
- Replace `tile` with:
  ```ts
  function tileOf(label: string, anchor: string, l: Level): string {
    const stars = l.stars > 0
      ? ` <span class="stars" aria-label="${l.stars} ${l.stars === 1 ? "star" : "stars"} past 99">★×${l.stars}</span>` : "";
    return `<a class="c tile" href="#${anchor}"><h2>${esc(label)}</h2>` +
      `<div class="big lv">Lv ${l.level}<span class="muted">/99</span></div>` +
      `<div class="muted label">${esc(l.tier)}${stars}</div>${meter(l)}</a>`;
  }

  function tile(t: ToolCharacter): string {
    return t.state.state === "level" ? tileOf(t.label, characterAnchor(t.source), t.state.level) : "";
  }
  ```
- `skillsCard` becomes:
  ```ts
  function skillsCard(d: CharacterData): string {
    // Stage 7: Skill use's tile sits after the tools; its time is already in
    // Claude's level, so it stays out of the Total and the footer says so.
    const use = d.skillUse.level;
    const tiles = d.tools.map(tile).join("") + (use === null ? "" : tileOf(SKILL_USE_LABEL, SKILL_USE_ANCHOR, use));
    const grid = tiles === "" ? `<div class="state absent">${esc(NO_DRIVEN_HOURS)}</div>` : `<div class="g g-tiles">${tiles}</div>`;
    const foot = kv("Total level", d.totalLevel === null ? absent("—") : `<b>${d.totalLevel}</b>`);
    const note = use === null ? "" : `<p class="note">${esc(SKILL_USE_NOT_IN_TOTAL)}</p>`;
    return card({ title: "Skills", wide: true, body: grid + `<div class="block">${foot}${note}</div>` });
  }
  ```
- Replace `skillTable` with a shared cut, plus the tool table that uses it:
  ```ts
  type Row = { cells: Record<string, SortCell> };

  /** A sub-skill table, cut to REPORT_ROWS in the report with the usual note. */
  function cutTable(title: string, cols: SortColumn[], all: Row[], what: string, empty: string, served: boolean, extra = ""): string {
    const shown = served ? all : all.slice(0, REPORT_ROWS);
    const cut = shown.length < all.length
      ? `<p class="note">This report lists the ${REPORT_ROWS} highest of ${grouped(all.length)} ${what}; serve the dashboard for all of them.</p>`
      : "";
    return card({ title, wide: true, body: sortableTable(cols, shown, { empty }) + cut + extra });
  }

  function skillTable(t: ToolCharacter, what: "projects" | "models", served: boolean): string {
    const all = what === "projects" ? t.projects : t.models;
    const excluded = what === "projects" && t.excludedHidden ? `<p class="note">${esc(EXCLUDED_HIDDEN)}</p>` : "";
    return cutTable(`${t.label} · ${what}`, COLS, all.map(skillRow), what, noSubSkills(what), served, excluded);
  }
  ```
  `skillRow`'s return type annotation becomes `Row`.
- After `toolSection`, add:
  ```ts
  /** The skills table's columns: a Pack column after the skill (plan R9). */
  const PACK_COLS: SortColumn[] = [COLS[0], { key: "pack", label: "Pack" }, ...COLS.slice(1)];

  /** Stage 7 (spec §5): Skill use's level, what it counts, its packs and its skills. No pace (decision 7). */
  function skillUseSection(u: SkillUse, served: boolean): string {
    const head = (body: string) => card({ id: SKILL_USE_ANCHOR, title: SKILL_USE_LABEL, wide: true, body });
    if (u.pending) {
      return head(`<div class="state absent">${esc(LEVEL_PENDING)}</div><div class="muted">${esc(LEVEL_PENDING_WHY_V9)}</div>`);
    }
    if (u.level === null) return head(`<div class="state absent">${esc(NO_SKILL_TIME)}</div>`);
    const skills = u.skills.map((s): Row => ({ cells: { ...skillRow(s).cells, pack: { html: esc(s.pack), sort: s.pack } } }));
    return head(levelBlock({ state: "level", level: u.level }) + `<p class="note">${esc(SKILL_USE_COUNTED)}</p>`) +
      cutTable(`${SKILL_USE_LABEL} · packs`, COLS, u.packs.map(skillRow), "packs", noSkillRows("packs"), served) +
      cutTable(`${SKILL_USE_LABEL} · skills`, PACK_COLS, skills, "skills", noSkillRows("skills"), served);
  }
  ```
- `pathOf` becomes:
  ```ts
  const pathOf = (u: LevelUp) =>
    u.kind === "tool" ? AGENT_LABEL[u.source]
      : u.kind === "skill-use" ? SKILL_USE_LABEL
        : `${AGENT_LABEL[u.source]} › ${u.kind} › ${u.label}`;
  ```
- In `characterView`, the non-pending body becomes:
  ```ts
  characterCard(d) + skillsCard(d) +
      d.tools.map((t) => toolSection(t, served) + (t.source === "claude" ? skillUseSection(d.skillUse, served) : "")).join("") +
      levelUpsCard(d, served)
  ```
  The footer's source list becomes `from skill_progress, skill_pace, skill_level_ups, claude_skill_packs and agent_progress`.
- Extend the file's top comment with one line: "Stage 7 adds Skill use: a tile outside the
  Total level and a section after Claude's, with its packs and skills."

Run: `npx vitest run tests/render-character.test.ts tests/read-character.test.ts`
Expected: PASS.

- [ ] **Step 4.6: Re-measure the report budget**

Run the per-week measurement once with a temporary log. Add
`console.log(JSON.stringify(perWeek));` after `perWeek` in
`tests/report-budget.test.ts`'s last test, then:

Run: `npx vitest run tests/report-budget.test.ts -t "pinned bytes per week"`

Record the printed `character` and `total` values, then **remove the log line**.
- If `character` ≤ 50 and `total` ≤ 6,770, append to the comment block above `PER_WEEK_LIMIT`:
  ```ts
  // Stage 7 tags density's j = 2 request, so every session carries skill time,
  // and Character gains Skill use (tile, section, two tables cut to REPORT_ROWS):
  // <character> B/week and <total> B/week total measured; the pins hold.
  ```
  with the measured numbers filled in.
- If a value is over its limit, set that limit to the measurement +15%, rounded up to the next
  10, and say so in the same comment, as Stage 5's fix round did.

If `tests/sources-report.test.ts`'s whole-report multiple (4.4×) trips, re-measure it the same
way and record the new figure and multiple in its comment.

- [ ] **Step 4.7: Run the suite and typecheck, then commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`
Expected: all green; typecheck clean.

```bash
git add lib/read/character.ts lib/render/character.ts lib/render/empty.ts tests/read-character.test.ts \
        tests/render-character.test.ts tests/report-budget.test.ts
git commit -m "character: a Skill use tile outside Total, and its section of packs and skills"
```

(Add `tests/sources-report.test.ts` if step 4.6 changed it.)

---

### Task 5: Live proof, `SESSION.md`, `CLAUDE.md`

**Files:**
- Modify: `SESSION.md` (title line; a new Session 21 entry on top)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the whole branch.
- Produces: the proof numbers in `task-5-report.md` and `SESSION.md`.

- [ ] **Step 5.1: Make two copies of one snapshot**

Use the session scratchpad. `$SP` below is `<scratchpad>/stage7-proof`.

```bash
SP=<scratchpad>/stage7-proof; mkdir -p "$SP/main" "$SP/branch"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup '$SP/snap.sqlite'"
sqlite3 "$SP/snap.sqlite" ".backup '$SP/main/db.sqlite'"
sqlite3 "$SP/snap.sqlite" ".backup '$SP/branch/db.sqlite'"
git show main:capture/rollup.sh > "$SP/main/rollup.sh"; git show main:capture/lib.sh > "$SP/main/lib.sh"
cp capture/rollup.sh capture/lib.sh "$SP/branch/"
```

- [ ] **Step 5.2: Roll both up, timed, on one as-of day**

```bash
TODAY=$(date +%F)
for side in main branch; do
  /usr/bin/time -p env THEONE_DB_PATH="$SP/$side/db.sqlite" WATCHTOWER_DB_PATH="$SP/$side/db.sqlite" \
    CC_LIB_PATH="$SP/$side/lib.sh" WATCHTOWER_ROLLUP_TODAY="$TODAY" bash "$SP/$side/rollup.sh" --quiet
done
```

Expected: both exit 0. The branch's `real` is at most 1 s above main's. Record both.

The branch's run reads the live `~/.claude/skills` **read-only** to resolve packs. That is
the point of the proof.

- [ ] **Step 5.3: Nothing that exists moved**

For each table `T` below, compare all columns except `updated_at`, in both directions:
`claude_daily_rollups`, `claude_project_rollups`, `claude_rank_progress`,
`claude_profile_daily`, `claude_discipline_scores`, `claude_prices`, `claude_request_metrics`,
`claude_turns`, `agent_prices`, `agent_request_metrics`, `agent_daily_rollups`,
`agent_progress`, `claude_model_rollups`, `skill_pace`, and `skill_daily`, `skill_progress`
and `skill_level_ups` restricted to `kind IN ('tool','project','model')`.

```bash
cd "$SP/branch"
for T in claude_daily_rollups claude_project_rollups claude_rank_progress claude_profile_daily claude_discipline_scores \
         claude_prices claude_request_metrics claude_turns agent_prices agent_request_metrics agent_daily_rollups \
         agent_progress claude_model_rollups skill_pace skill_daily skill_progress skill_level_ups; do
  cols=$(sqlite3 db.sqlite "SELECT group_concat(name, ', ') FROM pragma_table_info('$T') WHERE name <> 'updated_at';")
  w=""; case "$T" in skill_daily|skill_progress|skill_level_ups) w="WHERE kind IN ('tool','project','model')";; esac
  sqlite3 -bail db.sqlite "ATTACH '$SP/main/db.sqlite' AS m;
    SELECT '$T', (SELECT COUNT(*) FROM $T $w),
      (SELECT COUNT(*) FROM (SELECT $cols FROM $T $w EXCEPT SELECT $cols FROM m.$T $w)),
      (SELECT COUNT(*) FROM (SELECT $cols FROM m.$T $w EXCEPT SELECT $cols FROM $T $w));"
done
```

Expected: every line reads `T|<rows>|0|0`, with `<rows>` > 0 for every table that has rows on
main. Any non-zero difference is a stop-and-report.

- [ ] **Step 5.4: The identities, on live data**

```bash
sqlite3 -bail "$SP/branch/db.sqlite" "
WITH u AS (SELECT day, active_ms AS ms FROM skill_daily WHERE source='claude' AND kind='skill-use'),
     s AS (SELECT day, SUM(active_ms) AS ms FROM skill_daily WHERE source='claude' AND kind='skill' GROUP BY day),
     p AS (SELECT day, SUM(active_ms) AS ms FROM skill_daily WHERE source='claude' AND kind='pack' GROUP BY day),
     c AS (SELECT day, active_ms AS ms FROM skill_daily WHERE source='claude' AND kind='tool')
SELECT (SELECT COUNT(*) FROM u),
       (SELECT COUNT(*) FROM u LEFT JOIN s USING (day) WHERE s.ms IS NOT u.ms),
       (SELECT COUNT(*) FROM u LEFT JOIN p USING (day) WHERE p.ms IS NOT u.ms),
       (SELECT COUNT(*) FROM u LEFT JOIN c USING (day) WHERE c.ms IS NULL OR u.ms > c.ms),
       (SELECT COUNT(*) FROM s WHERE day NOT IN (SELECT day FROM u)) + (SELECT COUNT(*) FROM p WHERE day NOT IN (SELECT day FROM u));"
```

Expected: `<days>|0|0|0|0`, with `<days>` > 0.

- [ ] **Step 5.5: One day's skill seconds by hand, and one level-up day**

Pick a day whose skill time comes from exactly one session:

```bash
sqlite3 "$SP/branch/db.sqlite" "SELECT sx_day, session_id FROM (
  SELECT strftime('%Y-%m-%d', COALESCE(s.started_at, 0), 'unixepoch', 'localtime') AS sx_day, r.session_id
  FROM claude_requests r JOIN claude_sessions s ON s.session_id = r.session_id
  WHERE r.is_sidechain = 0 AND r.attribution_skill <> '' GROUP BY r.session_id)
  GROUP BY sx_day HAVING COUNT(*) = 1 ORDER BY sx_day DESC LIMIT 1;"
```

For that session (`:sid`), recompute its seconds per skill independently. Use a correlated
subquery for the latest main-thread request, not `_evm`'s window. This proof SQL lives only in
the scratchpad, never in the repo:

```sql
WITH e AS (
  SELECT id, ts, hook_event_name AS evt,
         ts - LAG(ts) OVER (ORDER BY ts, id) AS gap,
         MAX(CASE WHEN hook_event_name = 'UserPromptSubmit' THEN ts ELSE 0 END)
           OVER (ORDER BY ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS lw,
         MAX(CASE WHEN hook_event_name IN ('Stop','SessionStart') THEN ts ELSE 0 END)
           OVER (ORDER BY ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS li
  FROM claude_events WHERE session_id = :sid AND hook_event_name NOT IN ('LauncherStart','LauncherEnd')
)
SELECT (SELECT NULLIF(r.attribution_skill, '') FROM claude_requests r
        WHERE r.session_id = :sid AND r.is_sidechain = 0 AND r.model IS NOT NULL AND r.model <> '<synthetic>' AND r.ts <= e.ts
        ORDER BY r.ts DESC, r.request_id DESC LIMIT 1) AS skill,
       SUM(CASE WHEN gap IS NULL OR evt IN ('SessionStart','SessionEnd') THEN 0
                WHEN evt = 'UserPromptSubmit' THEN MIN(gap, 300)
                WHEN lw > li THEN MIN(gap, 14400) ELSE MIN(gap, 300) END) AS secs
FROM e GROUP BY 1;
```

Save it to `$SP/by-hand.sql`, replace `:sid` with the quoted session id
(`sed "s/:sid/'<id>'/g"`), and run it against the branch copy. Then compare each non-NULL
row's `secs × 1000` with that day's `claude_skill_rollups` rows.
Expected: equal, skill for skill.

Then, for the `skill-use` row, find the first day whose cumulative XP reaches its stored level:

```sql
SELECT day, (SUM(active_ms) OVER (ORDER BY day) / 1000) * 13034431 / 9000000 AS xp
FROM skill_daily WHERE kind = 'skill-use' ORDER BY day;
```

Compare it with `SELECT level, day FROM skill_level_ups WHERE kind = 'skill-use' ORDER BY level DESC LIMIT 1;`.
Use the threshold `xp(level)` from `_ag_xp`. Reproduce it with the rollup's thresholds query,
or read the level's `xp - xp_into_level` from `skill_progress`.
- Expected: the stored day is the first day at or above `xp(level)`.

- [ ] **Step 5.6: Record the numbers, and check the report**

From `$SP/branch/db.sqlite`, record:
- Skill use: `SELECT level, tier, active_s / 3600.0 FROM skill_progress WHERE kind = 'skill-use'`.
- The top five packs and the top ten skills (`kind = 'pack'` / `'skill'`, by level, then XP):
  level and hours.
- `SELECT via, COUNT(*) FROM claude_skill_packs GROUP BY via`.
- `SELECT skill FROM claude_skill_packs WHERE pack = 'gstack' ORDER BY skill`.
- `SELECT skill FROM claude_skill_packs WHERE pack = '(no pack)' ORDER BY skill`.

Build the report from the branch copy:

```bash
WATCHTOWER_DB_PATH="$SP/branch/db.sqlite" node bin/watchtower report --out "$SP/report.html"
```

Record its size, which must be under 2,000,000 bytes. Then confirm in the HTML text:
- the Skill use tile and section render;
- the note "not in Total" is present;
- there is no `Lv 1<`, `0 XP` or `NaN`.

- [ ] **Step 5.7: Update `CLAUDE.md`**

- In **Commands**, update the test count `(1105 tests, 69 files)` to the suite's new count.
- After the Stage 6 paragraph in **Durable vs regenerable tables**, add:

  ```markdown
  Stage 7 (schema v9) levels Claude Code skills. `claude_skill_rollups` (regenerable, Claude's
  hours by skill per session start day) is filled by section 1: `_evm` also carries the
  `attribution_skill` of the main-thread request it finds for each event, and `_gap.skill` is
  that, with **no fallback** — Claude Code clears the tag at the next prompt, so a skill earns
  the turns that loaded it and the think gap after. The agent section adds `skill`, `pack` and
  `skill-use` rows (key `all`) to `skill_daily`, `skill_progress` and `skill_level_ups`;
  `skill_pace` stays keyed by tool, so Skill use has no pace. Skill use is a tile on
  `/character` and is **not in the Total level**: its time is already Claude's.
  ```

- In the **Durable** list, after `claude_project_paths`, add:

  ```markdown
  - `claude_skill_packs` (schema v9, Stage 7) — skill name → pack, resolved once by
    `rollup.sh`'s `_resolve_new_skills` (bash, before section 1): the text before a `:`
    (`plugin`), else the folder a `${CLAUDE_DIR:-$HOME/.claude}/skills/<name>/SKILL.md` symlink
    resolves into (`link`, how gstack installs), else `(no pack)` (`none`). `INSERT OR IGNORE`
    only, so uninstalling a pack moves no history.
  ```

- In **Invariants**, change "`CC_SCHEMA_VERSION` is **8**" to "**9**".
- In **Testing conventions**, add:

  ```markdown
  The fixture helpers pass `CLAUDE_DIR` pointing at a directory that never exists
  (`NO_CLAUDE_DIR`), so no rollup test reads the live `~/.claude/skills`;
  `tests/helpers/skills-home.ts` builds one with a linked pack and a plain skill.
  ```

- [ ] **Step 5.8: Update `SESSION.md`**

- Change the title line to cover session 21: Stage 7 implemented.
- Add `## Session 21 — 2026-10-07 — Stage 7 (Skill XP) implemented` above Session 20, in
  Session 20's shape:
  - **branch and review shape:** the branch, the commits, the test count;
  - **what it does:** two sentences;
  - **live proofs:** steps 5.2–5.6's numbers, and the copy paths;
  - **guard plants:** a table of the eight plants and every test each reddened, from the task
    reports;
  - **rulings:** R1–R10 by title, plus any controller rulings from the ledger;
  - **open items:**
    - PR number;
    - the user's `! gh pr merge <n> --squash --delete-branch`, `! bash capture/install.sh`
      (v9) and `! watchtower sync`;
    - "Stage 8 (achievements and quests) resumes from
      `docs/superpowers/specs/2026-10-07-stage-8-quests-achievements-brainstorm.md`, design
      section 1 of 4, and can now award skill milestones."

- [ ] **Step 5.9: Run the suite and typecheck, then commit**

Run: `npx vitest run --exclude '.claude/**' && npm run typecheck`
Expected: all green.

```bash
git add SESSION.md CLAUDE.md
git commit -m "docs: Stage 7 live proof, session 21 handoff, CLAUDE.md for schema v9"
```

---

## After the tasks

1. One whole-branch review on the most capable model, scoped to `5e5ce96..HEAD`. Give it the
   spec's §10 and this plan's Review Focus and Rulings.
2. At most one fix wave. Each fix is its own commit; a fix that changes a number re-runs
   step 5.3.
3. Push the branch and open the PR. The user merges, installs and syncs; auto mode blocks
   those steps, so hand over the exact `!` commands.

## Plan self-review (done while writing)

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §4.0 and §4.3 (pack resolution) | Task 1 |
  | §4.1 (tables) | Task 1 |
  | §4.2 | Task 2 |
  | §4.4, including the identities | Task 3, guards 6 and 7, and R6 |
  | §5 | Task 4 |
  | §6.1 guards 1–8 | Tasks 1–3, per the guard map |
  | §6.1 "also pinned" | the gap-copy counts in Global Constraints; lock shape in step 2.2; schema in step 1.3; v8→v9 in step 1.3; render states in step 4.3; budget in step 4.6 |
  | §6.2 | Task 5, steps 5.2–5.6 |
  | §7 | After the tasks |
  | §10.1–10.6 | guard 1, Review Focus 4, step 3.1's subagent-only check, Review Focus 2, Review Focus 1 and 5 |

- **Placeholders:** none. The two measured values in step 4.6 are filled in at run time, by
  instruction.
- **Types:**
  - `SkillUse`, `PackedSkill`, `SKILL_USE_LABEL`, `NO_PACK` and `SKILL_USE_ANCHOR` are spelled
    the same in Tasks 4's reader, renderer and tests.
  - `skill-use` / `all` / `(no pack)` are the same in the rollup SQL, the tests and the reader.
- **R21 risks:**
  - Plant 7 may also redden a test that pins Claude's level on `live` or `dashboard`. Step 3.4
    says to record that, not hide it.
  - Plant 2 reddens only guard 2's test, because R6 moved the ≤ identity there.
