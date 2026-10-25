# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # vitest run — the whole suite (1324 tests, 82 files)
npm run typecheck                     # tsc --noEmit
npm run lint                          # pinned ShellCheck over the scripts
npm run release -- v1.1.0 [--dry-run] # build, verify and publish a pushed tag's release from this machine
npx vitest run tests/ingest.test.ts   # one file
npx vitest run -t "matches claude_daily_rollups exactly"   # one test by name
bash -n capture/rollup.sh             # syntax-check a shell script (the suite does this too)
watchtower                            # open the dashboard in a browser, starting it in the background if needed
watchtower sync [--no-rollup]         # project every source into wt_*, then run the installed rollup
watchtower setup [--yes]               # guided install: requirements, a few questions (one per detected source), a settings.json diff, then capture and the chosen steps
watchtower stop                       # stop the background dashboard (its log: watchtower-serve.log beside the DB)
ln -s "$PWD/bin/watchtower" ~/.local/bin/watchtower   # one-time, from the repo root: put `watchtower` on PATH
```

There is no build step and no dev server. `jq` and `sqlite3` must be on `PATH`
— every capture script exits 0 silently without them.

## Checks, secrets and releases

**No GitHub Actions.** The repository has no workflows, by the user's decision (made while it
was private, when Actions minutes cost money). Do not add a workflow, a required status check
or a Dependabot `github-actions` entry; `tests/release-tooling.test.ts` fails if one appears.
Checks run locally: `npm run typecheck`, `npm test`, `npm run lint` (a pinned ShellCheck),
`npm run check:secrets` (a pinned Gitleaks over the full history) and
`node script/check-privacy.ts --tree`. Merge with squash. The pre-commit hook runs
`node script/check-secrets.ts --staged`, then `node script/check-privacy.ts --staged`; enable it
once per checkout with `git config core.hooksPath .githooks`. The secret check also refuses to
commit a database, a transcript, a log, live config or a private note by name
(`script/artifact-policy.ts`).

A release is a `v*` tag on a merged commit. `package.json`'s `version` must match the tag,
and `docs/release-notes/<version>.md` and a row in `docs/releases.md`'s history must exist.
`tests/release-tooling.test.ts` checks the current version, so a bump without them fails the suite.
Each stage that ships bumps the minor version; 0.8.0 is Stages 1–8, and 1.0.0 is the first public
release. `docs/releases.md` has the steps. After the tag is pushed, `npm run release -- <tag>`
(`script/release.ts`) archives the tag, verifies the archive and publishes it with `gh`. The user pushes tags, merges and publishes,
so hand over the exact `!` commands.

**The README ships with the feature.** A PR that adds a page, a table, a level rule or a
version updates `README.md` in the same change: the feature list, the Dashboard table, the
table list and, with a version bump, a What's new row. `tests/readme.test.ts` fails the suite when a
NAV/TOOLS page, a `CREATE TABLE` in `capture/lib.sh` or `lib/core/schema.ts`, or
`package.json`'s version is missing from it. It checks names, not prose: audit the words too.
The crest (favicon, header mark, `docs/assets/`) is drawn once in `lib/render/brand.ts`, and
`tests/brand.test.ts` holds every asset to its paths.

## Public-repository hygiene

This repository is public. Nothing committed may identify the user, a client or a machine:

- **No home paths.** Write `~/.claude`, `$HOME/.theone` or a path relative to the repo. Where
  an absolute path is the point (a fixture, an example), use a placeholder user such as
  `/Users/you`. `check-privacy.ts` allows only the placeholder names in its
  `PLACEHOLDER_NAMES`.
- **No client or personal names, and no hours tied to them.** Measurements quoted in specs,
  plans, release notes and PR bodies name projects generically ("a client project", `client-refresh`).
  Local terms that must never appear go one per line in `.git/info/private-terms`. That file
  lives inside `.git`, so it is never committed, and the staged check reads it.
- **No personal email, real request or session ids, or live cost figures in prose.** Commits
  use the GitHub noreply address; the staged check blocks the committer's own address if it
  is anything else.
- **Private notes stay local.** `SESSION.md`, anything under `.private/` and the build logs under
  `.superpowers/` (the `sdd/` briefs, reports and ledgers, which quote live measurements) are
  gitignored and refused by name.
- **No AI attribution** in commits or PR bodies, and squash merges take the PR title and body,
  so branch-commit trailers never reach `main`.

## What this repo is

A **passive observer** of Claude Code usage. Claude Code hooks and the status line write
raw events into a local SQLite database; a rollup script derives daily and per-project
history from them. Nothing sits in the request path.

Its public name is **Agent Watchtower**: repository `Agent-Watchtower`, package and release
archive `agent-watchtower`. Its history starts at 1.0.0: the 0.x releases were developed in a
private repository, `Claude-Watchtower`, now archived. Write the new name in anything current.
The `watchtower` CLI, the `claude_*` tables and the `~/.claude` install paths keep their names.
Specs, plans and 0.x release notes keep the old one.

Since Stage 5 Codex and Hermes are first-class beside Claude: their hours, Codex's cost at
API prices and an OSRS level for every tool come from the same database. OpenViking and
Atlas are a light touch (a health probe and a provenance link, no hours, no level). The
standalone dashboard (generated HTML served by `node:http`, zero runtime deps) has Overview,
Codex and Hermes beside the Claude pages. TheOneOS (`lib/claude-hours/`, a **different
repository**) reads the same database directly. Stage 3's brainstorm,
`docs/superpowers/specs/2026-09-12-stage-3-dashboard-brainstorm.md`, is the history of that UI.

`lib/config.ts` carries a `coach` stanza that **nothing implements** — a placeholder from
the original sketch, not a feature. Do not describe it as working. The sibling `proxy`
stanza was deleted in 2026-09; Watchtower has no request-path component and will not
grow one. Do not reintroduce it.

## Architecture

```
Claude Code hooks ─┐
status line ───────┼─→ ~/.theone/claude-code-usage.sqlite ←─ TheOneOS dashboard (other repo)
~/.claude/projects ┘        ▲
   transcripts        capture/rollup.sh rebuilds the derived tables
