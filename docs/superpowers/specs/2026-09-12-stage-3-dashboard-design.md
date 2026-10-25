# Stage 3 — Standalone Watchtower dashboard

**Date:** 2026-09-14
**Status:** SUPERSEDED 2026-09-14 by
`2026-09-14-stage-3-source-agnostic-architecture.md`. Watchtower is being
reframed as a source-agnostic observability platform with Claude Code as adapter
#1, so this document's §3 architecture and §8 staging no longer apply.

**What survives, and is deliberately not rewritten:** the stat inventory, the
chart primitives (§6), the honesty rules in §5 and §7 — the rate-limit
NULL/>100% handling, the snapshot-cumulative rule, the hygiene-zero line break —
and the six mutation checks in §9. Those are source-agnostic concerns and carry
forward into Stage 3C intact. Read this file for those; read the architecture
proposal for where they now sit.
**Branch:** `stage-3-spec`, stacked on `chore/drop-ccflare-residue`
**Supersedes nothing.** Implements the approved sections of
`2026-09-12-stage-3-dashboard-brainstorm.md`, whose nine decisions are binding
inputs here and are not re-litigated.

---

## 1. Purpose and scope

Watchtower captures and derives; it ships no UI. This stage gives it one: a
local, zero-dependency dashboard over the data already in
`~/.theone/claude-code-usage.sqlite`.

**In scope for Stage 3:** the read layer, the HTTP server, the chart primitives,
and four Claude Code views — Live, History, Projects, Skills & Models.

**Deferred by decision, not oversight:**

| Deferred | To | Why |
|---|---|---|
| The ten disciplines, 6-tier ladder, Usage Profile view | Stage 4 | Needs schema v5 and new `rollup.sh` derivations. Several disciplines have no defined inputs yet. |
| Codex ingest, Codex Watch, cross-tool Overview | Stage 5 | With only Claude Code, Overview is a degenerate single-column rollup. Measured 2026-09-14: Codex logs are not pruned, so waiting costs no history. |
| Hermes Watch | Backlog | Cheap once Codex exists. |

Hygiene stays the existing 0–100 `hygiene_score` in Stage 3. It becomes one
input to the ten disciplines in Stage 4; it does not change here.

### The one-sentence constraint

**The dashboard is a reader.** It adds no table, no column, no schema version,
and no derivation. If a number cannot be read or trivially grouped from what
`rollup.sh` and `ingest.sh` already wrote, it is out of scope for Stage 3 and
belongs in Stage 4's rollup work.

---

## 2. Why this cannot drift into model math

CLAUDE.md: *"The activity model lives in `capture/rollup.sh` and nowhere else.
No model math in TypeScript, ever — grouping and labelling only."*
`tests/capture-scripts.test.ts` fails the build if `MIN(gap,` appears outside
`rollup.sh`.

That guard currently lists `lib/projects.ts` as a carrier. **Stage 3 adds
`lib/read/**` and `lib/render/**` to the same carriers list** — this is a
required change, not an optional one. A dashboard is exactly the place where
"just compute the gap here, it's only for display" becomes tempting.

The division:

- `rollup.sh` — derives. Gaps, caps, activity, hygiene, ranks.
- `lib/read/*` — `SELECT`, `SUM`, `MAX`, `GROUP BY`, unit conversion (ms → hours),
  and nothing else. Same shape as `lib/projects.ts` today.
- `lib/render/*` — pure `data → string`. No I/O, no `Date.now()`, no DB handle.

`SUM` and `MAX` over pre-derived columns are grouping. Recomputing a session
window from timestamps is model math. The line is whether `rollup.sh` already
answered the question.

---

## 3. Architecture

```
~/.theone/claude-code-usage.sqlite
            │
            ▼
   lib/read/*.ts        one module per view; execFileSync("sqlite3","-json") → plain objects
            │
            ▼
   lib/render/*.ts      pure functions: data → HTML/SVG string
            │
            ▼
   bin/watchtower       serve (node:http, 127.0.0.1) │ report (static file)
```

### Zero runtime dependencies holds

