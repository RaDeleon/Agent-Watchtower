# Stage 5 — Codex and Hermes beside Claude, and every tool levels like an OSRS skill

**Status:** chat design approved 2026-10-03 (all five sections). This written spec is
awaiting review. §2.1 lists the few places where it refines the chat design.
**Branch:** `stage-5-agents-and-levels`, cut from `main` @ `6b30358`.
**Research:** `2026-10-03-stage-5-mmorpg-research.md` (levels and rankings in WoW, FFXIV,
OSRS/RS3, GW2, Lost Ark/BDO, Diablo 4).
**Supersedes:** the build order in `2026-09-14-stage-3-source-agnostic-architecture.md` §13
for Codex, Hermes, Atlas and OpenViking. Hermes moves from health source to agent (§3.3), and
Atlas and OpenViking get the light touch in §3.4 now instead of later stages.
**Keeps:** every decision in `2026-09-15-sync-trigger-and-surfaces-design.md` §7.

## 1. Purpose and success

Watchtower's dashboard shows Claude Code, Codex and Hermes side by side: hours, sessions,
tokens and cost, on one Overview and on a page per tool. Every tool levels independently,
like an Old School RuneScape skill, from the hours you actually drove it. The old Claude-only
rank ladder retires, here and in TheOneOS.

Success means:

1. `watchtower sync` projects every Codex usage record and every Hermes session on the live
   machine. Per-day Codex tokens equal an independent `jq` pass over the same logs, and
   per-session Hermes tokens equal `state.db`'s own columns, exactly.
2. A warm `watchtower sync` (no log changed) takes about 2 s or less on the live machine. A
   cold run is measured and recorded (§6.2).
3. Claude's active hours are byte-identical to `main`'s. Claude's level is the OSRS formula
   applied to those hours (292.2h → Lv 77 on 2026-10-02).
4. Codex and Hermes hours come from the same gap rule as Claude's, over driven sessions only.
   An automated session earns no hours.
5. No page shows `$0.00`, `0 h` or a level for something that was not measured (§5).
6. The Overview, Codex and Hermes pages render under all five themes and in
   `watchtower report`, inside the per-week size budget.
7. TheOneOS's Hours panel shows the same level as `agent_progress`, proven numerically. The
   rest of its payload is unchanged.
8. Every new guard has had its defect planted, and each plant turned exactly one test red.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | Codex and Hermes appear in **Watchtower's dashboard**. TheOneOS's Codex Watch and Hermes Watch tabs are untouched. |
| 2 | Depth: a cross-tool **Overview** plus **one page each** for Codex and Hermes. Claude's existing pages stay as they are. |
| 3 | Codex is priced at **OpenAI's API list rates**, labelled "at API prices". A model with no published rate is "not priced". |
| 4 | Hermes shows **its own stored figure**, labelled "Hermes's figure", never re-priced and never added into "at API prices". |
| 5 | Hours per tool, and **each tool has its own level**. |
| 6 | Progression is **OSRS skills**: levels 1–99 per tool on OSRS's exact XP curve, 99 at 2,500 active hours, the seven existing tier names as level bands, a Total level, a Max Cape, and a star per 250h past 99. |
| 7 | Only **time you drive** a tool counts toward its hours and level. Automated sessions show their tokens and cost, labelled automated, and earn nothing. |
| 8 | **Claude stays as it is.** Its hours keep coming from the hook activity model, headless SDK sessions included. The `sdk-*` entrypoint cannot tell a script from a person driving another front end (the Second-Brain vault: 47 sessions, 1,441 requests), and one-shot calls add seconds. |
| 9 | Atlas and OpenViking get a **light touch** in this stage: an OpenViking card on the Overview and an Atlas line on the Claude sessions it knows. Neither touches hours, cost or levels. |
| 10 | **One combined spec**: sources and progression ship as one stage. |
| 11 | Architecture **A**: TypeScript adapters into the `wt_*` layer behind `watchtower sync`. Every derivation (hours, prices, cost, levels) lives in `capture/rollup.sh`. |
| 12 | No rested XP and no catch-up bonus. Any bonus crediting time not worked would fabricate a measurement. |