```

**The database is the interface.** No IPC, no API. Everything in `capture/` writes raw
rows; `rollup.sh` derives; readers query.

| File | Installed as | Role |
|---|---|---|
| `capture/lib.sh` | `~/.claude/cc-track-lib.sh` | **Single source of truth for the schema** and every DB write. Sourced by all the others. |
| `capture/hook.sh` | `~/.claude/hooks/cc-track-hook.sh` | Registered on 8 hook events. One `claude_events` row + session counters per event, in one `sqlite3` call. |
| `capture/snapshot.sh` | `~/.claude/watchtower-snapshot.sh` | Status-line JSON → `claude_status_snapshots`, throttled to 1/session/60s. |
| `capture/ingest.sh` | `~/.claude/watchtower-ingest.sh` | `~/.claude/projects/**/*.jsonl` → `claude_requests` (the only source of token counts), plus, from schema v5, `claude_tool_calls` and `claude_slash_commands`, and from v6, ms timing on each request and `claude_prompts`. |
| `capture/rollup.sh` | `~/.claude/claude-usage-rollup.sh` | Rebuilds `claude_daily_rollups`, `claude_project_rollups`, `claude_rank_progress`, the Usage Profile's `claude_profile_daily` and `claude_discipline_scores`, and, from schema v6, `claude_prices`, `claude_request_metrics` and `claude_turns`. **Owns the activity model**, all profile scoring, every price and every cost, response time and turn wait. |
| `capture/install.sh` | — | Idempotent installer. Wires `settings.json`, backs up what it replaces. `--dry-run` prints the `settings.json` it would write and writes nothing; `--status-line` wires `watchtower-snapshot.sh` only when Claude Code has no status line. Requires `jq` and `sqlite3`. |

`SessionEnd` runs `hook.sh` inline, then `ingest.sh --quiet; rollup.sh --quiet` in the
**background** under `nohup`, with all three standard streams detached. Ingest must
precede the rollup so the session's requests are aggregated in the same run that records
its end.

**Nothing slow may run in the foreground of a `SessionEnd` hook.** Claude Code cancels
them after 1.5s (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`), with only a `Hook cancelled`
line to show for it. Ingest takes ~6–11s, so the old foreground chain was killed on every
exit and tokens, hours and rank froze from 2026-09-12 to 2026-09-16.

`lib/config.ts` (config resolution, loud errors) and `lib/projects.ts` (rows in, display
rows out — **no time arithmetic**) are the original read layer.

### The multi-source layer (Stage 3A/3B)

