# Stage 3D — dashboard UX, themes, and TheOne parity (design)

**Status:** approved in brainstorming 2026-09-23. Awaiting review of this written spec.
**Branch:** `stage-3d-dashboard-ux`, cut from `stage-3c-dashboard` @ `2753c3f` because
PR #10 (Stage 3C) is still open. Rebase onto `main` with `git rebase --onto main 2753c3f`
once #10 merges.
**Builds on:** `2026-09-14-stage-3-spec.md` §3C and `2026-09-12-stage-3-dashboard-design.md`
§§5–7. Everything those promise still holds unless this document changes it explicitly.
**Mockups:** `.superpowers/brainstorm/51075-1790208482/content/` (git-ignored):
`live-page-v2.html` is the reference look, and `palettes.html` shows the four alternate themes.

## 1. Purpose

Stage 3C works, but it looks like a debug page. The user wants two things. First, the
dashboard should look and feel as good as TheOne's AI Spending page, or better. Second,
it should carry every stat from that page that Watchtower can honestly compute,
combined with what it already shows. This stage is the **first of three**, in the order
the user chose on 2026-09-23 (option A):

| Stage | Contents |
|---|---|
| **3D (this)** | Visual redesign (themes, effects, navigation, interaction) plus every Claude stat from TheOne that needs no schema change |
| 4 | Ten disciplines, the 6-tier Usage Profile and TheOne's Matrix tier, all computed in `rollup.sh` (schema v5), plus per-request latency (enables response time and tok/s) and a pricing table in the rollup (enables cost by model) |
| 5 | Codex ingest + Codex Watch, the cross-tool Overview, then Hermes Watch |

Success means that every page renders in the new look under all five themes, every new
stat is backed by a read that is correct on the live DB copy, and all existing guards
still hold.

## 2. Decisions made in brainstorming (do not re-ask)

| # | Question | Decision |
|---|---|---|
| D1 | Order of the remaining work | **A**: redesign + Claude parity first; Stage 4 and 5 inherit the look |
| D2 | Visual direction | **TheOne glass**: dark frosted cards, warm glow, big bold numbers, pill tabs |
| D3 | Navigation | **Two rows of pills** (tool row, page row) by default; a **sidebar** grouped by tool is a setting |
| D4 | Intensity | **Bold** (v2): aurora background, animated conic borders on hero cards, rings that sweep in, count-up numbers, pulsing live dot, flowing burn line, hover lift + glow |
| D5 | Colors | **Default = TheOne amber** (the v2 mockup). Four more themes in Settings: **Claude, SF Giants, Toronto Raptors, Buffalo Bills**. Team themes are colors only: no logos, marks or team names anywhere in the UI beyond the theme's label in Settings |
| D6 | Page contents | The table in §5, approved as "looks about right" |
| D7 | Rendering approach | **Server-rendered SVG + one small inline client script**, with no chart library and no client-side rendering. Report reuse and snapshot tests are preserved |
| D8 | Sync button | **None.** The dashboard stays read-only |

## 3. What does not change

- The DB is opened read-only. The dashboard never runs `rollup.sh` or `sync`.
- Loopback bind plus the `Host` check (421) and `nosniff`. Zero runtime dependencies.
- No activity-model math in TypeScript. The `MIN(gap,` carriers guard covers every new
  file under `lib/read/**` and `lib/render/**`.
- Tokens come from `claude_requests` or transcripts, never snapshots. Requests are never
  aggregated through `claude_sessions`. Snapshot counters are MAX per session.
- No measurement is asserted where there is none. NULL renders as "no data" or pending,
  never as `0`. Every existing null/empty guard keeps its test.
- `report` goes through the same read and render functions. It still omits Live.
- No schema change. `CC_SCHEMA_VERSION` stays 4, and nothing under `~/.claude` changes.

## 4. Visual system

### 4.1 Theme tokens — `lib/render/theme.ts`

Every color in the stylesheet is a CSS custom property. A theme is one block of
variables, and switching theme swaps a `data-theme` attribute on `<html>`, so nothing
re-renders. Tokens:

`--bg --ink --dim --label --line --glass --card --track --a1 --a2 --on-accent
--glow1 --glow2 --glow-soft --live --ok --warn --over`

Values are taken verbatim from the mockups:

| Token | amber (default) | claude | giants | raptors | bills |
|---|---|---|---|---|---|
| `--bg` | `#08080c` | `#141413` | `#0B0A09` | `#070708` | `#050B1C` |
| `--ink` | `#f5f5f4` | `#F0EEE6` | `#FFF6E6` | `#F4F4F5` | `#FFFFFF` |
| `--dim` | `#a8a29e` | `#A8A49A` | `#B3A48C` | `#A1A1A4` | `#9AA8C7` |
| `--label` | `#fde68a` | `#E3B99A` | `#EFD19F` | `#B4975A` | `#8FB3FF` |
| `--a1` | `#f59e0b` | `#D97757` | `#FD5A1E` | `#CE1141` | `#00338D` |
| `--a2` | `#fde68a` | `#EBC5A0` | `#EFD19F` | `#B4975A` | `#C60C30` |
| `--on-accent` | `#1c1917` | `#141413` | `#0B0A09` | `#ffffff` | `#ffffff` |
| `--live` | `#34d399` | `#8FBF8A` | `#FD5A1E` | `#CE1141` | `#3D7BFF` |
| `--ok` (ring < 70%) | `#34d399` | `#D97757` | `#FD5A1E` | `#A1A1A4` | `#3D7BFF` |

`--glow1/--glow2/--glow-soft/--line/--glass/--card/--track` use the rgba values in
`palettes.html`. Two tokens are shared across themes: `--warn` = `#f59e0b` (ring
70–90%) and `--over` = `#ef4444` (ring ≥ 90%, pulses). They are deliberately not
themed, so a limit warning reads the same in every theme. Bills uses `#3D7BFF`
wherever royal blue would sit on navy (rings, live dot, active-pill gradient start
`#1a4fbf`), because `#00338D` on `#050B1C` is unreadable.

**Contrast rule, tested:** for every theme, `--ink` and `--dim` against `--bg` meet
WCAG AA for their use (≥ 4.5:1 for `--ink`, ≥ 3:1 for `--dim`, which is used only for
secondary text ≥ 11px). If a mockup value fails, the implementer adjusts that value and
records the change.

### 4.2 Effects

All effects are CSS, taken from `live-page-v2.html`:

- Drifting aurora: two or three blurred radial gradients from `--glow1/--glow2`.
- Glass cards: `--card` with `backdrop-filter: blur`, a 1px `--line` border, and hover
  lift + glow.
- Animated conic-gradient border on **hero** cards only: the current session on Live,
  plus one per page, named in §5.
- Gradient text on big numbers, a shine animation on the wordmark, a pulsing live dot,
  a flowing gradient on progress bars, and a flowing dashed burn line.
- Entrance motion: cards rise, rings sweep, bars grow, numbers count up.

**Motion rules (tested):**
1. Entrance animations run **once per page load**. After the first paint the client adds
   `html.settled`, which disables them, so the 5-second Live poll never replays them.
2. `@media (prefers-reduced-motion: reduce)` disables **every** animation and transition,
   including the aurora drift and conic spin.
3. Nothing animates a value from 0 when the value is null. Count-up applies only to
   elements the renderer marked `data-count` with a finite number.

### 4.3 Navigation and settings

- **Pills (default):** a tool row (`Overview` · `Claude Code` · `Codex` · `Hermes`) and a
  page row (`Live` · `History` · `Projects` · `Sessions` · `Models & Skills` · `Profile` ·
  `Sources`). Overview, Codex, Hermes and Profile render dimmed and inert, titled
  "Stage 4" or "Stage 5", so the shape of the product is visible. They are not links, so
  nothing leads to a 404. The active pill is filled with the accent gradient, and the Live
  pill carries the live dot.
- **Sidebar (setting):** a fixed left column about 180px wide, grouped as "All tools"
  (Overview), "Claude Code" (the pages) and "Codex · Hermes" (inert), with Sources at the
  bottom. Below 900px viewport width it collapses to the pill layout regardless of setting.
- **Settings panel:** a ⚙ button at the top right opens a popover with **Theme** (5
  swatches with names) and **Navigation** (Pills / Sidebar). Choices persist in
  `localStorage` under `wt.theme` and `wt.nav`, wrapped in `try/catch`. When storage is
  unavailable the page falls back to amber + pills. To avoid a theme flash, a tiny
  blocking script in `<head>` applies the stored choice before first paint.

### 4.4 Interaction (client script — `lib/render/client.ts`)