### 2.1 Where this spec refines the chat design

- **Table names.** The chat called the derived tables `wt_daily_by_source`, `wt_request_metrics`
  and `wt_progress`. They are `agent_daily_rollups`, `agent_request_metrics`, `agent_prices`
  and `agent_progress` (§4.1). The `wt_*` namespace is declared in `lib/core/schema.ts`
  and versioned by `WT_SCHEMA_VERSION`. The rollup runs from a hook with no Node, so the
  tables it fills must be declared in `capture/lib.sh` beside `claude_*`. A separate prefix
  keeps each file the single owner of its namespace.
- **The level-1 rule.** A tool with driven hours > 0 has a level ≥ 1. A tool with none shows
  "no driven hours yet", not Lv 1 (§5).

## 3. Data in — `lib/adapters/{codex,hermes,openviking,atlas}/`

Every adapter opens its source **read-only** and copies **no message, prompt or memory
content**: only timestamps, roles, models, token counts and session metadata. Each owns only
its own source's metrics, and the existing ingest refusal (`wt_ingest_state.metrics_rejected`)
enforces that.

### 3.1 Measured on 2026-10-02 (the live machine)

| Source | Fact |
|---|---|
| Codex | `~/.codex/sessions`: 128 rollout files, **991 MB**. `~/.codex/archived_sessions`: 1 file. |
| Codex | `token_usage_record` lines (one per API response, keyed by `response_id`) exist only from **2026-09**: 967 in September, 654 in October. Older files carry only `event_msg/token_count`, whose `total_token_usage` is a **running total**. |
| Codex | `input_tokens` **includes** `cached_input_tokens`, unlike Claude's `tokens_in`. `output_tokens` includes `reasoning_output_tokens`. |
| Codex | Models by session: `gpt-5.6-sol` 35, `codex-auto-review` 34, `gpt-5.5` 24, `gpt-6-astra` 17, `gpt-6.1-sol` 9, then five with 1–3 sessions each. |
| Codex | Originators of the 64 files since 2026-09-01: Codex Desktop 24, `codex-chrome-extension-sidepanel` 17, `codex_work_desktop` 11, `codex-tui` 6, `buzz-acp` 4, `codex_exec` 1, `codex_vscode` 1. |
| Codex | A resumed session is appended under a **later date folder**: a file under `2026/10/02/` carries `session_meta.timestamp` 2026-09-30. |
| Hermes | `~/.hermes/state.db`, 22 MB, WAL, written while Hermes runs. 71 sessions, 2026-05-31 → 2026-09-05. Sources: `api_server` 32, `cli` 19, `tui` 18, `telegram` 2. |
| Hermes | Per-session tokens on `sessions`; per-model usage in `session_model_usage` (85 rows); 1,690 timestamped `messages`. `actual_cost_usd` is NULL everywhere; `estimated_cost_usd` totals a few dollars; `cost_status` is `estimated` or `unknown`. Mostly free and local models. |
| OpenViking | Local tunnel `http://127.0.0.1:1933`: `/health` answers 200 without auth, and every other probed endpoint is 401. The plugin keeps `~/.openviking/state/last-recall.json`, `last-capture.json` and `daily-stats.json`. |
| Atlas | `.atlas/sessions.db` exists in this repo only. It holds `agent_session`, `checkpoint`, `file_touch` and more. `agent_session.native_session_id` equals `claude_sessions.session_id` (proven 2026-09-14). |
| Claude | 472 sessions have an `sdk-*` entrypoint (`sdk-cli` 463, `sdk-ts` 9). About 400 are one-request calls; the rest are long conversations through other front ends. Decision 8 leaves them as they are. |

