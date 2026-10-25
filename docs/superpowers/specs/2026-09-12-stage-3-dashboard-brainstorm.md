# Stage 3 — standalone Watchtower dashboard (brainstorm, ALL SECTIONS APPROVED)

**Status: all three sections APPROVED, 2026-09-14 (session 7).** The gate is closed.
The next step is to write the real spec at
`docs/superpowers/specs/2026-09-12-stage-3-dashboard-design.md`, self-review it, and
put it to the user — then, and only then, `writing-plans`.

Branch: `stage-3-dashboard-brainstorm`, from `main` @ `5193ffa`.

---

## Decisions already made — do not re-ask

Each of these was an explicit answer to a multiple-choice question.

| # | Question | Decision |
|---|---|---|
| 1 | Primary job of the dashboard | **All three, one surface** — Live + Retrospective + Daily check-in, multiple views, shared read layer |
| 2 | Form factor | **Generated HTML**, self-contained, inline SVG charts, no framework |
| 3 | Liveness | **Local server** (`node:http`, still zero deps), page polls JSON every few seconds |
| 4 | Overview tab | **Cross-tool rollup of what Watchtower can actually see** — not TheOneOS's subscription/Agency/in-app aggregation |
| 5 | Hermes Watch | **Backlog, after Codex** |
| 6 | Scoring model | **Port the ten disciplines**; the existing 0–100 `hygiene_score` becomes one input |
| 7 | Where the ten disciplines are computed | **In `rollup.sh`, schema v5** — scoring is derivation, not labelling. TypeScript reads and formats only. *(2026-09-14)* |
| 8 | Build order | **Stage 3 as specced**, with the rate-limit gauge as its first task — a walking skeleton proving read → render → serve end to end before the other seven primitives. Codex stays Stage 5. *(2026-09-14)* |
| 9 | ccflare | **Not part of this project, in any stage.** The dead `proxy` config stanza, its tests and its example-config entry were deleted 2026-09-14; the Stage 0 design doc's proxy sections are marked superseded. The user has separate plans for ccflare elsewhere. Do not propose a proxy integration. *(2026-09-14)* |

Standing instruction from the user: keep the live event ticker and the effort
distribution **for now**, but record both in the backlog to reconsider later.

Preference stated in the user's own words: *"I want some cool shit in this
dashboard and useful stats."* Codex matters — *"I will be using codex a lot
more now"* — so Codex Watch is **priority backlog**, not someday.

---

## Section 1 — stat inventory (APPROVED)

Every figure below was computed against the real database during the brainstorm,
so this is a list of things that demonstrably work, not candidates.

**Live** *(polls ~5s)*
- Rate-limit gauges, 5h and 7d. Measured: peak **108%**, hit 100% on 3 days,
  80–100% on 4 more, and **21 requests returned HTTP 429**. The most actionable
  widget on the page.
- Current session: elapsed, cost, context %, **burn rate (tokens/min)**
- Today: active hours, sessions, hygiene
- Live event ticker — last ~20 hook events *(kept for now; backlog to revisit —
  it is mostly SessionStart/SessionEnd noise)*

**History**
- Calendar heatmap, GitHub-style, of active hours (77 days of coverage)
- Hour-of-day × day-of-week heatmap. Measured shape: peak at **23:00** (151
  prompts), strong midday at 12:00/14:00, a spike at 00:00
- Rank progress + streak (**longest 24 days**)
- Hygiene trend with its four components broken out, so a dip is explainable
- Daily active-vs-idle bars; cumulative cost

**Projects**
- Ranked table including **$ per active hour** — measured, it varied about
  threefold across the top three projects
- Per-project sparklines
- **Per-branch token attribution** — the novel one; `git_branch` is populated on
  all 27,165 requests. Measured: `feature` 12.9M, `main` 4.66M, `HEAD` 2.98M,
  a personal branch 1.9M
- Lines added/removed — **287,125 / 27,640**, computed as `MAX` per session.
  See the trap below.

**Skills & Models**
- Skill leaderboard — `brainstorming` 623 req / 662k out, `executing-plans`
  659 / 588k, `writing-plans` 192 / 560k
- MCP server and plugin attribution
- Subagent vs main thread: **10% / 90%** of output tokens
- Model mix over time — opus-5 13.2k req, opus-4-8 7.9k, sonnet-5, fable-5, haiku
- Cache hit rate: **98.14%** lifetime (5.78B reads vs 109.5M writes)
- API errors: 21× `429`, 3× `404`
- Effort distribution *(kept for now; backlog to revisit — only 58% populated,
  so it renders a large "unknown" slice)*