One inline script, hand-written, emitted by `layout.ts`. It makes no network calls
except Live's existing `/api/live` poll. Responsibilities:

1. **Tooltips:** any SVG mark or table cell with `data-tip` shows a styled tooltip on
   hover or focus. Every mark also keeps a `<title>`, so the value is available without
   JS and to screen readers.
2. **Count-up** of `data-count` numbers on first load only.
3. **Sortable tables:** `table.sortable` headers sort by the cell's `data-sort` value;
   nulls always sort last.
4. **Settings** as in §4.3.
5. **Range pills** (see §4.5).
6. **Live polling** (existing behaviour, re-homed here).

Budget: the emitted script stays under 12 KB unminified. There is a test for this.

### 4.5 Ranges

Pages that cover a time span get `7d · 30d · 90d · All` pills. The default is 30d.
- **Served:** a pill is a plain link to `?range=30d`, rendered on the server. An unknown
  value falls back to 30d (no error page).
- **Report:** each range-dependent block is rendered once per range and emitted with
  `hidden`, and the pills toggle between them client-side, so the static file stays
  interactive. This roughly quadruples those blocks. The report size budget rises from
  the current ~160 KB to **≤ 1 MB** on the live DB copy (tested on the fixture as a
  multiple, measured on the live copy).

## 5. Pages

✚ = new from TheOne. "Hero" = the card with the animated border.

### Live (`/`) — hero: current session
5h and 7d limit rings (ok < 70% ≤ warn < 90% ≤ over, pulsing) · current session: cost,
elapsed, output tokens and requests, context bar, burn rate + 5-minute sparkline (the
existing "idle" and "pending" states stay) · today: active hours, sessions, spend,
hygiene · ✚ **this week**: 7 day bars of active hours, today highlighted, plus the current
streak · rank + progress bar to the next tier · event ticker (newest row highlighted).

### History (`/history`) — hero: rank ladder
Calendar heatmap · hour × weekday heatmap · ✚ **weekday habit bars** · hygiene trend with
its four components (existing gap and denominator guards stay) · ✚ **average context
trend** · active vs idle bars · cumulative cost · streaks · ✚ **rank ladder** · coverage.
Range pills apply to the trends and bars, not to the calendar heatmap (always a year)
or the ladder.

### Projects (`/projects`) — hero: top project by active hours
Ranked table (`sortable`) with $/active hour and sparklines · per-branch tokens · lines
added/removed · repos donut · ✚ **terminal breakdown**. Range pills apply.

### Sessions (`/sessions`) ✚ — hero: most expensive session in range
A new page and new reader, `lib/read/sessions.ts`. A sortable table of sessions in range,
newest first, capped at the 500 most recent with a note saying so. Filter by project
through a `?project=` link on each project cell (served only; the report shows every
project).

### Models & Skills (`/skills`) — hero: the time series
Skill/MCP/plugin leaderboards · subagent vs main · model mix over time · ✚
**request-share and output-token-share by model donuts** · ✚ **model table** · fresh/
cache/total framing + token composition bar · cache hit · API errors · ✚ **effort mix** ·
✚ **interactive time series** of requests, output tokens and cost per day, with a metric
toggle (Requests / Tokens / Cost) and a hover tooltip per bucket.

### Sources (`/sources`)
Content unchanged; restyled.

## 6. Data for the new stats

Every read is SQL returning plain rows. TypeScript groups and labels only.

