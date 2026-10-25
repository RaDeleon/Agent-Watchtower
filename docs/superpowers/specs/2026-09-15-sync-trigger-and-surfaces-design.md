# Sync trigger and surfaces — design

**Date:** 2026-09-15
**Status:** approved, not yet implemented
**Amends:** `2026-09-14-stage-3-source-agnostic-architecture.md` §4,
`2026-09-14-stage-3-spec.md` §3B

---

## 0. The gap this closes

Neither the Stage 3 spec nor the architecture says **when the projection runs.**
Both are emphatic that `capture/*.sh` do not change, which means nothing on the
hook path invokes the adapter — and nothing else invokes it either. Stage 3B
would have shipped a projection with no caller.

Searched both documents for a trigger on 2026-09-15: no `sync`, no `refresh`, no
`cron`, no "on demand". The omission was total, not partial.

---

## 1. A premise that was already true

The question arrived as *"it should run automatically — I used to have to type
`cc` to launch the tracked version of Claude Code."*

**That stopped being true at Stage 2.** Measured 2026-09-12 and recorded in
`SESSION.md`: of 297 sessions in the preceding 30 days only **78 carried a
`launch_id`** — roughly 74% were launched without the wrapper — and **all 297
were tracked**, with hours, tokens and project attribution intact. The hooks fire
regardless of launch method, and `SessionEnd` already chains hook + ingest +
rollup itself. `cc` now contributes only `launch_id` correlation, `THEONE_PROFILE`
and launcher wall-clock bounds.

Capture is already automatic. Nothing in this design is needed to make it so.

---

## 2. Why timing affects freshness and never completeness

Every adapter is a **pull over a durable artifact**:

| Source | Artifact | Durability |
|---|---|---|
| Claude | `claude_*` tables | written continuously by hooks; `claude_requests` is durable by invariant |
| Codex | `~/.codex/sessions/*.jsonl` | **not pruned** — 96 files, 2025-08-30 → 2026-09-13, measured 2026-09-14 |
| Atlas | `<repo>/.atlas/sessions.db` | lives inside each repo |
| Hermes | `~/.hermes/state.db` | local database |

Nothing is lost by syncing late. A sync that has not run yet is a **stale cache,
never a gap in history** — so there is no correctness argument for a daemon, only
a convenience one. That is the fact the whole design rests on, and it is why the
cheapest trigger is also the correct one.

The one source this does **not** hold for is a hypothetical HTTP-only source
whose telemetry is a live gauge rather than a log. OpenViking's `/metrics` is
exactly that shape. Stage 6 is already gated on being able to probe it; when it
is designed, it must answer sampling separately. **Do not generalize this
section to it.**

---

## 3. The trigger model

**One command, three callers, zero hook changes.**

`watchtower sync` projects every enabled source into `wt_*`. It reads every
source in full and writes only records whose fingerprint changed (see §5,
"Fixed 2026-09-16"), is idempotent (`MAX`-per-field upserts on a `request_id`
primary key, already proven in `ingest.sh`), and safe to run concurrently with
anything, because it only reads source truth and only writes normalized rows.

| Caller | When | Ships in |
|---|---|---|
| `watchtower sync`, by hand | whenever you like | **3B** |
| The dashboard, on start | before the first byte is served | **3C** |
| The dashboard, on its poll interval | while a tab is open; `dashboard.pollSeconds`, already in config | **3C** |

The capture path is untouched. `hook.sh`, `snapshot.sh`, `ingest.sh`,
`rollup.sh`, `lib.sh` and the `SessionEnd` chain stay exactly as they are.

---

## 4. Rejected: a `SessionEnd` heartbeat

The first recommendation was to append a node-guarded
`watchtower sync --quiet || true` to the `SessionEnd` chain, in the same idiom
every capture script already uses for a missing `jq` or `sqlite3`.

**Rejected on 2026-09-15, after the freshness question was answered.** The chosen
behaviour is *current when you open it* plus *live while it is open*. Under that,
the heartbeat refreshes a cache with no reader: nothing consumes `wt_*` between
sessions, and opening the dashboard syncs anyway. It would have cost:

- a Node process spawned at every session end, on a path whose entire design
  principle is that it must never break Claude Code;
- an edit to `install.sh` and therefore a rewrite of the live `settings.json` —
  the same risk class the `capture/claude/` directory move was deferred over;