### 3.2 Codex — `lib/adapters/codex/`

Reads `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl`.

- **Requests.** One `wt_requests` row per `token_usage_record`, keyed `(codex, response_id)`.
  Tokens are normalised to Claude's meaning:
  `tokens_in = input_tokens − cached_input_tokens − cache_write_input_tokens`,
  `tokens_cache_read = cached_input_tokens`,
  `tokens_cache_creation = cache_write_input_tokens`,
  `tokens_out = output_tokens`.
  Both cache counts are treated as subsets of `input_tokens`, so the four counters never
  overlap. `cache_write_input_tokens` was 0 in every record inspected. The plan's
  measurement task confirms the subset reading on the live logs before the adapter is
  written.
  `reasoning_output_tokens` goes to `wt_usage` as its own metric and is **never added to
  `tokens_out` again**.
- **Older logs.** A file with no `token_usage_record` lines falls back to `token_count`
  events. `total_token_usage` is cumulative, so each **distinct** total within a session
  becomes one request whose usage is the **delta** from the previous distinct total. Its
  key is `(codex, <session id>:<cumulative total_tokens>)`. A repeated total is the same
  record. Totals are **never summed**: this is the snapshot-counter bug class
  (CLAUDE.md, 63× to 281× overcounts) arriving by a new route.
- **The model** comes from the latest `turn_context.model` at or before the record.
- **Sessions.** One `wt_sessions` row per `session_meta.id`, carrying the raw `cwd`, git
  branch and `repository_url`. `wt_sessions` gains a `cwd` column (`WT_SCHEMA_VERSION`
  bump). The **rollup** resolves projects, not the adapter: its existing cwd resolver
  (`rollup.sh`, the `unresolved` query) also resolves Codex and Hermes cwds into
  `claude_project_paths`. Codex projects therefore follow Claude's exact rules: git
  top-level, exclusions, and a deleted directory keeping the attribution it had.
- **Driven or automated.** `wt_sessions` gains `entry` (the originator string) and `driven`
  (1, 0, or NULL for unclassified). The defaults live in `lib/config.ts`:
  - driven: `Codex Desktop`, `codex_work_desktop`, `codex-tui`, `codex_vscode`,
    `codex-chrome-extension-sidepanel`;
  - automated: `codex_exec`, `buzz-acp`.

  Any other originator is NULL. A NULL earns no hours and is listed on the Codex page with
  the config key that assigns it. Reclassifying changes the record's fingerprint, so the
  next sync rewrites it.
- **Activity events** (`wt_events`, one per line that marks time, no content):

  | `kind` | From | Role in the gap rule (§4.2) |
  |---|---|---|
  | `session_start` | each `session_meta` line, including the one a resume appends | a gap ending here counts 0 |
  | `prompt` | `event_msg/task_started` (one per user turn) | starts work; a gap ending here is capped at 300 s |
  | `stop` | `event_msg/task_complete`, and `turn_aborted` where present | ends work |
  | `activity` | every other timestamped line | credited by the current state |

  `task_started` is the turn marker, not `response_item` messages with `role = user`. Those
  include injected context, e.g. 16 user messages against 12 turns in one file. Some files
  carry no task markers at all; two of five sampled on 2026-10-03 had none. Their gaps fall
  under the 300 s cap, which undercounts a long autonomous run and never overcounts. The
  measurement task counts these files.

- **Speed.** A new advisory table, `wt_file_cursor (source, path, size, mtime_ns)`, lets sync
  skip a file whose size and mtime are unchanged. Correctness still comes from the primary
  keys: deleting the cursor costs one slow run and nothing else. A partial last line in a
  file being written is skipped and read on the next run, never counted as malformed.

### 3.3 Hermes — `lib/adapters/hermes/`

