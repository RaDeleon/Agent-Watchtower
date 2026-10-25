# Stage 3B — Claude Projection Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project the existing `claude_*` tables into the normalized `wt_*` tables through a real adapter, add the `watchtower sync` command that drives it, and prove the Claude numbers did not move.

**Architecture:** The adapter is a **projection, not a collector**. `capture/*.sh` are not touched; they keep writing `claude_*` exactly as today. `lib/adapters/claude/` reads those tables and emits `WatchtowerRecord`s through the Stage 3A envelope, which `ingestRecords` writes into `wt_*` under the authority rule. Session identity is established first — canonical ids minted, exact links written — because `ingestRecords` resolves `canonical_id` by looking up `wt_links`.

**Tech Stack:** TypeScript run directly by Node (no build step, type-stripping), `sqlite3` via `execFileSync`, vitest. **Zero runtime dependencies** — this is a hard constraint, not a preference.

**Spec:** `docs/superpowers/specs/2026-09-14-stage-3-spec.md` §3B, with the trigger model from `docs/superpowers/specs/2026-09-15-sync-trigger-and-surfaces-design.md`.

## Global Constraints

Every task's requirements implicitly include all of these. They are existing CLAUDE.md invariants; violating one silently corrupts data.

- **Zero runtime dependencies.** Nothing may be added to `package.json` dependencies.
- **The capture path is not touched.** No edits to `capture/hook.sh`, `snapshot.sh`, `ingest.sh`, `rollup.sh`, or `install.sh`. `capture/lib.sh` is off limits for this stage.
- **Tokens come from `claude_requests`, never from `claude_status_snapshots`.** The snapshot token columns are context-window *occupancy*; using them was wrong by 63× on input and 201× on output.
- **Snapshot counters are CUMULATIVE per session — `MAX` them, never `SUM` them.** Measured overcount if summed: 281.7× on `total_lines_added`.
- **Never aggregate requests through `claude_sessions`.** 22.4% of requests have no session row; joining drops them while the reconciliation identity still passes.
- **Never read `claude_sessions.duration_ms`.** It spans dormant calendar gaps — the ~10,389-hour phantom. Duration is not projected at all in this stage.
- **No model math in TypeScript.** A test fails the build if `MIN(gap,` appears anywhere in `lib/`. Grouping and labelling only.
- **`claude_requests` has no `project_path` column, deliberately.** Resolve `cwd` through `claude_project_paths` exactly as `rollup.sh` does.
- **Tests pin `TZ=UTC`** — the rollup buckets by *local* day.
- **A guard is not done until its defect has been planted and watched turn exactly one test red.**
- `bin/watchtower` must not use the `@/` path alias (that is a tsconfig/vitest alias; Node would resolve it as a package) and must use explicit `.ts` extensions on imports.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/adapters/claude/sessions.ts` | **Create.** Identity: mint canonical ids, write exact links, upsert `wt_sessions`, set per-source completeness. Writes to the DB directly, because records cannot reference a canonical id that does not exist yet. |
| `lib/adapters/claude/records.ts` | **Create.** Pure generators: `claude_*` rows → `WatchtowerRecord`s. No DB writes. |
| `lib/adapters/claude/index.ts` | **Create.** The `WatchtowerAdapter` object: identity, capabilities, authority claims, `detect()`, `health()`, `ingest()`. |
| `lib/core/sync.ts` | **Create.** `runSync()` — register enabled adapters, drive ingest, return a per-source summary. The single thing all three callers share. |
| `bin/watchtower` | **Modify.** Add the `sync` subcommand. |
| `docs/superpowers/specs/2026-09-14-stage-3-spec.md` | **Modify.** §3B.2 carries two mappings that cannot be implemented as written (Task 1). |
| `tests/claude-sessions.test.ts` | **Create.** Task 2. |
| `tests/claude-records.test.ts` | **Create.** Tasks 3–5. |
| `tests/claude-adapter.test.ts` | **Create.** Tasks 6–7. |
| `tests/core-sync.test.ts` | **Create.** Task 7. |
| `tests/claude-reconciliation.test.ts` | **Create.** Task 8 — the zero-regression gate. |

---

## Task 1: Correct two unimplementable mappings in the 3B spec

Reading the Stage 3A interfaces against §3B.2 surfaced two mappings that **cannot be built as written.** Both are corrected here, before any code depends on them, because every later task reads this section as binding.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-stage-3-spec.md` §3B.2

**Interfaces:**
- Consumes: nothing.
- Produces: the corrected authority declaration that Task 6 encodes verbatim.

**Defect 1 — `request.cost_usd` does not exist.** §3B.2 declares Claude authoritative for `request.{tokens_in,tokens_out,tokens_cache_read,tokens_cache_creation,cost_usd}`. `claude_requests` has **no `cost_usd` column** (`capture/lib.sh`, the `CREATE TABLE claude_requests` block). Cost is only ever observed per *session*, as `claude_status_snapshots.total_cost_usd`, and `rollup.sh:423` reads it as `MAX(total_cost_usd) ... GROUP BY session_id`. There is no per-request cost to project.

**Defect 2 — `wt_events.kind ← hook_event_name` is rejected by the validator.** §3B.2 maps `claude_events.hook_event_name` onto the record kind. `validateRecord` throws on any kind outside `RECORD_KINDS` (`session, request, usage, tool, memory, git, checkpoint, health, event, custom`), and `"SessionStart"` is not among them. `writeEvent` then writes `r.kind` verbatim into `wt_events.kind`, so the hook name has nowhere to land.

- [ ] **Step 1: Correct the authority declaration**

Replace the authority sentence in §3B.2 with:

```markdown
**Claude is authoritative for** `request.{tokens_in,tokens_out,tokens_cache_read,tokens_cache_creation}`,
`session.{cost_usd,lines_added,lines_removed}` and `session.*`.

**Cost is a SESSION metric, not a request metric.** `claude_requests` has no
`cost_usd` column; cost is observed only as `claude_status_snapshots.total_cost_usd`,
a cumulative per-session counter that `rollup.sh:423` reads as `MAX(...) GROUP BY
session_id`. Declaring `request.cost_usd` would claim authority over a metric no
Claude record can ever carry, and would silently block a future source that can.
```

- [ ] **Step 2: Correct the `wt_events` mapping row**

Replace the `wt_events` row of the §3B.2 table with:

```markdown
| `wt_events` | `claude_events` | `kind = 'event'`; the hook name goes to `dimensions.hook_event_name`. |
```

And add below the table:

```markdown
**Why the hook name is a dimension, not the kind.** `RECORD_KINDS` is a closed
set the envelope validator enforces, and `SessionStart` is not in it. Widening
that set per source is exactly the "force every source into one shape" failure
the taxonomy exists to avoid: `hook_event_name` is Claude-specific vocabulary,
and Claude-specific vocabulary belongs in `dimensions`.
```

- [ ] **Step 3: Verify no other document still claims the old mapping**

Run:
```bash
grep -rn "request.cost_usd\|kind ← hook_event_name\|kind <- hook_event_name" docs/superpowers/specs/
```
Expected: no matches.

Scoped to `specs/` deliberately. `docs/superpowers/plans/` contains THIS plan, which
quotes both strings in order to explain the correction, so an unscoped `docs/` grep can
never come back empty and would report a failure that is the plan describing itself.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-14-stage-3-spec.md
git commit -m "docs(stage-3b): correct two mappings that cannot be implemented

request.cost_usd claims a column claude_requests does not have -- cost is only
ever a cumulative per-session snapshot counter, MAX'd per session by
rollup.sh:423. Declaring it would claim authority over a metric no Claude
record can carry, and block a future source that can.

wt_events.kind <- hook_event_name is refused by validateRecord: RECORD_KINDS is
a closed set and SessionStart is not in it. The hook name is Claude-specific
vocabulary, so it becomes dimensions.hook_event_name."
```

---

## Task 2: Session identity — canonical ids, exact links, completeness

**Files:**
- Create: `lib/adapters/claude/sessions.ts`
- Test: `tests/claude-sessions.test.ts`

**Interfaces:**
- Consumes: `mintCanonicalId()`, `upsertSession()`, `linkExact()`, `resolveCanonicalId()`, `setSessionState()` from `lib/core/identity.ts`; `querySql`, `sqlStr` from `lib/core/sql.ts`; `applyWtSchema` from `lib/core/schema.ts`.
- Produces: `projectClaudeSessions(db: string): number` — returns the number of sessions projected. Task 6 calls it at the head of `ingest()`.

- [ ] **Step 1: Write the failing test**

Create `tests/claude-sessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { applyWtSchema } from "@/lib/core/schema";
import { projectClaudeSessions } from "@/lib/adapters/claude/sessions";

/** A fixture DB with the wt_* schema applied over it. */
function projected(scenario: string): string {
  const db = buildAndRoll(scenario);
  applyWtSchema(db);
  projectClaudeSessions(db);
  return db;
}

describe("projectClaudeSessions", () => {
  it("mints one canonical session per claude_sessions row", () => {
    const db = projected("two-sessions-day");
    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_sessions;")[0].n;
    const out = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_sessions;")[0].n;
    expect(out).toBe(src);
    expect(out).toBeGreaterThan(0);
  });

  it("writes an EXACT link whose evidence is the session id it joined on", () => {
    const db = projected("two-sessions-day");
    const links = rows<{ source: string; source_local_id: string; link_kind: string;
                        confidence: string; evidence: string }>(
      db, "SELECT * FROM wt_links ORDER BY source_local_id;");
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.source).toBe("claude");
      expect(l.link_kind).toBe("same_session");
      expect(l.confidence).toBe("exact");
      // The audit trail must name the key actually used, not a restatement.
      expect(l.evidence).toBe(`claude_sessions.session_id=${l.source_local_id}`);
    }
  });

  it("is idempotent: a second run mints no new canonical ids", () => {
    const db = projected("two-sessions-day");
    const first = rows<{ id: string }>(db,
      "SELECT canonical_id AS id FROM wt_sessions ORDER BY canonical_id;");
    projectClaudeSessions(db);
    const second = rows<{ id: string }>(db,
      "SELECT canonical_id AS id FROM wt_sessions ORDER BY canonical_id;");
    expect(second).toEqual(first);
  });

  it("marks a session with no ingested requests 'pending', not complete", () => {
    // partial-transcript-coverage has sessions on both sides of this line.
    const db = projected("partial-transcript-coverage");
    const states = rows<{ session_id: string; state: string; reqs: number }>(db, `
      SELECT l.source_local_id AS session_id, st.state AS state,
             (SELECT COUNT(*) FROM claude_requests r
               WHERE r.session_id = l.source_local_id) AS reqs
        FROM wt_links l
        JOIN wt_session_state st ON st.canonical_id = l.canonical_id
       WHERE st.source = 'claude';`);
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(`${s.session_id}: ${s.state}`)
        .toBe(`${s.session_id}: ${s.reqs > 0 ? "complete" : "pending"}`);
    }
  });

  it("never reads duration_ms", () => {
    const src = readFileSync(
      path.resolve(__dirname, "..", "lib", "adapters", "claude", "sessions.ts"), "utf8");
    expect(src).not.toContain("duration_ms");
  });
});
```

Add the two imports the last test needs at the top of the file:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/claude-sessions.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/claude/sessions`.

- [ ] **Step 3: Write the implementation**

Create `lib/adapters/claude/sessions.ts`:

```ts
import { querySql, sqlStr } from "../../core/sql.ts";
import {
  mintCanonicalId, upsertSession, linkExact, resolveCanonicalId, setSessionState,
} from "../../core/identity.ts";

export const CLAUDE_SOURCE = "claude";

interface SessionRow {
  session_id: string;
  cwd: string | null;
  repo: string | null;
  project_path: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  request_count: number;
}

/**
 * Establish canonical identity for every Claude session.
 *
 * This runs BEFORE any record is ingested, because ingestRecords resolves
 * canonical_id by reading wt_links -- a record yielded before its link exists
 * would be written with a NULL canonical_id and never revisited.
 *
 * The raw wall-clock duration column on claude_sessions is deliberately absent
 * from the projection AND from this query. A session_id survives --resume, so
 * ended_at - started_at spans every dormant calendar gap; the only valid
 * duration is window_s, summed per gap by rollup.sh, and it stays in claude_*.
 *
 * The rationale is worded without naming that column literally, because Step 1's
 * guard test asserts the identifier does not appear anywhere in this file -- and a
 * comment explaining the ban would otherwise trip it.
 */
export function projectClaudeSessions(db: string): number {
  const sessions = querySql<SessionRow>(db, `
    SELECT s.session_id, s.cwd, s.repo, s.project_path, s.model,
           s.started_at, s.ended_at,
           (SELECT COUNT(*) FROM claude_requests r
             WHERE r.session_id = s.session_id) AS request_count
      FROM claude_sessions s
     WHERE s.session_id IS NOT NULL AND s.session_id != ''
     ORDER BY s.session_id;`);

  for (const s of sessions) {
    // Re-use the canonical id this session already has. Minting a fresh one on
    // every run would orphan every record written under the previous id.
    const canonicalId =
      resolveCanonicalId(db, CLAUDE_SOURCE, s.session_id, "same_session") ?? mintCanonicalId();

    upsertSession(db, {
      canonicalId,
      firstSource: CLAUDE_SOURCE,
      startedAt: s.started_at ?? undefined,
      endedAt: s.ended_at ?? undefined,
      project: s.project_path ?? undefined,
      repo: s.repo ?? undefined,
      agent: CLAUDE_SOURCE,
      model: s.model ?? undefined,
    });

    linkExact(db, {
      source: CLAUDE_SOURCE,
      sourceLocalId: s.session_id,
      linkKind: "same_session",
      canonicalId,
      evidence: `claude_sessions.session_id=${s.session_id}`,
    });

    // "Has a transcript but no ingested requests" is pending, NOT zero usage.
    // Measured 2026-09-14: 100 live sessions have exactly this shape.
    setSessionState(db, canonicalId, CLAUDE_SOURCE,
      s.request_count > 0 ? "complete" : "pending");
  }

  return sessions.length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/claude-sessions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-check the idempotence guard**

Temporarily replace the `resolveCanonicalId(...) ?? mintCanonicalId()` line with a bare `mintCanonicalId()`.
Run: `npx vitest run tests/claude-sessions.test.ts`
Expected: exactly one test red — "is idempotent: a second run mints no new canonical ids".
Then restore the line.

- [ ] **Step 6: Commit**

```bash
git add lib/adapters/claude/sessions.ts tests/claude-sessions.test.ts
git commit -m "feat(stage-3b): canonical identity for Claude sessions