- the falsification of the architecture's own promise, *"the bash capture path
  does not change. At all."*

Only a genuinely always-on requirement would have justified it, and even that is
better served by a timer calling the same command than by a hook. Keeping the
capture path untouched is worth more than the freshness it would have bought.

---

## 5. The measurement Stage 3B must take

**Steady-state incremental sync latency, measured, not assumed.**

The first sync projects the full archive — 27,165 requests as of 2026-09-12 — and
will not be instant. That is a one-time cost and is not the number that matters.
The number that matters is the second run, with the cursor warm and a handful of
new requests.

- If it is fast, sync-on-open is invisible and §6's piece 3 never earns its place.
- If it is slow, that is the evidence that reopens always-on, and the argument is
  settled by a measurement rather than by preference.

This is a required output of Stage 3B, recorded in its plan as a task, not a
footnote.

### Measured 2026-09-15

**Cold run** (fresh `wt_*` tables, copy of the live archive): **857s**, 44,515
records ingested, 27,165 `claude_requests` projected.

**Steady-state runs** (same copy, `wt_requests` already full, run immediately
after the cold run with no new source data): two consecutive runs against
`/tmp/wt-latency/copy.sqlite`, timed with `time WATCHTOWER_DB_PATH=... node
bin/watchtower sync`:

| run | wall clock | records ingested |
|---|---|---|
| cold | 857s | 44,515 |
| steady-state #1 | 853.43s (14m13.43s) | 44,515 |
| steady-state #2 | 852.45s (14m12.45s) | 44,515 |

`claude_requests` and `wt_requests` both held at 27,165 across all three runs
(the upsert is idempotent — no row growth — but the row *count* is not what
was timed; the full re-derivation is).

**`runSync` is not incremental.** `lib/core/sync.ts` calls
`adapter.ingest()` with no cursor argument, and `createClaudeAdapter`'s
`ingest()` (`lib/adapters/claude/index.ts`) takes no cursor parameter at all —
every call unconditionally re-projects all of `claude_requests`, sessions,
tools, and events from scratch. `wt_ingest_state.cursor` is queried by
`readIngestState` but is never written by `ingestRecords`'s upsert (the
column is absent from both the `INSERT` column list and the `ON CONFLICT`
clause in `lib/core/ingest.ts`) and never fed back into the adapter, so it
stays `NULL` forever. The docstring in `sync.ts` calling `runSync` "incremental"
describes an aspiration, not the current implementation. The near-identical
cost of the cold run and both steady-state runs (857s vs. 853s vs. 852s) is
exactly what that reading of the code predicts: steady state does the same
work as a cold start because there is no cursor-filtered path to take instead.

**Verdict:** steady-state sync costs ~852-853 seconds with nothing new to
project — statistically indistinguishable from the 857-second cold run —
so sync-on-open cannot be adopted as designed, and §6 Piece 2's opt-in
always-on background timer is not answered by this measurement either, since
an unbounded per-tick cost of ~14 minutes rules out *any* timer interval
short enough to be useful without incremental ingestion first.

---

### Fixed 2026-09-16

The 14 minutes had two causes, and both are fixed.

1. **Process launches, not data.** Ingest started a `sqlite3` process for every
   metric's authority check (4 per request), every session lookup, and every
   write. Writes now go in batches of 500 records per `sqlite3` call, in one
   transaction. The authority registry is read once per run, and links once per
   chunk.
2. **No skipping.** A cursor was rejected: Claude's rows change in place
   (`ingest.sh` raises token counts on an existing `request_id`, `rollup.sh`
   resolves a project path later), and a "rows since last time" cursor misses
   both. Instead every written record stores a fingerprint in
   `wt_record_fingerprints` (record + resolved canonical id + accepted metrics),
   and an unchanged record is skipped.

Measured on a `.backup` copy of the live database (27,165 requests, 44,565
records):

| run | before | after |
|---|---|---|
| cold (empty `wt_*`) | 857s (951s re-run 2026-09-16) | **2.9s** |
| nothing new | 852s | **1.4s** |
| 4 days of new data (1,932 new or changed records) | — | **1.6s** |

Output matches the old code exactly: the whole `wt_*` projection from a cold
run of each version was compared table by table (canonical ids compared through
the session they link to, sync-time timestamps excluded), with zero rows
different.