Reads `~/.hermes/state.db` with `sqlite3 -readonly` and a busy timeout. Hermes is an
**agent**: it has sessions, models, tokens and its own cost. `wt_sources.source_type` is
`agent`, superseding the September spec's `health`, which was measured before Hermes
recorded usage.

- **Sessions.** One `wt_sessions` row per `sessions.id`, with `entry = sessions.source` and
  `driven` set from config: `cli`, `tui` and `telegram` are driven; `api_server` (TheOneOS's
  Hermes Operator) is automated; anything else is NULL.
- **Usage.** One `wt_requests` row per `session_model_usage` row, keyed by that table's own
  primary key: `(session_id, model, billing_provider, billing_base_url, billing_mode, task)`.
  The row's `ts` is the session's `started_at`, because Hermes stores no per-call time. A
  Hermes session's tokens therefore land on the local day it **started**, even if it ran
  past midnight. Hours still split by day, because they come from message timestamps.
- **Cost.** `cost_usd` = `actual_cost_usd` when it is not NULL, else `estimated_cost_usd`.
  `cost_status` and `cost_source` go to `wt_usage` alongside it. The row is labelled
  "Hermes's figure" everywhere and is **never** an input to "at API prices".
- **Activity events.** From `messages`: `role = 'user'` is `prompt`; an assistant message
  with `finish_reason` in (`stop`, `length`, `error`) is `stop`; everything else is `activity`; the session's
  `started_at` is `session_start`. A non-NULL `ended_at` is `session_end`, and a gap ending
  there counts 0, as Claude's does. Only `timestamp` and `role` are read; `content` and the
  reasoning columns are never selected.

### 3.4 The light touch — OpenViking and Atlas

- **OpenViking** registers as `source_type = 'memory'`. Each sync writes `wt_metrics`
  snapshots:
  - `reachable` (0 or 1), from `GET <url>/health` with a 2 s timeout. `url` comes from
    `sources.openviking.url` in `lib/config.ts`, default `http://127.0.0.1:1933`.
  - `recall_count`, `recall_latency_ms` and `recall_tokens` from `last-recall.json`.
  - `capture_turns` and `capture_committed` from `last-capture.json`.

  `~/.openviking/ovcli.conf` is **not read**: it holds an API key. No memory content is read.
  History accrues from the first sync.
- **Atlas** registers as `source_type = 'provenance'` and reads `.atlas/sessions.db` under the
  configured roots (bounded, as `lib/config.ts` already says). For each `agent_session` whose
  `native_session_id` matches a Claude session id, it writes a `wt_links` row plus two
  counts:
  - `COUNT(*) FROM checkpoint WHERE session_id = agent_session.id`;
  - `COUNT(*) FROM file_touch WHERE session_id = agent_session.id AND deleted = 0`.

  `agent_session.token_totals` is never read: Atlas's tokens disagree with
  `claude_requests` by up to 2.03× (September finding 2). Atlas contributes no tokens and
  no hours.

## 4. Derivations — a new section of `capture/rollup.sh`

### 4.1 Tables (declared in `capture/lib.sh`, `CC_SCHEMA_VERSION` 6 → 7)

All four are regenerable: `DELETE` and re-`INSERT` on every run. They are built in the
existing read-transaction pattern: intermediates under `BEGIN DEFERRED`, and only the swap
under `BEGIN IMMEDIATE`.