### A trap found during the brainstorm — do not lose this

`claude_status_snapshots.total_lines_added` is **cumulative per session**, so
summing it across snapshots gives 80,885,856 against a true 287,125 — a
**281.7× overcount**. This is the identical bug class as the token defect Stage 2
fixed (context-window occupancy read as cumulative usage, wrong by 63–201×). Any
snapshot-sourced counter must be `MAX` per session, never `SUM` across rows.

---

## Section 2 — merging TheOneOS `/ai-spend` (APPROVED)

Source read during the brainstorm: `~/Developer/Coding/personal/TheOneOS`,
`app/ai-spend/page.tsx` and `components/personal/ai-spend/*` (5,843 lines).

**There are five tabs, not four:** Overview, Claude Watch (`ccflare`), Codex
Watch, **Hermes Watch**, Claude Code Hours.

### Claude Code Hours → fully reproducible, and Watchtower's version is better

Reads the **same** `~/.theone` database Watchtower owns. The panel still carries
the disclaimer *"Token figures are context-window composition from status
snapshots (not cumulative API throughput)"* — precisely the defect Stage 2 fixed.
Watchtower has real per-request tokens.

Stats to carry over that section 1 did not already have: repos donut (30d),
model donut (30d), weekday habit bars, terminal breakdown, coverage
(days / since / sessions), XP-to-next-rank, average context trend, active-vs-total
(incl. idle) day bars, current streak + this-week M–S dots, and the Matrix rank
ladder (Coppertop → Operator → **The One**).

### Claude Watch → reproducible WITHOUT a proxy, and more completely

The panel's own coverage note concedes the proxy **cannot see** MCP server usage,
tool calls, slash commands, or compaction events. Watchtower has all four from
transcripts, and Stage 2 already established transcripts carry more than a proxy
would (a proxy has no `cwd`, no branch, and cannot distinguish a subagent).

Stats to carry over: the **fresh vs cache vs total** token framing (fresh =
in + out, "what you'd intuitively call usage"; cache reads bill at ~10% of input
rate; total = in + out + cache read + cache write), token composition stacked bar,
model performance table (avg response, tok/s, error rate), request-share and
cost-by-model donuts, per-session table (req, fresh, cache reads, ~context/turn,
cost, last active), and requests/tokens/cost time series with per-bucket inspection.

**AI Usage Profile** (part of this tab): a 6-tier ladder — Noobie(0) / Explorer(100)
/ Practitioner(200) / Operator(300) / Architect(400) / Master(500) — scored across
**ten discipline dimensions**, 0–60 each, **600 total**, with week-over-week
movement. The ten: prompt hygiene, context hygiene, session hygiene, model routing
discipline, cost discipline, verification discipline, automation discipline,
reuse & systematization, security & privacy discipline, output quality discipline.
Defined in `TheOneOS/lib/ccflare/usage-profile.ts`. Also: sessions today, avg and
longest session, cost per session, avg daily spend, typical response, favorite
model, inferred compactions.

### Codex Watch → buildable now, not vaporware

Reads Codex's **own local rollout logs** at `~/.codex/sessions` — a pure local
read, the same architecture as Watchtower's transcript ingest. Verified on this
machine: **94 files, 901 MB**, present today. Stats: requests, tokens, cost,
sessions, active time, tool calls, models, surface, avg response, tool-calls/day,
reasoning-effort mix. Source: `TheOneOS/lib/codex/activity.ts`.

### Overview → re-scoped, per decision 4

TheOneOS's Overview aggregates sources Watchtower cannot see: subscription
records, in-app usage, Agency spend, and an API-usage index from TheOneOS's
connectors system; "skills saved" is an estimate from TheOneOS automated-run
counts. Watchtower's Overview is instead a **cross-tool rollup of the tools it can
actually read** — Claude Code now, Codex next, Hermes later: total spend, total
tokens, time, split by tool.

---

## Section 3 — architecture and staging (APPROVED 2026-09-14)

### Proposed layering

```
~/.theone/claude-code-usage.sqlite ──┐
~/.codex/sessions/*.jsonl ─ ingest ──┤   (Stage 5, same DB, new tables)
                                     ▼
          lib/read/*.ts      one module per view; SQL -> plain objects
                                     ▼
          lib/render/*.ts    pure functions: data -> HTML/SVG string
                                     ▼
          bin/watchtower     serve (node:http) | report (static file)
```

