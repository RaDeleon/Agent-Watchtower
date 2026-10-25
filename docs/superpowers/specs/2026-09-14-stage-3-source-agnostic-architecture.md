# Stage 3 (reframed) — Source-agnostic observability architecture

**Date:** 2026-09-14
**Status:** ARCHITECTURE PROPOSAL. §13's open questions were **answered 2026-09-14** and are recorded as decisions in §14. Still no code, no spec.
**Supersedes:** §3 (architecture) and the 3/4/5 staging of
`2026-09-12-stage-3-dashboard-brainstorm.md`, and the whole of
`2026-09-12-stage-3-dashboard-design.md`, which is demoted to **input** — its
stat inventory, honesty rules and chart work survive into Stage 3C.

**Still binding from the brainstorm:** decisions 1–6 and 9 (form factor, liveness,
scoring model, ccflare out of scope). Decision 8's build order is replaced.

---

## 0. What the evidence changed

Before proposing anything I probed the actual sources on this machine. Three
findings are load-bearing and one of them settles the hardest question in the
reframe prompt.

### Finding 1 — Atlas is already here, and links to Claude *exactly*

`.atlas/sessions.db` exists **inside this repo** (3.4 MB + 4.2 MB WAL). Its
`agent_session` table carries `source` and `native_session_id`.

```
5 of 5 Atlas sessions join exactly to claude_sessions.session_id
4 of 5 join to claude_requests.session_id
  (the 5th is the live, not-yet-ingested session -- see §14 decision 5)
```

**Identity linking is deterministic, not inferred.** The join key exists today
and needs no heuristic, no time-window matching, no fuzzy `cwd` comparison. This
removes the single biggest design risk in the prompt.

### Finding 2 — Atlas carries usage, and it disagrees with Watchtower in *both* directions

`agent_session.token_totals` is a JSON blob of input/output/cache tokens. Against
`claude_requests` for the same sessions:

| session | Atlas out | Watchtower out | ratio | sidechain reqs |
|---|---:|---:|---:|---:|
| session A | 86,240 | 42,526 | **2.03×** | 0 of 67 |
| session B | 21,859 | 21,859 | **1.00×** | 0 of 27 |
| session C | 353,731 | 791,486 | **0.45×** | 567 of 887 |
| session D | 294,213 | 698,118 | **0.42×** | 518 of 767 |

The pattern is fully explained, and it is not noise:

- **Where Atlas reads low**, the session is dominated by **sidechain (subagent)
  requests** — 64% and 68% respectively. Atlas does not count subagent traffic;
  Watchtower does.
- **Where Atlas reads high** (session A, 2.03× on a session with *zero*
  sidechains), it is almost exactly double. That is the signature of
  **summing repeated `requestId` rows** — the defect Stage 2 solved with
  `MAX`-per-`request_id`, given 47% of transcript usage rows repeat a `requestId`.
- Session B matches to the token: 27 requests, no sidechains, no duplicates.