Runs before any record is ingested, because ingestRecords resolves canonical_id
out of wt_links -- a record yielded ahead of its link lands with a NULL
canonical id and is never revisited.

Re-uses an existing canonical id rather than minting per run, which would
orphan every record written under the previous one. duration_ms is absent from
the projection and from the query."
```

---

## Task 3: Request projection

**Files:**
- Create: `lib/adapters/claude/records.ts`
- Test: `tests/claude-records.test.ts`

**Interfaces:**
- Consumes: `querySql` from `lib/core/sql.ts`; `WatchtowerRecord` from `lib/core/records.ts`.
- Produces: `claudeRequestRecords(db: string): Generator<WatchtowerRecord>` and `epochToRfc3339(s: number): string`. Tasks 4, 5 and 6 use both.

- [ ] **Step 1: Write the failing test**

Create `tests/claude-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { claudeRequestRecords, epochToRfc3339 } from "@/lib/adapters/claude/records";
import { validateRecord } from "@/lib/core/records";

describe("claudeRequestRecords", () => {
  it("emits one record per claude_requests row, including rows with no session", () => {
    // orphan-request-tokens exists precisely because 22.4% of requests have no
    // claude_sessions row. A projection that joins through sessions drops them.
    const db = buildAndRoll("orphan-request-tokens");
    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_requests;")[0].n;
    const got = [...claudeRequestRecords(db)];
    expect(got.length).toBe(src);
    expect(src).toBeGreaterThan(0);
  });

  it("emits records the Stage 3A validator accepts unchanged", () => {
    const db = buildAndRoll("orphan-request-tokens");
    for (const r of claudeRequestRecords(db)) {
      expect(() => validateRecord(r)).not.toThrow();
    }
  });

  it("carries the token columns as metrics and nothing from snapshots", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const byId = new Map([...claudeRequestRecords(db)].map((r) => [r.sourceRecordId, r]));
    const src = rows<{ request_id: string; tokens_in: number; tokens_out: number }>(
      db, "SELECT request_id, tokens_in, tokens_out FROM claude_requests;");
    for (const row of src) {
      const rec = byId.get(row.request_id)!;
      expect(`${row.request_id}:${rec.metrics?.tokens_in}`)
        .toBe(`${row.request_id}:${row.tokens_in}`);
      expect(`${row.request_id}:${rec.metrics?.tokens_out}`)
        .toBe(`${row.request_id}:${row.tokens_out}`);
      // Cost is NOT a request metric -- see Task 1.
      expect(rec.metrics?.cost_usd).toBeUndefined();
    }
  });

  it("maps is_sidechain onto is_subagent", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const byId = new Map([...claudeRequestRecords(db)].map((r) => [r.sourceRecordId, r]));
    const src = rows<{ request_id: string; is_sidechain: number }>(
      db, "SELECT request_id, COALESCE(is_sidechain,0) AS is_sidechain FROM claude_requests;");
    for (const row of src) {
      expect(`${row.request_id}:${byId.get(row.request_id)!.dimensions?.is_subagent}`)
        .toBe(`${row.request_id}:${row.is_sidechain === 1}`);
    }
  });

  it("resolves project through claude_project_paths, not from a column", () => {
    // mixed-projects-one-day, NOT four-projects: the latter carries zero
    // claude_requests rows, so this test's own non-vacuity assertion below
    // could never pass against it.
    const db = buildAndRoll("mixed-projects-one-day");
    const byId = new Map([...claudeRequestRecords(db)].map((r) => [r.sourceRecordId, r]));
    const src = rows<{ request_id: string; project_path: string | null }>(db, `
      SELECT r.request_id, p.project_path
        FROM claude_requests r
        LEFT JOIN claude_project_paths p ON p.cwd = r.cwd;`);
    expect(src.length).toBeGreaterThan(0);
    for (const row of src) {
      expect(`${row.request_id}:${byId.get(row.request_id)!.project ?? null}`)
        .toBe(`${row.request_id}:${row.project_path ?? null}`);
    }
  });

  it("declares itself authoritative", () => {
    const db = buildAndRoll("orphan-request-tokens");
    for (const r of claudeRequestRecords(db)) expect(r.authority).toBe("authoritative");
  });
});