- **Zero runtime dependencies holds.** `node:http` for the server;
  `execFileSync("sqlite3", ["-json", ...])` for reads, the pattern
  `lib/projects.ts` already uses.
- Charts are hand-written inline SVG — roughly eight primitives (area, stacked
  bar, donut, calendar heatmap, hour×weekday heatmap, progress ring, sparkline,
  day bars), each a pure `data -> string` function and therefore snapshot-testable.
- The server binds `127.0.0.1` only.

### The load-bearing decision

CLAUDE.md's rule is *"No model math in TypeScript, ever — grouping and labelling
only,"* enforced by a test that fails the build if model constants appear in
`lib/`. **Scoring is derivation, not labelling**, so the ten disciplines should be
computed in **`rollup.sh`** and written to a new `claude_discipline_scores` table,
with TypeScript only reading and formatting.

Cost of that choice: schema **v5**, and new SQL in the most carefully-guarded file
in the repo. Benefit: every derived number stays reproducible by re-running the
rollup, and the dashboard stays a pure reader.

**Decided 2026-09-14: yes — compute in `rollup.sh`.** The schema version is
declared twice (`CC_SCHEMA_VERSION` in `capture/lib.sh`, `schemaVersion` in
`lib/config.ts`) and a test pins them together; Stage 4 bumps both to 5.

### Proposed staging

| Stage | Contents |
|---|---|
| **3** | Read layer + server + chart primitives + Claude Code views: Live, History, Projects, Skills/Models. All of section 1, plus Claude Code Hours' donuts / weekday / terminals / coverage / streak, plus Claude Watch's fresh-vs-cache framing, model performance table and per-session table. Hygiene stays 0–100. |
| **4** | The ten disciplines + 6-tier ladder in `rollup.sh` (schema v5) + the Usage Profile view. Several disciplines — security, verification, output quality — need new derivations; the spec must define each one's inputs explicitly rather than hand-waving. |
| **5** | Codex ingest (`~/.codex/sessions` -> new tables) + Codex Watch view + the cross-tool Overview. Overview lands here because with only Claude Code it is a degenerate single-column rollup. |

### Proposed testing

Read modules test against fixture DBs exactly as the existing suite does.
Renderers are pure and snapshot-tested. One end-to-end test boots the server on an
ephemeral port, fetches each route and asserts the JSON shape — no browser
automation.

---

## Backlog (priority order)

1. **Codex Watch** — the user will be using Codex heavily. Stage 5, or pulled
   earlier if they ask.
2. **Hermes Watch** — `~/.hermes/state.db`, same local-DB-read pattern as Codex,
   cheap once that exists.
3. **TheOneOS `hours.ts` still recomputes tokens the broken way** — this is the
   deferred Stage 2 Task 7. It must read `claude_requests`. Its own branch, its
   own PR, in the TheOneOS repo. The panel's stale "context-window composition"
   disclaimer goes away with it.
4. **Reconsider the live event ticker** — kept for now by request; mostly
   SessionStart/SessionEnd noise.
5. **Reconsider the effort distribution** — kept for now by request; only 58%
   populated, so it renders a large "unknown" slice.
6. ~~`watchtower.config.example.json` pins `"schemaVersion": 3` while
   `lib/config.ts` defaults to 4.~~ **Closed 2026-09-14** — bumped to 4
   deliberately, on its own branch, alongside the ccflare strip. Stage 4 bumps
   it again to 5.

---

## Resume checklist

1. Re-read this file and `SESSION.md`. **Do not re-ask decisions 1–9.**
2. Write the real spec to
   `docs/superpowers/specs/2026-09-12-stage-3-dashboard-design.md`, covering the
   approved section-3 architecture, the eight chart primitives, every route, and
   the walking-skeleton first task.
3. Run the spec self-review, then ask the user to review it.
4. Only after the user approves the spec: invoke `writing-plans`.

### Codex retention — measured 2026-09-14

`~/.codex/sessions` holds **96 rollout files, 902 MB, spanning 2025-08-30 →
2026-09-13** with no sign of retention pruning (31 files in 2026-09 alone). So
unlike `claude_requests` — where transcripts vanish after `cleanupPeriodDays` and
durability was forced — **deferring Codex ingest to Stage 5 loses no history.**
That is the measurement that settled decision 8. Re-check it before Stage 5; if
Codex ever grows a cleanup period, ingest becomes urgent again.