**Ruling: Atlas contributes provenance, never usage.** Not as a tie-breaker, not
as a fallback when Claude data is missing. This is not a preference — a second
observer of the same events that is wrong by 2.03× in one direction and 0.42× in
the other cannot be reconciled into the same metric, and invariant 4 ("never
count a duplicated observation twice") would be violated either way.

This is the same class of error as the two traps already in CLAUDE.md, found the
same way: by comparing a derived figure against the authoritative raw one.

### Finding 3 — Atlas already emits the proposed envelope

`.atlas/logs.jsonl`, verbatim:

```json
{"source":"atlas","kind":"project-open","summary":"Opened project: Claude-Watchtower",
 "projectPath":"/Users/you/...","projectName":"Claude-Watchtower",
 "payload":{...},"id":"..."}
```

`source` + `kind` + `id` + project + payload. The prompt's envelope was not
invented in a vacuum; a real tool already writes this shape. That is good
evidence the envelope is natural rather than imposed.

**Also probed:** Hermes `~/.hermes/state.db` exists (22 MB) but is a *messaging
gateway* — `messages`, `gateway_heartbeats`, `hosted_rooms` — not coding-agent
telemetry. It is a weaker fit than the brainstorm assumed; see §12.
OpenViking is **not present** (no `~/.openviking`, nothing on :1933), so its
adapter is designed against the prompt's description only and must be validated
before implementation.

---

## 1. Design principle, restated as a testable rule

> Watchtower must not care where telemetry comes from.

Made testable:

**Every normalized metric has exactly one authoritative source, declared at
registration.** A non-authoritative source may *enrich* a record (add provenance,
add dimensions, add links) but may never contribute to a metric another source
owns. Contributions from a non-authoritative source are rejected at ingest with a
counted, visible error — not silently dropped, not averaged, not summed.

This single rule discharges invariants 1, 2, 4 and 5 at once, and it is what
finding 2 proves is necessary rather than merely tidy.

---

## 2. Three layers

### Layer 1 — source truth (unchanged, untouched)

`claude_events`, `claude_sessions`, `claude_status_snapshots`, `claude_requests`,
`claude_project_paths`, `claude_ingest_cursor` stay **exactly as they are**.

Atlas keeps its own `.atlas/sessions.db`; Watchtower reads it, never writes it.
Codex keeps its rollout logs. Source-specific richness is preserved here and is
never flattened to fit the common schema (prompt requirement; invariant 5).

### Layer 2 — normalized facts

```
wt_sources        registered sources, version, capabilities, authority claims
wt_ingest_state   per-source cursors, last run, health, error counts
wt_sessions       canonical session identity across tools
wt_requests       normalized per-request usage
wt_events         normalized discrete events
wt_usage          metric rows: (session, metric, value, source)
wt_tools          tool / MCP / skill invocations
wt_links          identity linking between source-local records
wt_metrics        free-form adapter metrics that have no first-class home
```

### Layer 3 — derived analytics

```
wt_daily_rollups   wt_project_rollups   wt_model_rollups   wt_source_rollups
```

`claude_daily_rollups`, `claude_project_rollups` and `claude_rank_progress`
**remain, unchanged, and remain what TheOneOS and the regression tests read.**
The `wt_*` rollups are additive. Nothing is deleted in Stage 3.

---

## 3. Where derivation lives — the line, sharpened

CLAUDE.md: *"The activity model lives in `capture/rollup.sh` and nowhere else."*

The reframe stresses this rule, so it needs a sharper test than "no model math in
TypeScript." The test I propose:

> **Does the computation reconstruct activity from raw timestamps?**
> Yes → `rollup.sh` (or a per-source equivalent shell rollup). No → anywhere.

| Computation | Where | Why |
|---|---|---|
| gaps, caps, active vs idle, hygiene, rank | `rollup.sh` | reconstructs activity from timestamps |
| `SUM(tokens_out) GROUP BY model` | read layer | grouping over derived facts |
| Claude tables → `wt_*` records | adapter (TS) | **mapping**, not derivation — no new number is produced |
| cross-source totals | SQL over `wt_*` | summation of facts each source already derived |
| the ten disciplines (Stage 4+) | shell rollup | scoring is derivation (brainstorm decision 7 stands) |

**Normalization is not derivation.** A Claude adapter emitting
`wt_requests.tokens_out = claude_requests.tokens_out` invents nothing. That is
what makes it safe in TypeScript, and it is why the bash collector does not need
rewriting.

**Carriers guard extends to `lib/core/**`, `lib/adapters/**`, `lib/read/**`,
`lib/render/**`.** An adapter is exactly where "just compute the gap here" would
land next.

---

## 4. Adapter contract

```ts
interface WatchtowerAdapter {
  readonly id: string;              // "claude" | "codex" | "atlas" | ...
  readonly version: number;         // bump ⇒ re-ingest from scratch
  readonly capabilities: Capability[];
  readonly authority: MetricAuthority[];   // §1: what this source OWNS

  detect(): Promise<DetectionResult>;      // cheap, filesystem/HTTP probe
  health(): Promise<AdapterHealth>;
  ingest(cursor?: string): AsyncIterable<WatchtowerRecord>;
}

type Capability =
  | "sessions" | "requests" | "usage" | "tools"
  | "git" | "checkpoints" | "memory" | "health";

interface MetricAuthority {
  kind: WatchtowerRecord["kind"];
  metrics: string[];               // e.g. ["tokens_in","tokens_out","cost_usd"]
}
```

Rules:

- **An adapter never emits what its source does not contain.** No zero-filling,
  no inference. A missing metric is absent, not `0` — the existing "do not assert
  a measurement where there is none" invariant, generalized.
- **Ingest is idempotent.** Every record carries `(source, sourceRecordId)` as a
  primary key, so re-ingesting is a no-op upsert. This makes cursors **advisory
  only**, exactly as `claude_ingest_cursor` already is, and for the same reason.
- **`detect()` must be cheap and must not throw.** A missing source is normal.
- **Version bump forces re-ingest** of that source's normalized rows only. Source
  truth is untouched.

### The Claude adapter is a projection, not a collector

**The bash capture path does not change. At all.** `hook.sh`, `snapshot.sh`,
`ingest.sh`, `rollup.sh` and `lib.sh` keep writing `claude_*` exactly as today.
The Claude adapter reads those tables and projects them into `wt_*`.

This is the difference between wrapping a trusted implementation and rewriting
it, and it keeps invariant 7 (never break Claude Code) trivially true: nothing on
the hook path is touched by Stage 3 at all.

---

## 5. Canonical record envelope

Close to the prompt's, with four changes, each earning its place:

```ts
interface WatchtowerRecord {
  source: string;
  sourceRecordId: string;
  kind: "session" | "request" | "usage" | "tool" | "memory"
      | "git" | "checkpoint" | "health" | "event" | "custom";
  timestamp: string;              // RFC3339, always UTC, always explicit offset

  sessionId?: string;             // SOURCE-LOCAL. Canonical id is assigned by core.
  project?: string; repo?: string; branch?: string;
  agent?: string; model?: string;

  metrics?: Record<string, number>;
  dimensions?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;

  // --- additions ---
  observedAt?: string;            // when the ADAPTER saw it, vs when it happened
  authority?: "authoritative" | "enrichment";
  links?: RecordLink[];           // explicit, adapter-asserted identity claims
  schemaVersion: number;          // envelope version, not DB version
}
```

1. **`sessionId` is explicitly source-local.** The prompt's shape invites reading
   it as global; two sources can and do use the same-looking UUID space. Core
   assigns canonical ids (§6).
2. **`observedAt` vs `timestamp`.** Atlas imported four sessions on 2026-09-14
   that *happened* 2026-09-09 → 09-12. Without both, late-arriving backfill
   corrupts day buckets — and the rollup buckets by *local day*.
3. **`authority`** makes §1's rule an explicit property of each record rather
   than an out-of-band lookup, so a violation is visible in the record itself.
4. **`schemaVersion`** on the envelope, separate from the DB schema version, so
   external adapters can be versioned independently of Watchtower's DB.

**Timestamps are RFC3339 with an explicit offset, always.** Atlas writes
`2026-09-14T18:37:55.016862+00:00`; Claude writes unix epochs. Normalizing at the
boundary, once, is the only way the local-day bucketing stays correct.

---

## 6. Identity, linking and deduplication

The load-bearing part, and finding 1 makes it tractable.

### Canonical ids

```
wt_sessions
  canonical_id   TEXT PRIMARY KEY     -- minted by core, opaque
  first_source   TEXT
  started_at     INTEGER
  ...

wt_links
  canonical_id   TEXT
  source         TEXT
  source_local_id TEXT
  link_kind      TEXT   -- "same_session" | "produced_commit" | "touched_file"
  confidence     TEXT   -- "exact" | "inferred"
  evidence       TEXT   -- the actual join key used, for audit
  PRIMARY KEY (source, source_local_id, link_kind)
```

### Linking strategy

**Stage 3 creates `confidence = "exact"` links only.** An exact link requires a
shared identifier that both sources obtained from the same upstream system —
which finding 1 proves exists:

```
atlas.agent_session.native_session_id  ==  claude_sessions.session_id
```

`inferred` links (time-window overlap, `cwd` heuristics) are **designed for but
not created** in Stage 3. The column exists so the schema need not change later;
no code writes it yet. Per the prompt: do not invent uncertain links silently.

### Deduplication

Dedup is **not** a post-hoc reconciliation pass. It is §1's authority rule applied
at ingest:

1. Every `(kind, metric)` has one authoritative source in `wt_sources`.
2. `authority: "enrichment"` records contribute dimensions, links and metadata —
   never metrics.
3. A non-authoritative metric is **rejected and counted** in `wt_ingest_state`,
   surfaced as source health. Silent drops are how a 2× error hides.

Concretely, for the Atlas case:

```
Atlas session ABC ──link(exact)──> canonical session XYZ
  ├── token_totals        → REJECTED   (Claude transcripts are authoritative)
  ├── checkpoint/commit   → ACCEPTED   (Atlas is authoritative)
  ├── files_touched       → ACCEPTED
  └── branch / repo       → ACCEPTED as enrichment
```

Atlas enriches the canonical Claude session with git provenance; it never moves a
token count. That is exactly what the prompt asks for, and finding 2 is the proof
it is required.

---

## 7. Discovery and configuration

### Discovery

| Source | Probe | Cost |
|---|---|---|
| Claude | `~/.claude` exists | stat |
| Codex | `~/.codex/sessions` non-empty | stat |
| Hermes | `~/.hermes/state.db` exists | stat |
| Atlas | `.atlas/sessions.db` under configured roots | **bounded scan** |
| OpenViking | HTTP probe, short timeout | network |

**Atlas discovery needs a bound.** Atlas state is *per-repository*, not global —
found in this repo, nowhere else. An unbounded scan of the home directory is not
acceptable, so discovery walks **configured project roots only**, to a fixed
depth, with results cached. This is a real cost the other sources do not have.

**Missing is normal, never an error.** A failed probe is a state, not an
exception, and `health()` must not throw.

### Config migration

The prompt's sketch moves the DB to `~/.watchtower/watchtower.sqlite`. **I
recommend against moving the file in Stage 3**, and this is the one place I push
back on the prompt:

- TheOneOS reads `~/.theone/claude-code-usage.sqlite` **directly**, and CLAUDE.md
  mandates numeric lockstep with it. Moving the file breaks a live consumer to
  gain nothing functional.
- The `.schema-vN` marker lives in the **database's directory**, and that trap has
  bitten three times.

Instead:

- `database.path` stays the single source of truth, resolved as:
  `WATCHTOWER_DB_PATH` → `THEONE_DB_PATH` *(deprecated alias, still honoured)* →
  explicit config → existing `~/.theone/...` if present →
  `~/.watchtower/watchtower.sqlite` for a **fresh install only**.
- Existing installs never move. New contributors get a neutral path.
- **The environment wins over the config file, not the other way round.** Written
  the other way in the first draft of this section, which was a documentation
  error, not a design one: every test in this repo points `THEONE_DB_PATH` at a
  `.backup` copy while a real config file sits in the working directory, and
  CLAUDE.md's "never test against the live DB" rule depends on that override
  landing. Corrected 2026-09-15.
- **`capture/lib.sh` resolves the same order.** It is the writer, `lib/config.ts`
  is the reader, and a split between them is silent by construction — see
  divergence 5 in §16.

The config grows a `sources` map as sketched. **`claude` absent from config means
enabled**, so no existing `watchtower.config.json` breaks.

> **CORRECTED 2026-09-14 by `2026-09-14-stage-3-spec.md` §2.** This section
> originally said `schemaVersion` goes to **5**, bumped in both declared places.
> That contradicts decision 8: `capture/lib.sh` installs as
> `~/.claude/cc-track-lib.sh`, so bumping `CC_SCHEMA_VERSION` means editing an
> installed file and requiring a reinstall — and Stage 3 is supposed to touch
> nothing under `~/.claude`.
>
> **Schema ownership splits instead.** `capture/lib.sh` keeps `claude_*` at
> `CC_SCHEMA_VERSION = 4` with marker `.schema-v4`; Watchtower core owns `wt_*`
> under a new `WT_SCHEMA_VERSION = 1` with marker `.wt-schema-v1`.
> `lib/config.ts`'s `schemaVersion` stays **4** and the existing pinning test
> passes unchanged. See the spec for why the two-marker arrangement is safe.

---

## 8. External adapters

NDJSON over stdin, as the prompt proposes:

```bash
some-adapter | watchtower ingest --stdin --source my-agent
```

Stage 3 defines **the protocol and the boundary, not a plugin runtime**:

- one JSON object per line, each a `WatchtowerRecord`
- unknown `kind` → `"custom"`, preserved in `wt_metrics`, never dropped
- malformed line → counted, reported, skipped; **the stream continues**
- `--source` must be pre-registered in config, so a typo cannot mint a new source
- external records are `authority: "enrichment"` by default; owning a metric is
  an explicit config grant

That last rule matters: an untrusted external adapter must not be able to claim
authority over Claude's token counts by asserting it in its own payload.

---

## 9. Code organization

```
lib/
├── core/       records.ts  adapters.ts  ingest.ts  identity.ts  schema.ts
├── adapters/   claude/  codex/  atlas/  openviking/  external/
├── read/       source-aware readers
└── render/     pure data → string
capture/
└── claude/     lib.sh hook.sh snapshot.sh ingest.sh rollup.sh install.sh
```

**Moving `capture/*.sh` into `capture/claude/` changes every installed path** and
touches `install.sh`, which rewrites the live `settings.json`. That is the single
riskiest mechanical change in this proposal, for zero functional gain.

**DECIDED 2026-09-14: deferred to a later stage.** `capture/` keeps its current
flat layout through Stage 3. The adapter boundary does not depend on the
directory move, so coupling a change that rewrites the live `settings.json` to
the foundational stage buys nothing.

When it is eventually done it gets its own task and the Stage 2 dry-run gate:
seed a temp `CLAUDE_DIR` from the live config, diff `settings.json`, confirm the
predicted delta byte for byte before the real run. That procedure has already
caught real hook-deletion bugs twice. Until then, `lib/adapters/claude/` wraps
`capture/*.sh` where they are.

---

## 10. Dashboard implications

The Stage 3 spec I wrote on 2026-09-14 is **not wasted** — its stat inventory,
chart primitives and honesty rules carry forward intact. What changes:

- Views read from **`lib/read/*` over normalized facts**, not from `claude_*`
  directly, wherever the figure is cross-tool by nature.
- **Source-specific deep dives are explicitly fine** and read source truth
  directly. Claude's per-branch token attribution is a Claude view; forcing it
  through a normalized envelope would lose fidelity for no gain.
- A **Sources view** is new and required: per-source connected/not-detected,
  last ingest, cursor position, rejected-metric counts, error counts. This is
  where §6's rejections become visible rather than silent.
- The rate-limit gauge stays the walking skeleton. It is Claude-specific, but it
  exercises read → render → serve and the NULL/>100% honesty rules, and those are
  source-agnostic concerns.

All of the previously-approved widgets survive. None of them needs rewriting
later, because the ones that are Claude-shaped are *declared* Claude-shaped.

---

## 11. Regression requirement

**I propose moving the regression harness from Stage 3B to Stage 3A.** The prompt
puts it in 3B, but a baseline captured *during* a refactor is not a baseline. It
must be frozen before any code moves.

Mechanically:

1. In **3A**, add `tests/regression/claude-baseline.json` — active time, window,
   idle, sessions, prompts, tokens in/out/cache, cost, compacts, clears,
   subagents, per-project rows, hygiene, rank — generated from the existing
   fixture DBs by the **current** implementation, and committed.
2. Every subsequent stage asserts **exact equality** against that file, not
   "close enough". Cost may compare to a fixed epsilon for IEEE-754 round-off
   only, matching the existing 3.6e-15 precedent; everything else is exact.
3. The reconciliation identity (13 columns, per day, per project) keeps running
   unchanged.
4. **A mutation check**: perturb one baseline number and confirm exactly one test
   goes red. Per CLAUDE.md, a guard that has not been watched fail is decoration.

---

## 12. Proposed staging

Mostly the prompt's, with three changes, each with a reason.

| Stage | Contents | Change from prompt |
|---|---|---|
| **3A** | Adapter contract · record envelope · `wt_*` schema (`WT_SCHEMA_VERSION` 1; `CC_SCHEMA_VERSION` stays 4) · ingest/cursor/health · identity+links · discovery · NDJSON boundary · **regression baseline frozen** | baseline moved **up** from 3B |
| **3B** | Claude projection adapter. `claude_*` → `wt_*`. Zero regression proven against 3A's baseline. | unchanged |
| **3C** | Source-aware read layer · server · charts · Claude views · **Sources view** | Sources view added |
| **4** | **Atlas adapter** — exact linking, checkpoints, commits, file touches. Provenance only, never usage. | **moved ahead of Codex** |
| **5** | Codex adapter · cross-tool Overview becomes meaningful | moved back one |
| **6** | OpenViking — **boundary reserved, adapter deferred** until its telemetry can actually be probed. Metrics only, never memory contents. | now explicitly gated on the source existing |
| **7** | External adapter SDK maturation. **Hermes as a health source only** — no activity, no spend, absent from cross-tool totals. | Hermes demoted per decision 2 |

**Why Atlas before Codex.** Atlas is the only source that exercises identity
linking and the authority rule — the two hardest, most reversible-if-wrong parts
of the whole design. Codex is a *second independent source*: valuable, but it
tests ingestion breadth, not the design's load-bearing beam. Atlas data exists on
this machine right now and the exact join key is already proven. If the authority
model is wrong, Atlas finds out at Stage 4 with 5 sessions rather than at Stage 5
after Codex's 96 files are already normalized against it.

Codex slips by one stage. Given that Codex logs are **not pruned** (96 files,
2025-08-30 → 2026-09-13, measured 2026-09-14), that costs no history — the same
measurement that settled the original build order.

---

## 13. Risks and open questions

**Risks**

1. **Scope.** This is a platform refactor with a dashboard attached, replacing a
   dashboard with a data model attached. 3A+3B ship *zero* user-visible change —
   the first visible output is 3C. That is a long runway, and it is the main cost
   of the reframe. Mitigation: 3A and 3B are individually small and fully
   test-covered; the regression baseline makes "nothing changed" a provable claim
   rather than a hopeful one.
2. ~~**`capture/` relocation touches `install.sh`** and the live
   `settings.json`.~~ **Retired 2026-09-14** — the move is deferred out of
   Stage 3 entirely (§9), so this stage touches no installed path.
3. **Atlas WAL.** `.atlas/sessions.db` had a 4.2 MB WAL during probing. It must be
   read via `.backup` or a read-only URI, never `cp` — CLAUDE.md already carries
   this rule for the Watchtower DB and it now applies to a second database.
4. **Atlas holds prompt text** (`agent_message.body`, `tool_call.arguments`,
   `.result`). This is the first source that does. Invariant 9 says do not store
   prompt text by default — so the Atlas adapter must **enumerate the columns it
   reads** rather than select-star and filter afterwards. An allowlist, not a
   denylist.
5. **OpenViking is unverified.** Nothing on :1933, no local install. Its adapter
   is designed against prose. It should not be implemented until the telemetry
   surface can be probed, or it will be built against an imagined API.
6. **`wt_usage` as a tall metric table** is flexible but slow to query and easy
   to make un-typed. Open question below.

**Open questions — ALL ANSWERED 2026-09-14. See §14.**

---

## 14. Decisions — answered 2026-09-14, do not re-ask

| # | Question | Decision |
|---|---|---|
| 1 | Normalized request storage | **Hybrid** — typed `wt_requests` columns for fields every coding agent has (tokens in/out/cache, model, cost, ts); `wt_usage` as the tall overflow for adapter-specific metrics. Biased to typed on the common path. |
| 2 | Hermes | **Health source only.** `~/.hermes/state.db` is a messaging gateway (`messages`, `hosted_rooms`, `gateway_heartbeats`, `messages_fts`) with no session/usage/token data. It may contribute source-health and uptime; it contributes **no activity and no spend**, and it does not appear in the Overview's cross-tool totals. |
| 3 | Database path | **Defer the move.** Resolution order: `WATCHTOWER_DB_PATH` → `THEONE_DB_PATH` *(deprecated alias)* → explicit config → existing `~/.theone/claude-code-usage.sqlite` → `~/.watchtower/watchtower.sqlite` **for fresh installs only**. Existing installs never move; TheOneOS keeps working unchanged. Implemented in **both** `lib/config.ts` and `capture/lib.sh` on 2026-09-15; the env-over-config order is corrected from this row's first draft. |
| 4 | Claude rollup tables | **Coexist permanently.** `claude_daily_rollups`, `claude_project_rollups` and `claude_rank_progress` are never removed. TheOneOS depends on them, the regression baseline reads them, and source-specific rollups may carry richer fields than the cross-tool schema allows. Duplication is the accepted price of never breaking a consumer. |
| 5 | Atlas `acp` session | **Not a coverage hole — retracted.** See below. |

### Decision 5 in full — a finding I got wrong, and what it revealed instead

§0 and the first draft of §13 called the `acp` session *"a small hole in Claude
coverage that Atlas has just revealed."* **That was wrong.** Investigated
2026-09-14:

```
session   <session-id>
started   2026-09-14 11:37:38 local     ended_at   NULL
events    SessionStart 1 · UserPromptSubmit 5 · Stop 4
transcript ~/.claude/projects/.../<session-id>.jsonl  — EXISTS, 99 usage rows
```

It is the **currently-running session** — this one. Hooks captured it correctly;
`claude_requests` is empty only because `ingest.sh` runs on `SessionEnd`, and it
has not ended. 100 live sessions share that shape. Nothing is missing.

**But the retraction exposes something the design does need.** Atlas observed
this session *live, via ACP*; Watchtower's request usage does not exist until the
session ends. That is a **per-source observation-latency difference**, not a bug:

- For a live session, Atlas has provenance and Watchtower has **no usage yet**.
- A cross-source view that treats "no usage rows" as "zero usage" will report the
  active session as idle and free.

Two consequences, both binding:

1. **`observedAt` vs `timestamp` (§5) is load-bearing, not a nicety.** It is what
   lets the normalized layer distinguish *has not been observed yet* from
   *observed to be zero* — the same distinction as "do not assert a measurement
   where there is none," applied across sources instead of across columns.
2. **`wt_sessions` needs an explicit ingest-completeness state** per source
   (`pending` / `complete`), so the Live view can say "usage pending, session in
   progress" rather than rendering a zero. Adding this to the §2 schema.

This is the second time in one day that comparing two observers of the same
events produced a correction. That is the method working, and it is the argument
for §11's regression baseline being frozen before anything moves.

---

## 15. Architecture decisions — answered 2026-09-14, binding

Eight calls I had made unilaterally under the brief's "make reasonable technical
decisions" instruction, put back to the user and confirmed or changed.

| # | Decision | Outcome |
|---|---|---|
| 6 | Staging order | **Atlas before Codex.** Atlas is the only source that exercises identity linking and the authority rule; it fails cheap at 5 sessions rather than after Codex's 96 files are normalized against a wrong model. Codex logs are unpruned, so the slip costs no history. |
| 7 | Regression baseline | **Frozen in 3A**, before any code moves. A baseline captured mid-refactor can silently encode the bug it exists to catch. |
| 8 | `capture/` → `capture/claude/` | **DEFERRED out of Stage 3** *(changed from my proposal, which gated it on a dry-run)*. Stage 3 touches no installed path at all. |
| 9 | Deduplication | **Authority declared at ingest.** One authoritative source per `(kind, metric)`; non-authoritative metrics rejected and counted, surfaced as source health. Not a post-hoc pass — wrong numbers must never exist in the DB, even transiently. |
| 10 | Atlas prompt text | **Column allowlist, never `SELECT *`.** The adapter enumerates what it reads and never touches `body`, `preview`, `arguments`, `result`. A denylist fails open; an allowlist fails closed. |
| 11 | OpenViking | **Boundary reserved, adapter deferred** until the telemetry surface can be probed. Nothing is built against prose. |
| 12 | External adapter authority | **Enrichment by default; authority only by explicit config grant.** A third-party NDJSON producer cannot claim ownership of Claude's token counts by asserting it in its own payload. |
| 13 | Inferred identity links | **Exact links only.** `confidence` column exists so the schema need not change later, but nothing writes `inferred` in Stage 3. Per the brief: do not invent uncertain links silently. |

### The one that changed, and why it is better

I proposed doing the `capture/` directory move inside Stage 3 behind a dry-run
gate. **Deferring it entirely is the stronger call.** The move's only benefit is
legibility for outside contributors; its cost is rewriting every installed script
path and editing the live `settings.json` — the single riskiest mechanical change
in the proposal — during the stage that is *also* introducing a new schema, a new
record model and a new ingest path.

With the deferral, **Stage 3 touches nothing under `~/.claude` at all.** That
makes invariant 7 ("capture paths must never break Claude Code") trivially true
for the whole stage rather than something the dry-run has to defend, and it means
a Stage 3 rollback cannot leave a half-installed tracker behind.

### What is now fully settled

Decisions 1–5 (§14) and 6–13 (§15), plus brainstorm decisions 1–6 and 9. The
architecture has no open questions remaining. The next gate is your review of
this document as a whole; on approval, the formal Stage 3 spec gets written,
self-reviewed against these invariants, and only then a plan.

---

## 16. Diffed against the source conversation — 2026-09-15

After Stage 3A was built, the implementation was compared line by line against
the original design conversation
(`docs/Blueprint/chatrgpt-watchtower-stage3 chat.md`). Six divergences — four
found on 2026-09-15, and two more on the re-check later the same day, both of
them in the *one* area the first pass had already ruled on and therefore skipped.
That is the lesson worth keeping: **a decision that is recorded is not thereby
implemented**, and a diff that checks the chat against the *documents* will
confirm its own paperwork. The last two were found by checking the chat against
the **code**.

### Two were real gaps, and are now fixed in 3A

1. **`wt_sources` had no `type` or `label`.** The conversation specifies a
   taxonomy — `claude`/`codex` = **agent**, `atlas` = **provenance**,
   `openviking` = **memory** — and we had shipped neither column.

   This is load-bearing, not cosmetic. `contributesToActivityTotals(type)` now
   gates what may enter cross-tool totals, and only `agent` qualifies. **The
   per-metric authority rule does not cover this case:** Atlas can be
   non-authoritative for every metric it reports and a naive
   `SUM(tokens) GROUP BY day` over `wt_requests` would still sweep its rows in.
   Authority governs *what is written*; type governs *what is counted*. Both are
   needed.

   A fourth type, `health`, was added for Hermes — the conversation predates
   decision 2, which demoted it from agent after its database turned out to be a
   messaging gateway.

2. **`lib/config.ts` had no `sources` stanza.** Spec §4 described one but no task
   implemented it, so auto-discovery had nowhere to read Atlas's `projectRoots`
   from, and the reframe brief's explicit requirement — *"configuration should
   permit disabling an auto-discovered source"* — was unmet. Added, with
   `dashboard`, both loudly validated. Absent `sources` means Claude only,
   enabled, so no pre-Stage-3 config breaks.

### One is a deliberate, recorded deferral

3. **`wt_daily_rollups` / `wt_project_rollups`** appear in the conversation's
   table list. Spec §6 defers them until a second source exists: with only
   Claude they would duplicate `claude_daily_rollups` exactly, for no gain, and
   decision 4 keeps the Claude rollups permanently anyway. They land in Stage 4
   alongside the Atlas adapter.

### One was missing from every document, including this one

4. **"Watchtower → OpenViking derived-insight publishing."** The conversation
   lists this as a *Later* stage — Watchtower feeding its derived insights back
   *into* OpenViking, rather than only reading from it. Every version of this
   architecture treated Watchtower purely as a consumer, so the direction was
   silently dropped.

   Recorded here as **Stage 8, unspecified**. It needs its own brainstorm: it
   inverts the dependency (Watchtower becomes a *writer* to another system),
   which raises questions none of the read-only adapter work answers — what is
   worth publishing, who owns the derived claim once it leaves, and how it
   avoids becoming the memory engine §"Product Direction" says Watchtower must
   not become. **Do not design it as part of the adapter framework.**

### Two more, found by re-checking against the code rather than the docs

5. **`WATCHTOWER_DB_PATH` was honoured by the reader and by nothing else.**
   Commit `66e0835` added the variable to `lib/config.ts`. `capture/lib.sh`'s
   `cc_db_path` still read `${THEONE_DB_PATH:-...}` alone, and every capture
   script routes through that one function.

   Setting the new, non-deprecated variable therefore pointed the **reader** at
   one file while all five **writers** kept filling another. Nothing failed:
   §"Invariants" makes every write on the hook path swallow its own error, so
   the symptom is a dashboard of zeros over a database that is still perfectly
   correct somewhere else. This is the same shape as the phantom-hours and
   281.7× defects — a disagreement that reports a number instead of an error.

   Fixed: `cc_db_path` resolves the documented order, and
   `tests/capture-scripts.test.ts` pins the two halves together, including one
   assertion against this machine's *real* resolved path.

6. **The fresh-install path was decided and never built.** Decision 3 defers the
   *move* of an existing database, not the *rename*: a machine with no legacy
   file is supposed to start at `~/.watchtower/watchtower.sqlite`. Neither half
   implemented the probe, so the default was unconditionally
   `~/.theone/claude-code-usage.sqlite` — meaning a first run in 2027 would still
   land in the Claude-centric filename this whole reframe exists to shed, and the
   chat's config change would have been documented into the spec and then quietly
   dropped.

   Exactly the failure mode of divergence 2: **a spec section with no task
   behind it.** Two of six divergences are now that same shape, which is worth
   treating as a standing check rather than a coincidence.

   Fixed in both `lib/config.ts` (`defaultDbPath`, with an injected probe so both
   branches are testable on any machine) and `capture/lib.sh`. Existing installs
   are untouched — verified against the live path on this machine, which still
   resolves to `~/.theone/claude-code-usage.sqlite`.

   A wording error in this document was corrected alongside it: §7 and decision 3
   both listed explicit config *ahead of* the environment variables. The code has
   always done the reverse, and must — every test in the repo points
   `THEONE_DB_PATH` at a `.backup` copy while a real config file sits in the
   working directory.