`bin/watchtower` is a zero-dependency Node CLI (types stripped natively, no build, so no
`@/` alias there): `watchtower sync` and `watchtower ingest --stdin --source <id>`.

- `lib/core/` — the source-neutral `wt_*` namespace: `schema.ts` (its own
  `WT_SCHEMA_VERSION`, separate from `CC_SCHEMA_VERSION`, so Stage 3 never touches
  `~/.claude`), `records.ts` (validation; timestamps need an explicit offset),
  `ingest.ts` (chunked, batched writes), `sync.ts` (`runSync`), `sql.ts` (the sqlite3
  wrappers), `identity.ts`, `discovery.ts`, `adapters.ts`.
- `lib/adapters/claude/` projects the `claude_*` tables into `wt_*` **without changing
  any Claude number**. `lib/adapters/external/ndjson.ts` takes records from other tools.
- Sync skips unchanged records with `wt_record_fingerprints`, not a cursor, because
  Claude rows change in place. Fingerprints are advisory. If the write side changes, bump
  `WRITE_FORMAT_VERSION` in `lib/core/ingest.ts` to force a rewrite.

### Agents and levels (Stage 5)

`watchtower sync` projects every source into `wt_*`, then **runs the installed rollup**
(`lib/rollup-run.ts`; `--no-rollup` skips it). While `watchtower serve` is open,
`lib/background-sync.ts` repeats that every `dashboard.syncSeconds` (default 300, 0 off).
All adapters are read-only and copy no content; `lib/adapters/index.ts` (`adaptersFor`)
builds the list from config.

| File | Role |
|---|---|
| `lib/adapters/codex/` | `~/.codex` rollout files → sessions, events and requests (`token_usage_record`, or `token_count` deltas in old files). `wt_file_cursor` lets sync skip unchanged files. |
| `lib/adapters/hermes/` | `~/.hermes/state.db`, opened read-only → sessions, a message event each, and tokens copied verbatim from `session_model_usage`. Its own cost lands in `wt_requests.cost_usd`. |
| `lib/adapters/openviking/` | One `GET /health` plus two JSON files → `health` records. Never `ovcli.conf`. |
| `lib/adapters/atlas/` | Every `.atlas/sessions.db` under the roots → `checkpoint` records linked to Claude's canonical session. |
| `lib/adapters/entry.ts` | Originator → driven / automated / unclassified, and the reclassify SQL every Codex and Hermes sync runs. |

Metric authority has an own scope (`scope: "own"`): an own claim covers only the records a
source emits itself, so Codex may own `tokens_in` beside Claude. An unscoped claim stays
exclusive.

### Durable vs regenerable tables

Regenerable (`DELETE` + re-`INSERT` every rollup): `claude_daily_rollups`,
`claude_project_rollups`, `claude_rank_progress`, and, from Stage 4A, `claude_profile_daily`
and `claude_discipline_scores` (schema v5; declared in `lib.sh`, filled by `rollup.sh`'s
profile section, never by `ingest.sh`). Stage 4B (schema v6) adds three more, declared
empty in `lib.sh` and filled by `rollup.sh`'s first section:

- `claude_prices` — the rates, one row per model, speed and `effective_from`, written from
  rows held in `rollup.sh`. It exists so the Performance page can show the rates it used.
  **No rate appears under `lib/`** (`tests/cost-rollup.test.ts` greps for them).
- `claude_request_metrics` — one row per request: `priced` (NULL for `<synthetic>`, 0 with
  a `price_note` of `no-price-yet` (a priced model before its first `effective_from`),
  `unknown-model`, `fast` or `no-split`, 1 otherwise, `speed-absent` priced at standard),
  `cost_table_usd`, `response_ms` and `tok_per_s`.
- `claude_turns` — one row per prompt or command boundary with requests: `wait_ms` and a
  `status` of `measured`, `human` or `headless`. Only `measured` turns enter wait statistics.

Both rebuild sections work the same way: every intermediate table is built in a **read**
transaction (`BEGIN DEFERRED`, no write lock), and `BEGIN IMMEDIATE` covers only the
`DELETE`s and `INSERT`s that swap the rows in. Section 1 (the daily and project rollups)
opens with the read phase that builds `_pk`, the prices, per-request cost, latency and the
turns; the profile section builds all of its `_pf_*` tables that way. The rebuild takes
seconds and grows with history, and held under the write lock it stalled concurrent hook
writes past their timeouts; `tests/profile-rollup.test.ts` pins the shape.