- Reads: `execFileSync("sqlite3", ["-json", dbPath, sql])` — the exact pattern
  `lib/projects.ts:42` already uses. `jq` and `sqlite3` are already hard
  requirements of this repo.
- Server: `node:http`. **Binds `127.0.0.1` explicitly** — never `0.0.0.0`.
- Charts: hand-written inline SVG. No charting library, no framework, no build.
- `package.json` gains no `dependencies` block. A test asserts this.

### Two entry points, one renderer

`serve` and `report` call the *same* read and render functions. `report` writes
a single self-contained HTML file with the live-polling script omitted; `serve`
adds JSON routes and the poller. This is what stops the static export from
quietly rotting — it is not a second implementation.

---

## 4. Routes

| Route | Returns |
|---|---|
| `GET /` | Live view, full HTML |
| `GET /history` · `/projects` · `/skills` | Full HTML |
| `GET /api/live` | JSON — the only route the page polls |
| `GET /api/health` | `{ ok, dbPath, schemaVersion, lastRollup }` |

Only `/api/live` is polled (default 5s, configurable). The other views are
server-rendered on request; they describe days, not seconds, and polling them
would be waste.

**Unknown route → 404 with a plain-text body.** No catch-all rendering.

---

## 5. Read modules

One module per view, each exporting typed row readers.

```
lib/read/live.ts        rate limits, current session, today's totals, event ticker
lib/read/history.ts     calendar heatmap, hour×weekday, rank, hygiene trend, daily bars
lib/read/projects.ts    re-exports lib/projects.ts, adds per-branch and lines
lib/read/skills.ts      skill/MCP/plugin leaderboards, model mix, cache, API errors
```

`lib/projects.ts` stays where it is and keeps its current signature. Stage 3
wraps it; it does not move or rewrite it.

### The snapshot trap, restated as a rule

`claude_status_snapshots` columns are **cumulative per session**. Summing
`total_lines_added` across rows gives 80,885,856 against a true 287,125 — a
**281.7× overcount**, the same bug class as the token defect Stage 2 fixed.

**Rule: every read of `claude_status_snapshots` groups by `session_id` and takes
`MAX`, never `SUM` across rows.** This applies to `total_lines_added`,
`total_lines_removed`, `total_cost_usd`, `total_duration_ms`,
`total_api_duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`
and `cache_creation_tokens`.

**Tokens are never read from snapshots at all** (CLAUDE.md invariant) — they
come from `claude_requests`. The snapshot token columns are listed above only so
that a future reader who does touch them does the right thing.

### Rate limits are the exception, and need their own rule

`five_hour_rate_limit_used_percentage` and
`seven_day_rate_limit_used_percentage` are **instantaneous gauge readings**, not
cumulative counters. So:

- **Live gauge** → the single most recent non-NULL reading, by `ts`.
- **Historical peak** → `MAX` per day.

Both happen to use "not SUM", but for opposite reasons, and a reader who
pattern-matches on the cumulative rule will get the live gauge wrong. Measured
2026-09-14:

| | value |
|---|---|
| snapshots total | 68,396 |
| with a 5h reading | 51,041 (**74.6%**) |
| with a 7d reading | 62,086 (90.8%) |
| all-time peak 5h | **108.0%** (2026-09-04) |

Two consequences the implementation must honour:

1. **NULL is common — one snapshot in four has no 5h reading.** CLAUDE.md: *"Do
   not assert a measurement where there is none."* A NULL renders as an explicit
   "no reading" state, **never as 0%**. A 0% gauge is a lie that reads as good news.
2. **Readings exceed 100% and must not be clamped.** 108% is real data. Clamping
   to 100 hides precisely the moment the gauge exists to show. The arc saturates
   at full sweep; the numeric label prints the true value.

---

## 6. Chart primitives

Eight pure `data → string` SVG functions in `lib/render/charts.ts`:

`areaChart` · `stackedBar` · `donut` · `calendarHeatmap` · `hourWeekdayHeatmap` ·
`progressRing` · `sparkline` · `dayBars`