| Stat | Source and rule |
|---|---|
| This week | `claude_daily_rollups.active_ms` for the last 7 calendar days. A date with no row is a gap, not 0 (same rule as History M1). |
| Weekday habit bars | Mean `active_ms` per weekday over days **with a row** in range. The label says "average of days you used it". |
| Average context trend | `claude_daily_rollups.avg_context_pct` per day, **only for days that have at least one `claude_status_snapshots` row**. Other days are gaps, because the column defaults to 0 and a day with no snapshots has no measurement. |
| Rank ladder | Tier names and thresholds (`Noobie 0 · Apprentice 20 · Builder 100 · Intermediate 300 · Advanced 800 · Pro 2000 · Master 5000` active hours) are **duplicated on purpose** in `lib/render/ladder.ts` for display, and a test parses `rollup.sh`'s `names=(…)` / `mins=(…)` and asserts they match (the same pattern as the exclusion defaults). The user's position comes from `claude_rank_progress`; TypeScript never computes rank. |
| Terminal breakdown | `COUNT(*)` of `claude_sessions` per `terminal_app` in range (a session count, not a request aggregate). NULL is shown as "unknown", never dropped. |
| Sessions table | Per `session_id` from `claude_requests` in range: requests, fresh = `in + out`, cache reads, context/turn ≈ `(in + cache_read + cache_creation) / requests` (labelled "≈"), first and last `ts`. Joined for labels only via `LEFT JOIN` to `claude_sessions` (terminal, project) and to `MAX(total_cost_usd)` per session from snapshots. A session with no snapshot shows cost "—". Project attribution uses the same lookup as `lib/read/projects.ts`; reuse it, don't copy it. |
| Request / token share by model | `claude_requests` grouped by `model`, requests and `tokens_out`. |
| Model table | Per model: requests, fresh tokens, output tokens, cache hit % = `cache_read / (in + cache_read + cache_creation)` (NULL when the denominator is 0), error rate = rows with `api_error_status` not NULL / requests. **No cost, latency or tok/s columns** (Stage 4). |
| Effort mix | `claude_requests.effort` counts. NULL is its own labelled slice, "not recorded". |
| Time series | Per day: requests and `tokens_out` from `claude_requests`, cost from `claude_daily_rollups.cost_usd`. A date with no row is a gap. |

**Excluded directories:** as in 3C. `(excluded)` is hidden on project-named surfaces,
while totals keep reconciling with the daily rollups.

## 7. Primitives

The eight existing primitives keep their signatures and guards and gain:
theme-token colors, `data-tip` on every mark, and optional `data-count` on their headline
number. There are three new primitives, each a pure `data → string` function, each
snapshot-tested with **empty input as a named case**:

- `rankLadder(tiers, current)`: the 7 tiers as a vertical ladder, with the current tier
  glowing and progress to the next.
- `sortableTable(columns, rows)`: emits `table.sortable` with `data-sort` per cell.
- `rangePills(active, hrefFor)`: the pill row, as links on the server and as toggles in the report.

## 8. File plan

New: `lib/render/theme.ts`, `lib/render/client.ts`, `lib/render/ladder.ts`,
`lib/render/sessions.ts`, `lib/read/sessions.ts`, `tests/render-theme.test.ts`,
`tests/render-client.test.ts`, `tests/read-sessions.test.ts`,
`tests/render-sessions.test.ts`.
Changed: `lib/render/{layout,charts,live,history,projects,skills,sources,report}.ts`,
`lib/read/{live,history,projects,skills}.ts`, `lib/serve.ts` (the `/sessions` route and
`?range=` / `?project=` parsing), `lib/views.ts`, and the existing tests they touch.

## 9. Testing

- **Guards carried forward:** every 3C guard stays green unchanged (null ≠ 0, the
  hygiene gap, the denominator label, the `claude_sessions` join drop, SUM vs MAX, the
  loopback bind, Host 421, no deps, the `MIN(gap,` sweep).
- **New guards, each planted and watched turning exactly one test red:**
  1. The average context trend plots a no-snapshot day as 0.
  2. The sessions table aggregates tokens through `claude_sessions` instead of
     `claude_requests`.
  3. A null cost in the sessions table sorts as 0 or renders as `$0.00`.
  4. The ladder constants drift from `rollup.sh`.
  5. Count-up animates a null value.
  6. An entrance animation is not gated by `html.settled` (a poll would replay it).
- **Theme tests:** every theme defines every token; contrast meets the §4.1 rule; no theme
  label or CSS contains a team logo, URL or image.
- **Client tests:** the script is under 12 KB, contains no `fetch(` other than `/api/live`,
  and reads/writes storage only inside `try`.
- **Live-copy run:** each task ends by rendering its pages against a `.backup` copy of
  the live DB and recording timings, page sizes and a sanity reconciliation. The time
  series totals must equal the sums of the daily rollups over the same range.
- **Visual check:** the final task captures a screenshot of every page in every theme
  (BrowserOS Neo, the user's browser for agents) against the live copy, and the user
  looks at them before merge.

## 10. Out of scope

The ten disciplines, the Usage Profile, the Matrix tier, latency, tok/s, cost by model
(Stage 4). Codex, Hermes, a functional Overview (Stage 5). A Sync button (D8). Any
server-side settings persistence. Particles, 3D tilt and sound. Light themes.