`claude_profile_daily` and `claude_discipline_scores` are the entire input to the Usage
Profile page (`/profile`, `lib/read/profile.ts` + `lib/render/profile.ts`, wired into both
`watchtower serve` and `watchtower report` through `lib/views.ts`): the ladder, the Matrix
score and the ten discipline cards. That page reads, parses and labels only — every
threshold and formula stays in `rollup.sh`.

The Performance page (`/performance`, `lib/read/perf.ts` + `lib/render/perf.ts`, after
Usage Profile in the nav, ranged, and in the report) reads the three 4B tables: cost at API
prices and share by model, response median / p90 / tok/s by model, the wait per turn with
its measured / human / headless counts, the 5-minute vs 1-hour cache-write mix, what was
not priced, and `claude_prices` itself. Every other page shows cost two ways, labelled by
`lib/render/cost.ts` and nowhere else: **"at API prices"** (the rollup's
`cost_table_usd`) and **"Claude Code's figure"** (the status line's `cost_usd`). With
nothing to measure it says "no reading", with nothing priced "not priced", and a partial
sum carries "N not priced" — **never `$0.00`** for any of them. Order statistics (median,
p90 by nearest rank) live in `lib/read/perf.ts` and are used by every page; they sort and
pick stored values, never compute a cost or a time.

The Character page (`/character`, `lib/read/character.ts` + `lib/render/character.ts`) is
unranged, sits in the tool row, and is in the report. Its numbers come only from `skill_*`
and `agent_progress`: skills, sub-skill tables, pace, streaks and the level-up log. It also
calls `toolStatus` (`wt_ingest_state`, then the filesystem) to decide which tools get a
section: one not installed gets none. Every number is stored by `rollup.sh`; the page parses
and labels.

Stage 5 (schema v7) adds four more regenerable tables, declared empty in `lib.sh` and filled
by `rollup.sh`'s **last** section, after every Claude section has committed:
`agent_prices` (Codex's rates), `agent_request_metrics` (per-request cost and its
`price_note`), `agent_daily_rollups` (per `(source, day, project_key)`: hours, tokens, cost
and counts) and `agent_progress` (the stored XP, level, tier and seconds to next, one row per
tool). The agent section reads `wt_*`. Codex and Hermes `wt_*` rows are **durable**, only
upserted: a deleted log keeps its history. `wt_file_cursor` is advisory, like
`claude_ingest_cursor`.

Stage 6 (schema v8) adds five more regenerable tables, declared empty in `lib.sh`.
`claude_model_rollups` (Claude's hours by driving model, per day) is filled by section 1:
`_evm` and `_sfm` are built in its read phase, `_gap` (the per-gap rows `_act` used to be)
in its write phase. The four `skill_*` tables (`skill_daily`, `skill_progress`,
`skill_level_ups`, `skill_pace`: every tool's projects and models as skills) are filled by
the agent section's read phase and swap. `_ag_tier` is the one tier `CASE`, read by both
`_sk_prog` and `_sk_ups`. `WATCHTOWER_ROLLUP_TODAY` (YYYY-MM-DD) pins the as-of day for
pace and streaks.

Stage 7 (schema v9) levels Claude Code skills. `claude_skill_rollups` (regenerable, Claude's
hours by skill per session start day) is filled by section 1: `_evm` also carries the
`attribution_skill` of the main-thread request it finds for each event, and `_gap.skill` is
that, with **no fallback** — Claude Code clears the tag at the next prompt, so a skill earns
the turns that loaded it and the think gap after. The agent section adds `skill`, `pack` and
`skill-use` rows (key `all`) to `skill_daily`, `skill_progress` and `skill_level_ups`;
`skill_pace` stays keyed by tool, so Skill use has no pace. Skill use is a tile on
`/character` and is **not in the Total level**: its time is already Claude's.

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

Stage 10 (schema v11) adds six D&D attributes and levels past 99, three regenerable tables and
one column. `claude_discipline_scores_7d` (the as-of day's ten scores over its last 7 days, or
none under 20 requests) is filled by the profile section: `_pf_dw` gains a `'7'` row for the
as-of day only, and every `_pf_w*`, `_pf_in`, `_pf_parts`, `_pf_ev` and `_pf_sc` row is keyed
by `win`, so a reader that drops the `win` join mixes the windows. The agent section's `_at_*`
tables derive each attribute's Form (0–99; STR is output tokens per active hour over every
tool, the others average their measured disciplines, the map is `_at_def`) and insert
training rows (each day's hours × that day's 30-day Form / 99) into `_sk_daily` as
`source = 'character'`, `kind = 'attribute'`, so Stage 6's keyed pipeline levels them; every
reader that must not count them filters `kind = 'tool'`. `character_attributes` holds the
sheet (Forms, the ±10 boost, Base and Now). `_ag_xp` and `_ag_tier` run to 200 (Grandmaster,
Legend, Mythic, Eternal past Master), `level_caps` (99 → 120 → 150 → 170 → 200) opens a cap the
day any stat reaches the one below, and `skill_pace.eta_cap_days` paces to the current cap.
`lib/read/attributes.ts` + `lib/render/attributes.ts` draw the card on `/character`; every
"/99" became "/cap", and Max Cape compares with the first cap. Attributes are **not in the
Total level**.

**Durable — never rebuilt from the filesystem:**
- `claude_project_paths` — `cwd → git toplevel`, cached forever. A deleted directory keeps
  the attribution it had.
- `claude_skill_packs` (schema v9, Stage 7) — skill name → pack, resolved once by
  `rollup.sh`'s `_resolve_new_skills` (bash, before section 1): the text before a `:`
  (`plugin`), else the folder a `${CLAUDE_DIR:-$HOME/.claude}/skills/<name>/SKILL.md` symlink
  resolves into (`link`, how gstack installs; a pack's own router skill, such as `gstack`, joins
  its pack), else `(no pack)` (`none`). `INSERT OR IGNORE`
  only, so uninstalling a pack moves no history.
- `claude_requests` — transcripts are deleted after `cleanupPeriodDays`; rebuilding from
  disk would zero the token history the day cleanup ran. Its v6 columns are durable too:
  `first_ms`/`sent_ms` merge by a NULL-aware MIN; `last_ms`, `cache_write_5m`,
  `cache_write_1h` and `speed` by a NULL-aware MAX. NULL means "not recorded", never 0.
  `sent_ms` is the ms of the user entry before the request in its file, carried down the
  file by one stateful `jq` pass and across runs by `claude_ingest_cursor.last_user_ms`.
- `claude_ingest_cursor` is **advisory only**. Correctness comes from `request_id` being a
  primary key. Deleting the cursor costs a slower run and nothing else — `last_user_ms`
  included, because a full re-read reaches the same `sent_ms`.
- `claude_tool_calls` and `claude_slash_commands` (schema v5, Stage 4A) — same reasoning as
  `claude_requests`: built from the same transcripts, deleted on the same schedule. A
  `tool_use` and its `tool_result` commonly arrive in separate `ingest.sh` runs, so
  `claude_tool_calls` is assembled incrementally. The merge is idempotent, and
  order-independent for `ts`, `is_sidechain`, `is_error` and `tool_name` (MIN, MIN, a
  NULL-aware MAX, and one name per `tool_use`). Its other COALESCE fields (`request_id`,
  `session_id`, `mcp_server`) keep the **first** non-NULL arrival, which is not
  order-independent: 157 live ids carry `sessionId`s that differ across files. No number
  reads those fields. `claude_slash_commands` upserts with `INSERT OR IGNORE` on
  `entry_uuid` — a slash command is a fact about one line, never revised.
- `claude_prompts` (schema v6, Stage 4B) — one row per turn boundary: a main-thread,
  non-meta user entry with content and no `tool_result`, with its `kind`. Durable for the
  same reason. Not "a fact about one line": a forked session repeats a boundary uuid under
  another `sessionId` (1.4% of live uuids), so `claude_prompts.session_id` follows
  `claude_requests.session_id`'s rule **exactly** — MAX within a batch, first arrival
  across batches (`ON CONFLICT DO NOTHING`; the request upsert never updates
  `session_id`). A boundary and the requests that arrive with it therefore agree. They
  can differ only if a fork copies a boundary whose request an earlier run had not yet
  seen. Never MAX it across batches: it would drift from `claude_requests`, and turns join
  the two on `session_id`.

## Invariants — breaking these silently corrupts data

- **A tracker must never break Claude Code.** Every DB call on the hook path is best-effort
  and swallows its error. This is why bugs here are invisible: a malformed statement is
  dropped with nothing on stdout or stderr. (`rollup.sh`'s four `exit 1` paths are the
  exception — it is not on the hook path when run by hand.)
- **The activity model lives in `capture/rollup.sh` and nowhere else.** A test fails the
  build if `MIN(gap,` appears in any other script or in `lib/`. No model math in TypeScript,
  ever — grouping and labelling only.
- **The agent gap rule is Claude's, in `rollup.sh` only.** It runs over **driven** sessions
  only (originator lists in config; anything unclassified earns nothing) and books each gap
  to the local day of the event that ends it. Claude's own hours still book to the session's
  start day and did not move.
- **Hermes's figure never enters "at API prices".** Its `cost_usd` is Hermes's own
  number (a provider estimate or actual), shown separately. Only Codex is priced from
  `agent_prices`.
- **Levels are stored, never computed in TypeScript.** `agent_progress` holds XP, level,
  tier and `s_to_next`; `lib/read/level.ts` and `lib/render/level.ts` parse and label.
  `claude_rank_progress` is deprecated but still written (hygiene and lifetime sessions
  still read it).
- **Tokens come from `claude_requests`, never from snapshots.** `snapshot.sh` can only see
  context-window *occupancy*; taking the last snapshot per session was wrong by 63× on
  input and 201× on output. That bug is what Stage 2 exists to fix — do not reintroduce a
  snapshot-derived token figure.
- **Ingest upserts `MAX` per token field per `request_id`.** 47% of transcript usage rows
  repeat a `requestId`, and streaming writes partials with monotonically growing
  `output_tokens`, so summing overcounts and first-seen-wins undercounts. `MAX` is
  order-independent, commutative and idempotent — which is what makes the cursor advisory.
  `is_sidechain` takes `MIN` for the same reason.
- **Snapshot counters are CUMULATIVE per session — `MAX` them, never `SUM` them.**
  `claude_status_snapshots` carries running totals, so summing a column across rows
  multiplies it by the number of snapshots. Measured on `total_lines_added`: the naive sum
  gives 80,885,856 against a true 287,125, a **281.7× overcount**. This is the same bug
  class as the token defect — a per-moment reading mistaken for a cumulative one — and it
  is latent in every column of that table.
- **Never aggregate requests through `claude_sessions`.** 22.4% of requests predate the
  tracker and have no session row; joining drops them while the reconciliation identity
  still passes.
- **Never read `claude_sessions.duration_ms`.** A `session_id` survives `--resume`, so
  `ended_at - started_at` spans every dormant calendar gap — the ~10,389-hour phantom this
  project exists to correct. The only valid duration is `window_s`, summed per gap by
  `rollup.sh`.
- **The reconciliation identity:** per-project rows must sum to `claude_daily_rollups`
  exactly, per day, on all 17 reconcilable columns. `(unfiled)` and `(excluded)` are real
  rows so the identity is unconditional; `(excluded)` is hidden at read time, not write time.
- **Do not assert a measurement where there is none.** A day with no cache traffic gets a
  NULL `cache_hit_percentage` and its hygiene score rescales against the maximum that day
  could actually attain (65 or 75), rather than fabricating a 0.
- **The schema version is declared twice** — `CC_SCHEMA_VERSION` in `capture/lib.sh` (it
  names the `.schema-vN` marker that gates `cc_init_db`'s fast path) and `schemaVersion` in
  `lib/config.ts`. A test pins them together. Bump both. `CC_SCHEMA_VERSION` is **11** and
  `WT_SCHEMA_VERSION` (`lib/core/schema.ts`) is **3**.
- **Exclusion defaults are duplicated on purpose** in `rollup.sh` and `lib/config.ts` —
  the rollup runs from a hook with no Node available. A test asserts they match.

## Working against the live system

- `~/.claude/` is the **live** Claude Code install; `~/.theone/` holds the **real** usage
  database. Read freely; write only through `capture/install.sh`, and only when asked.
- **Never run `install.sh` without `CLAUDE_DIR`** pointed at a temp dir, unless a live
  install was explicitly requested — it defaults to `$HOME/.claude`. Dry-run into a temp
  dir seeded from the live config first and diff `settings.json`; that has caught real
  hook-deletion bugs.
- **Never test against the live DB.** Copy it with `sqlite3 .backup` (not `cp` — it is WAL)
  and point `THEONE_DB_PATH` at the copy.
- **The `.schema-vN` marker lives in the database's *directory*.** Two databases in one
  directory share a marker and the second silently gets no schema. Give every side-by-side
  comparison its own directory. This has bitten three separate times.
- **Lockstep with `TheOneOS/lib/claude-hours/`**, which recomputes from the raw tables and
  ignores the rollups. Any change to the model must be re-proved against it *numerically*
  (column aliases are not part of the model), by running its `PER_SESSION_SQL` against the
  same DB copy the shell rollup just processed. Its tokens come from `PER_DAY_TOKENS_SQL`,
  which is `_dtok` verbatim; its hygiene must equal `hygiene_score` exactly.
  `tests/fixtures/theone-token-proof.mjs` checks both, run by hand.
  Beside it, `tests/fixtures/theone-watch-proof.mjs` proves TheOneOS's Claude Code tab
  (`lib/watchtower/`) against `lib/read/perf.ts`, `lib/read/profile.ts` and
  `lib/render/profile.ts`, and that the Hours payload is unchanged; run it by hand with
  `--all` on a rolled-up DB copy.

## Testing conventions

Tests drive the real bash scripts against fixture databases — `tests/helpers/fixture-db.ts`
builds one with `tests/fixtures/make-fixture.sh` and runs `rollup.sh` over it with `TZ=UTC`
pinned (the rollup buckets by *local* day). `tests/fixtures/make-transcripts.sh` builds
`.jsonl` transcripts for the ingest tests. `WATCHTOWER_ROLLUP_TODAY` pins the as-of day
for pace and streaks; `roll(db, env)` in `tests/helpers/agent-seed.ts` passes it.

The fixture helpers pass `CLAUDE_DIR` pointing at a directory that never exists
(`NO_CLAUDE_DIR`), so no rollup test reads the live `~/.claude/skills`;
`tests/helpers/skills-home.ts` builds one with a linked pack and a plain skill.

Fixtures fail **loudly** (`fx_sql` uses `.bail on`) and encode values through `lib.sh`'s own
encoders — a fixture with its own quoting exercises a different path than production, which
is how a real data-loss bug in `cc_sqlstr` stayed invisible.

Rollup tests seed `wt_*` directly through `tests/helpers/agent-seed.ts`, never through an
adapter (`tests/fixtures/make-codex-logs.sh` and `make-hermes-db.sh` feed the adapter
tests). Rule R21: each guard's literal values live in exactly one test, so a planted defect
reds exactly one test; every other test over the same data asserts identities.

**A guard is not done until its defect has been planted and watched turn exactly one test
red.** The mutation checks in `tests/ingest.test.ts` and `tests/project-rollup.test.ts` are
the point of those files, not decoration. This repo's history is mostly tests that passed
while asserting less than their names claimed.

**The report's size is guarded per week of history**, not only per year:
`tests/report-budget.test.ts` pins each page's bytes per week on the `density-N` fixture
(live-like per-day cardinality). Chart markup is therefore pinned in that one test. Every
other test reads chart marks through `tests/helpers/marks.ts` (hover columns, coordinates
with or without `.0`, segments), so a change of encoding reds the guard and nothing else.

## Where the reasoning lives

- `SESSION.md` — running handoff log: current state, decisions already made (do not re-ask),
  hard constraints, known open items. **Local only**: gitignored and refused by the
  pre-commit check, so it may name real projects and paths. Never commit it or quote it into
  a tracked file.
- `docs/backlog.md` — decided but unscheduled work, with what is already settled.
- `docs/superpowers/specs/` — binding specs per stage.
- `docs/superpowers/plans/` — implementation plans per stage.
- `docs/superpowers/specs/2026-09-12-stage-3-dashboard-brainstorm.md` — brainstorm state
  for the standalone dashboard: decisions already made, the validated stat inventory, and
  the open approval gate. Read it before touching Stage 3.
- `.superpowers/sdd/<plan>/progress.md` — the long form: every ruling, measurement and
  rejected alternative, per task. Go here before re-litigating a design choice. **Local
  only**, like `SESSION.md`; the 0.x ledgers are in the archive's history.

Work ships one stage per branch, subagent-driven: a fresh implementer per task, a scoped
review after each, then a whole-branch review and fix rounds.