Each is deterministic — same input, same string, byte for byte — which is what
makes them snapshot-testable. No `Date.now()`, no `Math.random()`, no locale-
dependent formatting inside a primitive; the caller passes formatted labels.

**Empty input renders an empty-state, not a broken axis.** A 77-day heatmap on a
fresh install with 3 days of data must look deliberate.

---

## 7. Views

### Live (`/`)
Rate-limit gauges 5h and 7d (§5 rules apply) · current session elapsed, cost,
context %, burn rate tokens/min · today's active hours, sessions, hygiene ·
event ticker, last ~20 `claude_events`.

*The ticker is kept by standing instruction and is on the backlog to reconsider —
it is mostly SessionStart/SessionEnd noise.*

### History (`/history`)
Calendar heatmap of active hours · hour-of-day × day-of-week heatmap · rank
progress ring + streak · hygiene trend with its four components broken out ·
daily active-vs-idle bars · cumulative cost · weekday habit bars · coverage
(days / since / sessions) · XP to next rank · the Matrix rank ladder.

Hygiene's components are broken out **because a bare score is unactionable** —
a dip has to be explainable. Verified against `rollup.sh`, the four terms are
cache 25 · context 30 · compact-vs-clear 25 · focus/idle 20.

Two behaviours the trend line must not flatten:

- A day with NULL `cache_hit_percentage` rescales against the maximum it could
  actually attain — **75** normally, **65** when `total_session_ms = 0`
  (`rollup.sh:575`). The view must show *which* denominator applied, or it
  reports a rescaled day as comparable to a full one.
- **`hygiene_score` is set to 0 when `sessions_count = 0`** (`rollup.sh:584`),
  and `claude_rank_progress` averages it as `AVG(NULLIF(hygiene_score,0))` —
  i.e. zero days are *excluded*, not counted as bad. A trend chart that plots
  those zeros draws cliffs that do not exist. **The chart must break the line on
  a zero-session day, not draw it to the floor.** This is the same class of
  error as asserting a measurement where there is none.

### Projects (`/projects`)
Ranked table incl. **$ per active hour** · per-project sparklines · **per-branch
token attribution** (`git_branch` populated on all 27,165 requests) · lines
added/removed · repos donut 30d.

`(excluded)` stays hidden at read time, per the existing invariant.

### Skills & Models (`/skills`)
Skill leaderboard · MCP server and plugin attribution · subagent vs main thread ·
model mix over time · model donut 30d · cache hit rate · API errors · **fresh vs
cache vs total** token framing · model performance table · per-session table ·
terminal breakdown · effort distribution.

*Effort distribution is kept by standing instruction and is on the backlog — it
is only 58% populated, so it renders a large "unknown" slice. That slice must be
labelled "not recorded", not folded into a category.*

**Aggregate `claude_requests` directly.** Never join through `claude_sessions`:
22.4% of requests predate the tracker and have no session row, and the join
drops them silently.

---

## 8. Implementation order

**Task 1 is a walking skeleton, by decision 8.** The rate-limit gauge end to
end — one read module, one primitive (`progressRing`), one HTML route, one JSON
route, one e2e test — before the other seven primitives exist. It proves
`sqlite3 -json` → read → render → `node:http` as a whole, on the most actionable
widget on the page, and it is the primitive with the most interesting edge cases
(NULL, >100%) so the honesty rules get exercised at task 1 rather than task 9.

| # | Task |
|---|---|
| 1 | Walking skeleton: `bin/watchtower serve`, `lib/read/live.ts` rate limits, `progressRing`, `/` + `/api/live`, e2e test |
| 2 | Remaining seven chart primitives + snapshot tests |
| 3 | Rest of Live: session, today, ticker |
| 4 | History view |
| 5 | Projects view |
| 6 | Skills & Models view |
| 7 | `bin/watchtower report` static export |
| 8 | Guard-test update: add `lib/read/**` and `lib/render/**` to carriers; assert no runtime deps |

Task 8 last is deliberate — it must run against the finished surface. If it
passes trivially because nothing it guards exists yet, the guard is decoration.