**Verdict, revised:** sync-on-open and a poll interval are both viable as
designed. The remaining cost is reading the source in full, which grows with the
archive at roughly 1.4s per 27k requests.

---

## 6. Deferred — Stage 9: onboarding, always-on sync, and the TUI launcher

Placed after the existing staging table so nothing renumbers. Each piece carries
the evidence that unblocks it.

### Piece 1 — installer onboarding

`install.sh` gains setup questions. Hard constraints, all of them load-bearing:

- **Non-TTY falls through.** `tests/install.test.ts` drives the installer
  non-interactively; an installer that blocks on a prompt hangs the suite and any
  scripted install. A `--yes` flag skips every question explicitly.
- **Every default equals today's behaviour.** An existing user who presses Enter
  through the whole thing gets precisely the install they already have.
- **The Stage 2 dry-run gate applies.** Seed a temp `CLAUDE_DIR` from the live
  config, diff `settings.json`, confirm the predicted delta byte for byte before
  any real run. That procedure has caught real hook-deletion bugs twice.

**Sequencing:** most of onboarding wants to land **after Stage 5**. A question
reading *"we detected Codex — enable it?"* is meaningless before the Codex
adapter exists.

### Piece 2 — opt-in always-on sync

A launchd agent running `watchtower sync --quiet` on an interval. **A timer, not
a server**; the dashboard's HTTP server still runs only while you are looking at
it. Overlapping runs are harmless because sync is idempotent. Default **off**,
surfaced as one installer question.

**macOS only.** That is what this machine runs; a Linux equivalent is a systemd
user timer and will not be written blind.

**Gate: §5's measurement.** If steady-state sync is fast, this ships nothing.

### Piece 3 — the TUI launcher

The architecture already splits `lib/read/*` (source-aware readers) from
`lib/render/*` (**pure data → string**). That second boundary is TUI-shaped: a
terminal launcher is a second renderer over the same readers, not a second
dashboard.

Scope, deliberately thin: sources and their detected/connected status, last sync
and cursor position, start/stop the dashboard, run a sync, surface errors. Plain
ANSI escapes and `node:readline` — **no dependency**, consistent with the repo
shipping zero.

**Gate: build after 3C, and only if that boundary held.** If 3C leaks reads into
HTML generation, the TUI costs a second implementation of the same queries and is
dropped rather than paid for twice.

### The guard that matters most

**No piece of Stage 9 ships without a numbered task in its stage's plan.**

Divergence 2 (the `sources` config stanza) and divergence 6 (the fresh-install
database path) were both *a spec section with no task behind it* — described in
binding prose, implemented by nobody, and invisible until the implementation was
diffed against the source conversation rather than against the documents.
Recording Stage 9 without this line would be committing the same error a third
time, in the document that names it.

---

## 7. Decisions — answered 2026-09-15, do not re-ask

| # | Question | Answer |
|---|---|---|
| 1 | When does the projection run? | On demand via `watchtower sync`; the dashboard calls it on start and on its poll interval. |
| 2 | Does anything run between sessions? | No. Not by default, and not at all unless Stage 9 piece 2 is both built and enabled. |
| 3 | Does the capture path change? | **No.** This is the reason the heartbeat was rejected. |
| 4 | Is a background daemon needed for correctness? | No. Every adapter pulls from a durable artifact; late sync is stale, never lossy. |
| 5 | Always-on? | Opt-in only, default off, gated on §5's measurement. |
| 6 | TUI? | After 3C, gated on the `read`/`render` split holding. Thin launcher, not a second dashboard. |
| 7 | Is `cc` needed for automatic tracking? | No — and it has not been since Stage 2. Measured: 74% of sessions launch without it and all are tracked. |

---

## 8. Amendment to the architecture document

§4's sentence *"nothing on the hook path is touched by Stage 3 at all"* survives
this design intact — rejecting the heartbeat is what preserves it.

It is nonetheless **already inaccurate by one commit.** `0c6e00d` changed
`capture/lib.sh`'s `cc_db_path` so the writer resolves the database where the
reader reads it, after `WATCHTOWER_DB_PATH` shipped to `lib/config.ts` alone.
That edit is path resolution, not the activity model, and the live path was
verified unchanged on both sides — but the sentence should read *"nothing on the
hook path is touched by Stage 3 except database path resolution, which both
halves must agree on."*