describe("epochToRfc3339", () => {
  it("emits an explicit UTC offset, which the validator requires", () => {
    expect(epochToRfc3339(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(epochToRfc3339(1757894400).endsWith("Z")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/claude-records.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/claude/records`.

- [ ] **Step 3: Write the implementation**

Create `lib/adapters/claude/records.ts`:

```ts
import { querySql } from "../../core/sql.ts";
import type { WatchtowerRecord } from "../../core/records.ts";

export const CLAUDE_SOURCE = "claude";

/**
 * Epoch seconds -> RFC3339 with an EXPLICIT offset.
 *
 * validateRecord refuses a naked local time: rollup.sh buckets by local day, so
 * an offset-less timestamp is ambiguous and accepting one silently corrupts day
 * buckets for every source. toISOString always ends in Z, which qualifies.
 */
export function epochToRfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

interface RequestRow {
  request_id: string;
  session_id: string | null;
  ts: number;
  project_path: string | null;
  repo: string | null;
  git_branch: string | null;
  model: string | null;
  is_sidechain: number;
  tokens_in: number; tokens_out: number;
  tokens_cache_read: number; tokens_cache_creation: number;
  api_error_status: string | null;
}

/**
 * Every row of claude_requests, as a canonical record.
 *
 * The LEFT JOIN is to claude_project_paths and NOT to claude_sessions. 22.4% of
 * requests predate the tracker and have no session row; an inner join through
 * claude_sessions drops them while the reconciliation identity still passes,
 * which is why that specific join is prohibited rather than merely discouraged.
 *
 * claude_requests deliberately carries no project_path column -- cwd resolves
 * through the claude_project_paths cache at read time, exactly as rollup.sh
 * does it.
 */
export function* claudeRequestRecords(db: string): Generator<WatchtowerRecord> {
  const rows = querySql<RequestRow>(db, `
    SELECT r.request_id, r.session_id, r.ts,
           p.project_path AS project_path,
           r.git_branch, r.model,
           COALESCE(r.is_sidechain, 0) AS is_sidechain,
           COALESCE(r.tokens_in, 0)              AS tokens_in,
           COALESCE(r.tokens_out, 0)             AS tokens_out,
           COALESCE(r.tokens_cache_read, 0)      AS tokens_cache_read,
           COALESCE(r.tokens_cache_creation, 0)  AS tokens_cache_creation,
           r.api_error_status,
           NULL AS repo
      FROM claude_requests r
      LEFT JOIN claude_project_paths p ON p.cwd = r.cwd
     WHERE r.ts IS NOT NULL
     ORDER BY r.request_id;`);

  for (const row of rows) {
    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: row.request_id,
      kind: "request",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id ?? undefined,
      project: row.project_path ?? undefined,
      branch: row.git_branch ?? undefined,
      agent: CLAUDE_SOURCE,
      model: row.model ?? undefined,
      metrics: {
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        tokens_cache_read: row.tokens_cache_read,
        tokens_cache_creation: row.tokens_cache_creation,
      },
      dimensions: {
        is_subagent: row.is_sidechain === 1,
        ...(row.api_error_status ? { error_status: row.api_error_status } : {}),
      },
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/claude-records.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the orphan guard**

Temporarily change the `LEFT JOIN claude_project_paths` clause to also
`JOIN claude_sessions s ON s.session_id = r.session_id`.
Run: `npx vitest run tests/claude-records.test.ts`
Expected: the guard test red — "emits one record per claude_requests row, including rows with
no session" — failing on the count, cleanly. Two neighbouring tests that share the orphan
fixture will also fail, with a `TypeError` on a map lookup that now misses; that is collateral
from the same defect, not a second defect. What matters is that the guard fails on its
assertion rather than passing.
Then restore.

- [ ] **Step 6: Commit**

```bash
git add lib/adapters/claude/records.ts tests/claude-records.test.ts
git commit -m "feat(stage-3b): project claude_requests into canonical records

The join is to claude_project_paths, never to claude_sessions: 22.4% of
requests predate the tracker and an inner join through sessions drops them
while the reconciliation identity still passes.

Cost is absent by design (Task 1) -- claude_requests has no such column."
```

---

## Task 4: Event and tool projection

**Files:**
- Modify: `lib/adapters/claude/records.ts`
- Test: `tests/claude-records.test.ts`

**Interfaces:**
- Consumes: `epochToRfc3339`, `querySql`.
- Produces: `claudeEventRecords(db: string): Generator<WatchtowerRecord>` and `claudeToolRecords(db: string): Generator<WatchtowerRecord>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/claude-records.test.ts`:

```ts
import { claudeEventRecords, claudeToolRecords } from "@/lib/adapters/claude/records";

describe("claudeEventRecords", () => {
  it("emits one record per claude_events row", () => {
    const db = buildAndRoll("two-sessions-day");
    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_events;")[0].n;
    expect([...claudeEventRecords(db)].length).toBe(src);
    expect(src).toBeGreaterThan(0);
  });

  it("puts the hook name in dimensions, and keeps kind inside RECORD_KINDS", () => {
    const db = buildAndRoll("two-sessions-day");
    const recs = [...claudeEventRecords(db)];
    const names = new Set(rows<{ n: string }>(db,
      "SELECT DISTINCT hook_event_name AS n FROM claude_events;").map((r) => r.n));
    for (const r of recs) {
      expect(r.kind).toBe("event");                     // NOT "SessionStart"
      expect(names.has(String(r.dimensions?.hook_event_name))).toBe(true);
      expect(() => validateRecord(r)).not.toThrow();
    }
  });
});

describe("claudeToolRecords", () => {
  it("emits a tool record only where an attribution column is present", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const expected = rows<{ n: number }>(db, `
      SELECT COUNT(*) AS n FROM claude_requests
       WHERE COALESCE(attribution_skill, attribution_mcp_tool,
                      attribution_plugin) IS NOT NULL;`)[0].n;
    expect([...claudeToolRecords(db)].length).toBe(expected);
  });

  it("always carries tool_name, which wt_tools requires NOT NULL", () => {
    const db = buildAndRoll("orphan-request-tokens");
    for (const r of claudeToolRecords(db)) {
      expect(typeof r.dimensions?.tool_name).toBe("string");
      expect(r.dimensions?.tool_name).not.toBe("");
      expect(() => validateRecord(r)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/claude-records.test.ts`
Expected: FAIL — `claudeEventRecords` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/adapters/claude/records.ts`:

```ts
interface EventRow {
  id: number; ts: number; session_id: string | null;
  hook_event_name: string; project_path: string | null;
  repo: string | null; payload_json: string | null;
}

/**
 * claude_events -> canonical events.
 *
 * kind is 'event' for every row and the hook name rides in dimensions.
 * RECORD_KINDS is a closed set the validator enforces, and hook_event_name is
 * Claude-specific vocabulary -- widening the shared set for one source's
 * wording is the failure the taxonomy exists to prevent. See spec §3B.2.
 *
 * source_record_id is the autoincrement id, which is the only unique key
 * claude_events has.
 */
export function* claudeEventRecords(db: string): Generator<WatchtowerRecord> {
  const rows = querySql<EventRow>(db, `
    SELECT id, ts, session_id, hook_event_name, project_path, repo, payload_json
      FROM claude_events
     WHERE ts IS NOT NULL AND hook_event_name IS NOT NULL
     ORDER BY id;`);

  for (const row of rows) {
    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: String(row.id),
      kind: "event",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id ?? undefined,
      project: row.project_path ?? undefined,
      repo: row.repo ?? undefined,
      agent: CLAUDE_SOURCE,
      dimensions: { hook_event_name: row.hook_event_name },
      ...(row.payload_json ? { metadata: { payload: row.payload_json } } : {}),
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}

interface ToolRow {
  request_id: string; ts: number; session_id: string | null;
  project_path: string | null;
  attribution_skill: string | null;
  attribution_mcp_server: string | null;
  attribution_mcp_tool: string | null;
  attribution_plugin: string | null;
}

/**
 * claude_requests' attribution columns -> tool records.
 *
 * Only rows that actually name a tool are emitted. wt_tools.tool_name is NOT NULL
 * and writeTool counts a nameless record as malformed, so emitting a row per
 * request would turn most of the archive into a malformed-record count.
 *
 * The id is suffixed so it can never collide with the request record drawn
 * from the same row: wt_requests and wt_tools are different tables, but a
 * shared source_record_id would make the two rows indistinguishable in any
 * union across them.
 */
export function* claudeToolRecords(db: string): Generator<WatchtowerRecord> {
  const rows = querySql<ToolRow>(db, `
    SELECT r.request_id, r.ts, r.session_id, p.project_path,
           r.attribution_skill, r.attribution_mcp_server,
           r.attribution_mcp_tool, r.attribution_plugin
      FROM claude_requests r
      LEFT JOIN claude_project_paths p ON p.cwd = r.cwd
     WHERE r.ts IS NOT NULL
       AND COALESCE(r.attribution_skill, r.attribution_mcp_tool,
                    r.attribution_plugin) IS NOT NULL
     ORDER BY r.request_id;`);

  for (const row of rows) {
    const name = row.attribution_skill ?? row.attribution_mcp_tool ?? row.attribution_plugin;
    if (name === null || name === "") continue;
    const kind = row.attribution_skill ? "skill"
      : row.attribution_mcp_tool ? "mcp" : "plugin";

    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: `${row.request_id}:tool`,
      kind: "tool",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id ?? undefined,
      project: row.project_path ?? undefined,
      agent: CLAUDE_SOURCE,
      dimensions: {
        tool_name: name,
        tool_kind: kind,
        ...(row.attribution_mcp_server ? { server: row.attribution_mcp_server } : {}),
      },
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/claude-records.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/adapters/claude/records.ts tests/claude-records.test.ts
git commit -m "feat(stage-3b): project claude_events and tool attribution

kind stays inside RECORD_KINDS and the hook name rides in dimensions: the
validator enforces a closed set, and widening it for one source's vocabulary is
what the taxonomy exists to prevent.

Tool records are emitted only where an attribution column names a tool --
wt_tools.tool_name is NOT NULL, so a row per request would turn most of the
archive into a malformed count."
```

---

## Task 5: Session-level cost and line counts from snapshots

**Files:**
- Modify: `lib/adapters/claude/records.ts`
- Test: `tests/claude-records.test.ts`

**Interfaces:**
- Consumes: `epochToRfc3339`, `querySql`.
- Produces: `claudeSessionMetricRecords(db: string): Generator<WatchtowerRecord>`.

**This is the task the 281.7× defect lives in.** `claude_status_snapshots` carries running totals, so `SUM` over its rows multiplies by the number of snapshots. `MAX` per session is the only correct reduction, and it is what `rollup.sh:423` already does.

- [ ] **Step 1: Write the failing test**

Append to `tests/claude-records.test.ts`:

```ts
import { claudeSessionMetricRecords } from "@/lib/adapters/claude/records";

describe("claudeSessionMetricRecords", () => {
  it("takes MAX per session, never SUM — the 281.7x defect", () => {
    // dup-snapshot exists because this is the failure mode: several snapshot
    // rows per session, each carrying a running total.
    const db = buildAndRoll("dup-snapshot");
    const recs = [...claudeSessionMetricRecords(db)];
    const expected = rows<{ session_id: string; cost: number; added: number }>(db, `
      SELECT session_id,
             MAX(COALESCE(total_cost_usd,0))     AS cost,
             MAX(COALESCE(total_lines_added,0))  AS added
        FROM claude_status_snapshots
       WHERE session_id IS NOT NULL
       GROUP BY session_id;`);
    expect(recs.length).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);

    const byId = new Map(recs.map((r) => [r.sourceRecordId, r]));
    for (const e of expected) {
      const got = byId.get(e.session_id)!;
      expect(`${e.session_id}:cost:${got.metrics?.cost_usd}`)
        .toBe(`${e.session_id}:cost:${e.cost}`);
      expect(`${e.session_id}:added:${got.metrics?.lines_added}`)
        .toBe(`${e.session_id}:added:${e.added}`);
    }
  });

  it("carries no token metric at all — tokens come from claude_requests", () => {
    const db = buildAndRoll("dup-snapshot");
    for (const r of claudeSessionMetricRecords(db)) {
      for (const key of Object.keys(r.metrics ?? {})) {
        expect(key.startsWith("tokens")).toBe(false);
      }
    }
  });

  it("emits kind 'session' records the validator accepts", () => {
    const db = buildAndRoll("dup-snapshot");
    for (const r of claudeSessionMetricRecords(db)) {
      expect(r.kind).toBe("session");
      expect(() => validateRecord(r)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/claude-records.test.ts`
Expected: FAIL — `claudeSessionMetricRecords` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/adapters/claude/records.ts`:

```ts
interface SessionMetricRow {
  session_id: string; ts: number;
  cost_usd: number; lines_added: number; lines_removed: number;
}

/**
 * Session-level metrics drawn from claude_status_snapshots.
 *
 * MAX per session, NEVER SUM. That table carries CUMULATIVE running totals, so
 * summing a column across its rows multiplies it by the number of snapshots:
 * measured on total_lines_added, the naive sum gives 80,885,856 against a true
 * 287,125 -- a 281.7x overcount. rollup.sh:423 already reduces cost this way.
 *
 * Three metrics and no more. The token columns on this table are context-window
 * OCCUPANCY, not consumption; taking them was wrong by 63x on input and 201x on
 * output, and is the defect Stage 2 exists to correct.
 */
export function* claudeSessionMetricRecords(db: string): Generator<WatchtowerRecord> {
  const rows = querySql<SessionMetricRow>(db, `
    SELECT session_id,
           MAX(ts)                                AS ts,
           MAX(COALESCE(total_cost_usd, 0))       AS cost_usd,
           MAX(COALESCE(total_lines_added, 0))    AS lines_added,
           MAX(COALESCE(total_lines_removed, 0))  AS lines_removed
      FROM claude_status_snapshots
     WHERE session_id IS NOT NULL AND session_id != ''
     GROUP BY session_id
     ORDER BY session_id;`);

  for (const row of rows) {
    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: row.session_id,
      kind: "session",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id,
      agent: CLAUDE_SOURCE,
      metrics: {
        cost_usd: row.cost_usd,
        lines_added: row.lines_added,
        lines_removed: row.lines_removed,
      },
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/claude-records.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Mutation-check the MAX guard — this is the important one**

Temporarily change `MAX(COALESCE(total_lines_added, 0))` to `SUM(COALESCE(total_lines_added, 0))`.
Run: `npx vitest run tests/claude-records.test.ts`
Expected: exactly one test red — "takes MAX per session, never SUM — the 281.7x defect".
Then restore.

- [ ] **Step 6: Commit**

```bash
git add lib/adapters/claude/records.ts tests/claude-records.test.ts
git commit -m "feat(stage-3b): session cost and line counts, MAX per session

claude_status_snapshots carries cumulative running totals; summing a column
across its rows multiplies it by the snapshot count. Measured on
total_lines_added: 80,885,856 against a true 287,125, a 281.7x overcount.

Three metrics and no more. The token columns on that table are context-window
occupancy, not consumption -- 63x and 201x wrong, which is why Stage 2 exists."
```

---

## Task 6: The adapter object

**Files:**
- Create: `lib/adapters/claude/index.ts`
- Test: `tests/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `projectClaudeSessions`; the four record generators; `WatchtowerAdapter`, `DetectionResult`, `AdapterHealth` from `lib/core/adapters.ts`.
- Produces: `createClaudeAdapter(opts: { db: string }): WatchtowerAdapter`. Task 7 constructs it.

- [ ] **Step 1: Write the failing test**

Create `tests/claude-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { applyWtSchema } from "@/lib/core/schema";
import { registerSource, isAuthoritative, safeDetect, safeHealth } from "@/lib/core/adapters";
import { createClaudeAdapter } from "@/lib/adapters/claude";

describe("createClaudeAdapter", () => {
  it("declares itself an agent, which is what may enter cross-tool totals", () => {
    const a = createClaudeAdapter({ db: "/nonexistent.sqlite" });
    expect(a.id).toBe("claude");
    expect(a.type).toBe("agent");
    expect(a.label).toBe("Claude Code");
  });

  it("claims token authority per request and cost per SESSION, not per request", () => {
    const db = buildAndRoll("orphan-request-tokens");
    applyWtSchema(db);
    const a = createClaudeAdapter({ db });
    registerSource(db, a);

    expect(isAuthoritative(db, "claude", "request", "tokens_in")).toBe(true);
    expect(isAuthoritative(db, "claude", "session", "cost_usd")).toBe(true);
    // The mapping corrected in Task 1: no Claude record can carry this.
    expect(isAuthoritative(db, "claude", "request", "cost_usd")).toBe(false);
  });

  it("detect() is true where the claude_* tables exist, false on an empty file", () => {
    const real = buildAndRoll("two-sessions-day");
    expect((await safeDetect(createClaudeAdapter({ db: real }))).detected).toBe(true);
    expect((await safeDetect(createClaudeAdapter({ db: "/nonexistent.sqlite" })))
      .detected).toBe(false);
  });

  it("ingest() establishes identity before yielding a record that needs it", async () => {
    const db = buildAndRoll("two-sessions-day");
    applyWtSchema(db);
    const a = createClaudeAdapter({ db });
    const seen: string[] = [];
    for await (const r of a.ingest()) seen.push(r.kind);
    // The links exist by the time the first record is out.
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_links;")[0].n)
      .toBeGreaterThan(0);
    expect(seen).toContain("request");
    expect(seen).toContain("event");
  });
});
```

Mark the `detect()` test `async` — it uses `await`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/claude-adapter.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/claude`.

- [ ] **Step 3: Write the implementation**

Create `lib/adapters/claude/index.ts`:

```ts
import { existsSync } from "node:fs";
import type {
  AdapterHealth, DetectionResult, WatchtowerAdapter,
} from "../../core/adapters.ts";
import type { WatchtowerRecord } from "../../core/records.ts";
import { querySql } from "../../core/sql.ts";
import { projectClaudeSessions } from "./sessions.ts";
import {
  claudeRequestRecords, claudeEventRecords, claudeToolRecords,
  claudeSessionMetricRecords,
} from "./records.ts";

export const CLAUDE_ADAPTER_VERSION = 1;

/**
 * The Claude adapter is a PROJECTION, not a collector.
 *
 * capture/*.sh keep writing claude_* exactly as they do today; this reads those
 * tables and emits canonical records. That is the difference between wrapping a
 * trusted implementation and rewriting it, and it is what keeps "a tracker must
 * never break Claude Code" trivially true -- nothing on the hook path is
 * involved at all.
 */
export function createClaudeAdapter(opts: { db: string }): WatchtowerAdapter {
  const db = opts.db;

  return {
    id: "claude",
    type: "agent",
    label: "Claude Code",
    version: CLAUDE_ADAPTER_VERSION,
    capabilities: ["sessions", "requests", "tools", "git"],

    // Cost is a SESSION claim. claude_requests has no cost column, and claiming
    // request.cost_usd would lock a metric no Claude record can ever carry --
    // permanently blocking a future source that can. See spec §3B.2.
    authority: [
      { kind: "request", metrics: [
        "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation"] },
      { kind: "session", metrics: ["cost_usd", "lines_added", "lines_removed"] },
    ],

    async detect(): Promise<DetectionResult> {
      if (!existsSync(db)) return { detected: false, detail: `no database at ${db}` };
      const t = querySql<{ name: string }>(db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name='claude_requests';`);
      return t.length > 0
        ? { detected: true, detail: db }
        : { detected: false, detail: "no claude_* tables" };
    },

    async health(): Promise<AdapterHealth> {
      const d = await this.detect();
      if (!d.detected) return { state: "unavailable", detail: d.detail };
      const n = querySql<{ n: number }>(db,
        `SELECT COUNT(*) AS n FROM claude_requests;`)[0].n;
      // Zero requests is not brokenness: a fresh install has captured nothing
      // yet. It is reported as degraded so the Sources view can say so.
      return n > 0 ? { state: "ok", detail: `${n} requests` }
                   : { state: "degraded", detail: "no requests captured yet" };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      // Identity FIRST. ingestRecords resolves canonical_id out of wt_links, so
      // a record yielded before its link exists is written with a NULL
      // canonical id and never revisited.
      projectClaudeSessions(db);

      yield* claudeSessionMetricRecords(db);
      yield* claudeRequestRecords(db);
      yield* claudeToolRecords(db);
      yield* claudeEventRecords(db);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/claude-adapter.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/adapters/claude/index.ts tests/claude-adapter.test.ts
git commit -m "feat(stage-3b): the Claude adapter

Identity runs first inside ingest(): ingestRecords resolves canonical_id out of
wt_links, so a record yielded ahead of its link lands NULL and is never
revisited.

Authority claims tokens per request and cost per session. Claiming
request.cost_usd would lock a metric no Claude record can carry and block a
future source that can."
```

---

## Task 7: `runSync` and the `watchtower sync` command

**Files:**
- Create: `lib/core/sync.ts`
- Modify: `bin/watchtower`
- Test: `tests/core-sync.test.ts`

**Interfaces:**
- Consumes: `createClaudeAdapter`, `registerSource`, `ingestRecords`, `applyWtSchema`, `loadConfig`.
- Produces: `runSync(opts: { db: string; adapters: WatchtowerAdapter[] }): Promise<SyncSummary>` where `SyncSummary = { source: string; ingested: number; metricsRejected: number; malformed: number }[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/core-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { runSync } from "@/lib/core/sync";

const ROOT = path.resolve(__dirname, "..");

describe("runSync", () => {
  it("applies the schema, registers the source and fills wt_requests", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const summary = await runSync({ db, adapters: [createClaudeAdapter({ db })] });

    expect(summary.length).toBe(1);
    expect(summary[0].source).toBe("claude");
    expect(summary[0].ingested).toBeGreaterThan(0);
    expect(summary[0].malformed).toBe(0);

    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_requests;")[0].n;
    const out = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n;
    expect(out).toBe(src);
  });

  it("is idempotent: a second run changes no row count", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const count = () => rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n;
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const first = count();
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(count()).toBe(first);
  });

  it("rejects nothing when Claude is the only source", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const s = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    // Every metric Claude emits is one it owns. A rejection here means the
    // authority declaration and the generators disagree.
    expect(s[0].metricsRejected).toBe(0);
  });
});

describe("watchtower sync", () => {
  it("runs end to end against a real database and prints a JSON summary", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const out = execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db },
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    expect(parsed.sources[0].source).toBe("claude");
    expect(parsed.sources[0].ingested).toBeGreaterThan(0);
  });

  it("--quiet prints nothing and still syncs", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const out = execFileSync("node",
      [path.join(ROOT, "bin", "watchtower"), "sync", "--quiet"], {
        env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
      });
    expect(out).toBe("");
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n)
      .toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core-sync.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/sync`.

- [ ] **Step 3: Write `lib/core/sync.ts`**

```ts
import { applyWtSchema } from "./schema.ts";
import { registerSource, type WatchtowerAdapter } from "./adapters.ts";
import { ingestRecords } from "./ingest.ts";
import type { WatchtowerRecord } from "./records.ts";

export interface SourceSummary {
  source: string;
  ingested: number;
  metricsRejected: number;
  malformed: number;
}

/**
 * Project every given adapter into wt_*.
 *
 * This is the one thing all three callers share: the CLI, the dashboard on
 * start, and the dashboard's poll interval. It is incremental, idempotent and
 * safe to run concurrently with anything, because it only ever reads source
 * truth and writes normalized rows -- which is what makes "when it runs" a
 * question of freshness rather than of correctness.
 */
export async function runSync(opts: {
  db: string; adapters: WatchtowerAdapter[];
}): Promise<SourceSummary[]> {
  applyWtSchema(opts.db);
  const out: SourceSummary[] = [];

  for (const adapter of opts.adapters) {
    registerSource(opts.db, adapter);

    // ingestRecords takes a synchronous iterable; the adapter contract is
    // async. Draining first is deliberate and safe at this scale -- the whole
    // archive is ~27k requests. Revisit only if a measurement says to.
    const records: WatchtowerRecord[] = [];
    for await (const r of adapter.ingest()) records.push(r);

    const res = ingestRecords(opts.db, adapter.id, records);
    out.push({
      source: adapter.id,
      ingested: res.ingested,
      metricsRejected: res.metricsRejected,
      malformed: res.malformed,
    });
  }

  return out;
}
```

- [ ] **Step 4: Add the `sync` subcommand to `bin/watchtower`**

Change the usage constant and the command dispatch:

```js
const USAGE = [
  "usage: watchtower ingest --stdin --source <id>",
  "       watchtower sync [--quiet]",
].join("\n");
```

Replace the line `if (cmd !== "ingest") fail(...)` with:

```js
if (cmd === "sync") {
  const { loadConfig } = await import("../lib/config.ts");
  const { runSync } = await import("../lib/core/sync.ts");
  const { createClaudeAdapter } = await import("../lib/adapters/claude/index.ts");

  const cfg = loadConfig();
  const db = cfg.database.path;

  // Only enabled sources are projected. Absent `sources` means Claude only,
  // enabled -- so a config written before Stage 3 keeps working untouched.
  const adapters = [];
  if (cfg.sources.claude?.enabled !== false) adapters.push(createClaudeAdapter({ db }));

  const sources = await runSync({ db, adapters });
  if (flag("quiet") !== true) console.log(JSON.stringify({ db, sources }));
  process.exit(0);
}

if (cmd !== "ingest") fail(`unknown command: ${cmd}\n${USAGE}`);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/core-sync.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/core/sync.ts bin/watchtower tests/core-sync.test.ts
git commit -m "feat(stage-3b): runSync and the watchtower sync command

One command, three callers. The CLI is the first; the dashboard's start and
poll-interval callers land in 3C. Incremental, idempotent, and safe to run
concurrently -- which is what makes trigger timing a question of freshness
rather than correctness."
```

---

## Task 8: The zero-regression gate

**Files:**
- Create: `tests/claude-reconciliation.test.ts`

**Interfaces:**
- Consumes: `runSync`, `createClaudeAdapter`, `buildAndRoll`, `rows`, `SCENARIOS`.
- Produces: nothing — this task is the proof, not a component.

**3B is not done until this passes.** The requirement from spec §3B.5 is that `claude-baseline.json` still matches exactly *and* that a planted perturbation turns exactly one test red.

- [ ] **Step 1: Write the test**

Create `tests/claude-reconciliation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { SCENARIOS } from "./regression/baseline";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { runSync } from "@/lib/core/sync";

describe("Claude projection reconciles with claude_* on every scenario", () => {
  it("projects every request, with the same token totals, on all scenarios", async () => {
    for (const scenario of SCENARIOS) {
      const db = buildAndRoll(scenario);
      await runSync({ db, adapters: [createClaudeAdapter({ db })] });

      // `to` is a SQL keyword -- both halves alias to tokens_out_sum.
      const src = rows<{ n: number; ti: number; tokens_out_sum: number }>(db, `
        SELECT COUNT(*) AS n,
               COALESCE(SUM(tokens_in),0)  AS ti,
               COALESCE(SUM(tokens_out),0) AS tokens_out_sum
          FROM claude_requests WHERE ts IS NOT NULL;`);
      const out = rows<{ n: number; ti: number; tokens_out_sum: number }>(db, `
        SELECT COUNT(*) AS n,
               COALESCE(SUM(tokens_in),0)  AS ti,
               COALESCE(SUM(tokens_out),0) AS tokens_out_sum
          FROM wt_requests WHERE source = 'claude';`);

      expect(`${scenario}: ${JSON.stringify(out[0])}`)
        .toBe(`${scenario}: ${JSON.stringify(src[0])}`);
    }
  }, 300_000);

  it("keeps requests that have no session row — the 22.4% case", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const orphans = rows<{ n: number }>(db, `
      SELECT COUNT(*) AS n FROM wt_requests
       WHERE source = 'claude' AND canonical_id IS NULL;`)[0].n;
    expect(orphans).toBeGreaterThan(0);
  });

  it("leaves the claude_* rollups byte-identical — the projection writes nothing back", async () => {
    const db = buildAndRoll("four-projects");
    const before = rows<unknown>(db, "SELECT * FROM claude_daily_rollups ORDER BY day;");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const after = rows<unknown>(db, "SELECT * FROM claude_daily_rollups ORDER BY day;");
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
```

- [ ] **Step 2: Run the new test and the frozen baseline together**

Run: `npx vitest run tests/claude-reconciliation.test.ts tests/regression.test.ts`
Expected: PASS. The baseline must match **exactly** — if it does not, the projection has written back into `claude_*` and that is a stop-the-line defect, not a baseline to update.

- [ ] **Step 3: Mutation-check the reconciliation**

Temporarily add `JOIN claude_sessions s ON s.session_id = r.session_id` to the query in
`claudeRequestRecords` — an INNER join, which is the actual prohibited pattern.
Run: `npx vitest run tests/claude-reconciliation.test.ts`
Expected: red on both the totals test and the orphan test. Restore.

**Do not use `AND r.session_id IS NOT NULL` for this mutation.** It looks equivalent and is
not: an orphaned request in this repo carries a NON-NULL `session_id` that simply has no
matching `claude_sessions` row (the `orphan-request-tokens` fixture's `r_ghost` points at
`s_gone`), so a NULL check drops nothing and every test stays green. Confusing "has no
session row" with "has a NULL session id" is what makes the prohibited join look harmless.

Then temporarily change one token metric in `claudeRequestRecords` to `row.tokens_in + 1`.
Run: `npx vitest run tests/claude-reconciliation.test.ts`
Expected: exactly one test red — the totals test. Restore.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green, including `tests/regression.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add tests/claude-reconciliation.test.ts
git commit -m "test(stage-3b): prove the projection changed no Claude number

Reconciles wt_requests against claude_requests on all 17 scenarios, pins the
orphan case that an inner join through claude_sessions would silently drop, and
asserts the claude_* rollups are byte-identical after a sync.

The frozen baseline must match exactly. If it ever does not, the projection has
written back into claude_* -- that is a stop-the-line defect, not a baseline to
regenerate."
```

---

## Task 9: Measure steady-state sync latency

**Files:**
- Create: `.superpowers/sdd/2026-09-15-stage-3b-claude-adapter/progress.md` (append if it exists)

**Interfaces:**
- Consumes: the finished `watchtower sync`.
- Produces: a recorded measurement. `2026-09-15-sync-trigger-and-surfaces-design.md` §5 makes this a required output of this stage, and §6 gates the always-on question on it.

- [ ] **Step 1: Take a safe copy of the live database**

**Never test against the live DB**, and `cp` is wrong because it is WAL.

```bash
mkdir -p /tmp/wt-latency && rm -f /tmp/wt-latency/*
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup /tmp/wt-latency/copy.sqlite"
```

The copy gets **its own directory**, because the `.schema-vN` and `.wt-schema-vN` markers live in the database's *directory* and two databases sharing one directory means the second silently gets no schema. That trap has bitten three times.

- [ ] **Step 2: Measure the cold run**

```bash
time WATCHTOWER_DB_PATH=/tmp/wt-latency/copy.sqlite node bin/watchtower sync
```
Record wall-clock and the `ingested` count.

- [ ] **Step 3: Measure the steady-state run — the number that matters**

```bash
time WATCHTOWER_DB_PATH=/tmp/wt-latency/copy.sqlite node bin/watchtower sync
time WATCHTOWER_DB_PATH=/tmp/wt-latency/copy.sqlite node bin/watchtower sync
```
Record both. The second and third runs have a warm cursor and nothing new to project; this is what the dashboard pays on every open.

- [ ] **Step 4: Write the finding**

Record in the progress file: cold seconds, steady-state seconds, request count, and the verdict in one sentence — either *"sync-on-open is invisible; Stage 9 piece 2 is not justified"* or *"steady-state sync costs N seconds, which is visible on every dashboard open; always-on is justified."*

State the verdict as a measurement, not a preference. If the number is bad, say so — the whole point of taking it is that it can come out either way.

- [ ] **Step 5: Commit**

```bash
git add .superpowers/sdd/2026-09-15-stage-3b-claude-adapter/progress.md
git commit -m "docs(stage-3b): measure steady-state sync latency

The design doc makes this a required output of 3B and gates the always-on
question on it. Recorded rather than argued."
```

---

## Self-Review

**Spec coverage.** §3B.1 (projection, capture untouched) → Tasks 3–6 plus the global constraints. §3B.2 mapping table → Tasks 3, 4, 5, with two rows corrected in Task 1. §3B.3 invariants 1–5 → Tasks 3 and 5 carry the tests; invariant 5 (`MIN(gap,`) is already guarded by the existing carriers test, which Task 6's suite run exercises. §3B.4 session completeness → Task 2. §3B.5 regression gate → Task 8. Design doc §3 trigger model → Task 7. Design doc §5 measurement → Task 9.

**Known gap, deliberate.** `wt_metrics` is written by nothing in this stage. It is the HTTP-gauge table and Claude has no gauge; leaving it empty is correct, and Stage 6 is where it earns rows.

**Type consistency.** `CLAUDE_SOURCE` is declared in both `sessions.ts` and `records.ts` — the implementer should import it from `records.ts` into `sessions.ts` rather than redeclare it, or the constant drifts. `createClaudeAdapter({ db })` takes an object everywhere. `runSync` returns `SourceSummary[]`, and the CLI wraps it as `{ db, sources }`.