---

## 9. Testing

Per CLAUDE.md: *"A guard is not done until its defect has been planted and
watched turn exactly one test red."*

- **Read modules** — fixture DBs via `tests/helpers/fixture-db.ts`, `TZ=UTC` pinned.
- **Renderers** — pure, snapshot-tested. Empty input is a named case, not an afterthought.
- **End-to-end** — boot the server on an ephemeral port (`:0`), fetch every route,
  assert JSON shape and HTTP status. No browser automation.

### Mutation checks that must be planted and watched fail

1. `SUM` a snapshot counter instead of `MAX`-per-session → the 281.7× overcount test goes red.
2. Coalesce a NULL rate limit to `0` → the "no reading" test goes red.
3. Clamp a rate limit to 100 → the 108% test goes red.
4. Join requests through `claude_sessions` → a count drops by ~22.4% and goes red.
5. Put `MIN(gap,` in a render module → the carriers guard goes red.
6. Bind the server to `0.0.0.0` → the bind test goes red.

Each is a real defect this repo has either already shipped or is one careless
line away from. Planting each is part of the task that adds the guard.

---

## 10. Config

Three optional keys, all defaulted, loud on bad input, matching `lib/config.ts`
conventions:

```jsonc
"dashboard": {
  "port": 4317,          // 0 = ephemeral
  "host": "127.0.0.1",   // validated: loopback only
  "pollSeconds": 5
}
```

`host` rejects any non-loopback value with a clear error. Watchtower reads a
database of what you typed into every repo you own; binding it to a LAN
interface is not a knob worth shipping.

`WATCHTOWER_DASHBOARD_PORT` overrides the port, matching the existing
`THEONE_DB_PATH` precedent.

---

## 11. What this does not do

- **No writes.** The dashboard opens the DB read-only. It never runs `rollup.sh`;
  a stale page is correct behaviour when the rollup has not run.
- **No schema change.** Still v4. Stage 4 bumps to v5, in both declared places.
- **No auth, no TLS, no multi-user.** Loopback only.
- **No ccflare, no proxy, in any stage.** Decision 9.
- **No install.sh changes.** The dashboard is run from the repo; it is not
  installed into `~/.claude`. Nothing on the hook path changes, so the
  "a tracker must never break Claude Code" invariant is untouched by this stage.

---

## 12. Open items

1. **Burn rate needs a defined window.** Tokens/min over what — the last 5
   minutes, the session, the last N requests? Left open deliberately; the plan
   must pick one and say why. A burn rate over a whole session is a flat line by
   the end and useless as a live widget.
2. **The ticker's polling story.** `/api/live` returns the last ~20 events each
   poll. Fine at 5s; revisit if the ticker survives its backlog review.
3. **`report` and the live widgets.** A static export has no rate limits worth
   showing. It should omit the Live view rather than render a frozen gauge —
   confirm before implementing.
4. **Streak has no stored column — this needs a ruling before task 4.**
   The brainstorm cites "longest 24 days", but `claude_rank_progress` carries
   `total_hours, active_hours, lifetime_cost_usd, lifetime_tokens_in,
   lifetime_tokens_out, sessions_count, rank_index, rank_name, hours_into_rank,
   hours_to_next, next_rank_name, xp, hygiene_score, updated_at` — **no streak**.
   That figure was computed ad hoc during the brainstorm, not read.

   So streak is a *derivation over consecutive day rows*, and §2's line has to be
   drawn deliberately. Two options, and the plan must pick one with an argument:
   (a) compute it in `lib/read/history.ts`, arguing that sequencing
   already-derived day rows is grouping rather than activity-model math; or
   (b) add `current_streak` / `longest_streak` to `rollup.sh`, which is
   consistent with decision 7's reasoning that scoring is derivation — at the
   cost of dragging a schema bump into Stage 3, which §1 and §11 otherwise
   forbid. **My recommendation is (a)**, with the streak logic isolated in one
   named function so Stage 4 can move it into `rollup.sh` alongside the
   disciplines if the boundary proves wrong.