| Table | One row per | Holds |
|---|---|---|
| `agent_prices` | model, `effective_from` | OpenAI rates per 1M tokens: input, cached input, output. Written from rows held in `rollup.sh`. |
| `agent_request_metrics` | Codex request | `priced` (1, or 0 with a `price_note`: `no-price-yet`, `unknown-model`, `no-public-rate`) and `cost_table_usd` |
| `agent_daily_rollups` | source, local day | `active_s`; driven, automated and unclassified sessions; requests; the four token counters; `cost_table_usd` with priced and unpriced counts (Codex); `own_cost_usd` (Hermes's figure) |
| `agent_progress` | source (`claude`, `codex`, `hermes`) | lifetime `active_s`, `xp`, `level`, `tier`, `xp_into_level`, `xp_to_next`, `s_to_next`, `stars`, `updated_at` |

If `wt_sources` has no Codex or Hermes row, because sync has never run, the section writes
only Claude's `agent_progress` row and nothing else.

`claude_rank_progress` keeps being written exactly as today. TheOneOS on `main` reads its own
ladder until its lockstep PR merges (§7). It is marked deprecated in `lib.sh`, and its
removal is not part of Stage 5.

### 4.2 Hours

For Codex and Hermes, the rollup applies **Claude's gap rule, unchanged in meaning**, to each
source's `wt_events`, in **driven sessions only**. Each gap ends at the current event:

- a gap ending at `session_start` or `session_end` counts 0;
- a gap ending at `prompt` is capped at 300 s;
- while working (the last `prompt` is later than the last `stop` or `session_start`), a gap
  is capped at 14,400 s;
- otherwise a gap is capped at 300 s.

Ties are ordered by the event's ordinal within its source file or table. The rule appears
in `rollup.sh` only; the `MIN(gap,` guard still fails the build elsewhere. A test runs one
event stream through both Claude's rule and the agent rule and asserts identical seconds,
so the two copies cannot drift.

Claude's own hours are untouched: same query, same tables, same result.

### 4.3 Codex cost

- **Rates** are rows in `rollup.sh`, filled at build time from OpenAI's published API pricing
  page, with the URL and the date read cited beside them. No rate appears under `lib/`; the
  existing test greps for one.
- `cost = (tokens_in + tokens_cache_creation) × input + tokens_cache_read × cached_input +
  tokens_out × output`. OpenAI bills a cache write as ordinary input, so
  `tokens_cache_creation` is priced at the input rate. Reasoning tokens are already inside
  `tokens_out`.
- A model with no row is `unknown-model`. A model OpenAI does not sell on the API
  (expected: `codex-auto-review`) is `no-public-rate`. A request before its model's
  `effective_from` is `no-price-yet`. All three are "not priced", never $0.

### 4.4 Levels (OSRS)

- **XP** = `active_s × 13,034,431 / 9,000,000`, integer division, so 2,500 h = 13,034,431 XP.
- **The XP needed for level L** is OSRS's formula:
  `xp(L) = floor( ¼ × Σ_{l=1}^{L−1} floor(l + 300 × 2^(l/7)) )`.
  `rollup.sh` holds the 99 thresholds as a literal `VALUES` list, with a test that recomputes
  them from the formula. Pins: `xp(10) = 1,154`, `xp(50) = 101,333`, `xp(92) = 6,517,253`
  (exactly half of 99), `xp(99) = 13,034,431`.
- **Level** = the highest L in 1..99 with `xp(L) ≤ XP`.
- **To next** is XP and seconds. At 99 it is NULL, and the card shows stars instead.
- **Tiers:** 1–9 Noobie, 10–24 Apprentice, 25–49 Builder, 50–69 Intermediate, 70–84 Advanced,
  85–98 Pro, 99 Master.
- **Stars** = `floor((active_s − 9,000,000) / 900,000)` once `active_s ≥ 9,000,000`; one per
  250 h past 99.
- **Total level** = the sum of levels over tools that have one. **Max Cape** = every detected
  agent tool at 99. Both are computed by the reader from `agent_progress` rows, as a sum and
  a count; no threshold lives outside `rollup.sh`.
- **Retired:** the 5,000 h ladder and `xp = active×100 + total×20 + hygiene×5 + sessions×2`.
  Session count no longer earns anything.

## 5. Pages

**Nav.** The tool row's inert Overview, Codex and Hermes (`INERT_NAV`, "Stage 5") become real
links: `/overview`, `/codex`, `/hermes`. All three are ranged. They go into `STATIC_VIEWS` and
`watchtower report` through `lib/views.ts`.

**The level card** (`lib/render/level.ts`) is one component for all three tools. It shows:
- Lv and tier;
- an XP bar to the next level;
- XP in OSRS style ("1.52M XP");
- hours to the next level;
- stars past 99.

It replaces the rank ladder (`lib/render/ladder.ts`) on Live and History.

**Overview** (`lib/read/overview.ts`, `lib/render/overview.ts`):
- A card per detected tool: level card, active hours in range, driven and automated sessions,
  requests, tokens and cost.
- Daily active hours stacked by tool.
- Total level and Max Cape progress.
- Cost, two bases kept apart: "at API prices" sums Claude and Codex (with "N not priced"
  where it applies), and Hermes's figure sits beside it, never inside it.
- The OpenViking card, captioned "memory — not counted in totals".

**Codex and Hermes** share one reader and renderer pair (`lib/read/agent.ts`,
`lib/render/agent.ts`). Each page has:
- the level card;
- daily hours and tokens;
- Models: requests, cost and share, plus not-priced counts;
- Projects: hours and tokens;
- Sessions: entry point, driven/automated/unclassified, start → end, requests, tokens, cost.

The Codex page also lists unclassified originators with the config key that assigns them.
On the Hermes page the cost column reads "Hermes's figure", and sessions group by entry
point.

**Claude's Sessions page** gains one line on sessions Atlas knows: "Atlas: N checkpoints ·
M files touched".

Every cost string goes through `lib/render/cost.ts`, extended with "Hermes's figure" and
"Hermes didn't price this". Order statistics come from `lib/read/perf.ts`. Readers parse
and label; they compute no hour, price or level.

**When there is nothing to measure** (a missing measurement is never shown as zero):

| Situation | The page says |
|---|---|
| Tool not installed | No Overview card. Its page names where Watchtower looked. It is outside Total level and Max Cape. |
| Installed, never synced | "Not synced yet — open the dashboard or run `watchtower sync`." No zeros. |
| A sync of one tool failed | The other tools are unaffected. The page says "data as of ‹last ok sync›", and Sources shows the tool as degraded. |
| Malformed lines | Skipped and counted in `wt_ingest_state.malformed`; never zero-filled. |
| No driven hours | "No driven hours yet." No level. |
| Automated activity only | Tokens and cost are shown, marked "automated only", with no hours. |
| Codex model without a rate | "not priced"; a partial sum says "N not priced"; an empty range says "no requests". |
| Hermes `cost_status` unknown | "Hermes didn't price this". |
| OpenViking down | "Unreachable at last sync (time)", with the last known recall and capture and their age. With no state files: "no OpenViking on this machine". |
| Session Atlas doesn't know | No Atlas line. |
| Codex log deleted or archived | History survives. Codex and Hermes `wt_*` rows are durable: sync upserts and never deletes. |

Days are bucketed by local day, as Claude's are.

## 6. Tests and proof

### 6.1 Fixtures and guards

Fixtures go through the real paths:
- `tests/fixtures/make-codex-logs.sh` builds rollouts covering both usage formats, a resumed
  session in a later date folder, the archive folder, a partial last line, and driven,
  automated and unknown originators;
- `make-hermes-db.sh` builds a `state.db` with the real column set, through `lib.sh`'s own
  encoders.

Each guard is planted and must turn **exactly one** test red:

1. Summing Codex `total_token_usage` instead of taking distinct deltas.
2. Counting `cached_input_tokens` inside `tokens_in`.
3. Adding reasoning tokens to `tokens_out` a second time.
4. An automated or unclassified session earning hours.
5. An unpriced Codex model costing $0.
6. Hermes's figure entering "at API prices".
7. A level threshold off by one (`xp(92)` must be 6,517,253).
8. A wrong star count past 99.
9. A deleted Codex log deleting `wt_*` rows.
10. Any `content`, `reasoning` or memory field selected by an adapter.
11. The agent gap rule drifting from Claude's.

The existing guards stay green: `MIN(gap,` only in `rollup.sh`, no rate under `lib/`, the
schema version pinned in both places, and the report's per-week budget, which gains rows for
the three new pages.

### 6.2 Live proof (by hand)

Run on a `.backup` copy of the live DB in its own directory, with `~/.codex` and
`~/.hermes` read in place, read-only. Results are recorded in `SESSION.md`.

1. **First, measure.** Time a cold and a warm `watchtower sync`. If warm is well over 2 s, fix
   the file cursor before any page is built. While at it, record every originator across
   all 129 Codex files, not just those since September.
2. **Independently,** a `jq` pass over the logs gives per-day Codex tokens, which must equal
   `agent_daily_rollups`. `state.db`'s per-session token columns must equal the projected
   rows.
3. **Claude:** per-day `active_s` must be byte-identical to `main`'s rollup on the same copy,
   and `agent_progress.level` for Claude must equal the formula on those hours.
4. **The Codex price check:** five requests hand-priced from the cited rates.

## 7. TheOneOS lockstep and rollout

- TheOneOS's Hours panel takes its level from `agent_progress` (`source = 'claude'`) and does
  no rank math. `lib/claude-hours/ranks.ts` and `CLAUDE_RANKS` retire, and `build.ts:326`
  stops calling `rankForHours`.
- A Watchtower proof, `tests/fixtures/theone-level-proof.mjs`, modelled on
  `theone-watch-proof.mjs`, shows that the panel's level, tier and to-next equal
  `agent_progress`, and that the rest of the Hours payload is deep-equal to `main`'s.
- **Order:** the Watchtower PR merges first, then TheOneOS. `claude_rank_progress` is still
  written in between, so nothing on TheOneOS `main` breaks. The user runs the live
  `install.sh` (`CC_SCHEMA_VERSION` 7) and both merges.

## 8. Task shape

Subagent-driven, one branch per repo. Review is sized to risk (one final whole-branch review,
one fix wave). Roughly:

1. Measurement spike (§6.2 step 1). It gates the cursor design.
2. Codex adapter.
3. Hermes adapter.
4. OpenViking and Atlas light touch.
5. Rollup section: hours, prices, levels, `lib.sh` v7.
6. Level card, replacing the ladder.
7. Overview.
8. Codex and Hermes pages.
9. Proofs, SESSION.md.
10. TheOneOS lockstep.

The plan fixes the exact split.

## 9. Not in Stage 5

- Atlas as a full adapter: commits, git provenance beyond counts, Atlas sessions in their own
  right.
- OpenViking beyond `/health` and the plugin's state files: server metrics, memory counts per
  agent, anything authenticated.
- A weekly or seasonal rating, rested XP, or any catch-up bonus.
- A Usage Profile (discipline scores) for Codex or Hermes.
- Re-pricing Hermes, or pricing Codex service tiers differently from standard.
- An always-on sync timer (still Stage 9, piece 2).
- Removing `claude_rank_progress`.
- TheOneOS's Codex Watch and Hermes Watch tabs.

## 10. Review focus

The inputs most likely to bite that no task's happy path exercises:

1. A Codex session **resumed days later** in another date folder. One session, hours only
   from real activity, and the gap across the resume counts 0.
2. A rollout file **being written during sync**. Its partial last line is skipped, not
   counted as malformed, and read whole next time.
3. A session **spanning local midnight**. Hours split by local day, the way Claude's do. So do
   Codex tokens, each record carrying its own timestamp. Hermes tokens land on the start
   day (§3.3).
4. Hermes's `state.db` **mid-write** (WAL). The read-only open waits on the busy timeout and,
   if it fails, marks Hermes degraded without touching other tools.
5. The same `response_id` in two files (a forked or copied session). One row; the first
   arrival's session wins, mirroring `claude_requests.session_id`'s rule.
