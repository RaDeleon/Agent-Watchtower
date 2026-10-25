import { randomUUID } from "node:crypto";
import { execSql, querySql, sqlStr, sqlNum } from "./sql.ts";

export type LinkKind = "same_session" | "produced_commit" | "touched_file";
export type SessionState = "pending" | "complete";

/**
 * A canonical id is minted here and nowhere else, and is deliberately
 * prefixed: a value that leaks into a source-local id column is then obvious
 * on sight rather than being just another opaque uuid.
 */
export function mintCanonicalId(): string {
  return `wt_${randomUUID()}`;
}

/**
 * Create or extend a canonical session.
 *
 * Two different update rules, on purpose:
 *
 *  - `ended_at`, `project`, `repo`, `branch` take the newest value that is
 *    present. These are facts that are genuinely discovered or corrected as a
 *    session proceeds.
 *  - `started_at`, `agent`, `model` are FILL-IF-MISSING. A start time that is
 *    already known must not be rewritten by a later observer, but a NULL must
 *    still be fillable -- a record that arrives before the one carrying the
 *    start time would otherwise leave the session permanently without one.
 *
 * In every case an absent field is NULL in `excluded`, and COALESCE keeps what
 * is already stored. A later record that simply does not carry a field is not
 * a statement that the field became absent.
 */
export interface SessionUpsert {
  canonicalId: string; firstSource: string;
  startedAt?: number; endedAt?: number;
  project?: string; repo?: string; branch?: string; agent?: string; model?: string;
}

export function upsertSession(db: string, a: SessionUpsert): void {
  execSql(db, upsertSessionSql(a));
}

/** upsertSession's statement, for callers that batch it. */
export function upsertSessionSql(a: SessionUpsert): string {
  const now = Math.floor(Date.now() / 1000);
  return `INSERT INTO wt_sessions
      (canonical_id, first_source, started_at, ended_at, project, repo, branch,
       agent, model, updated_at)
    VALUES (${sqlStr(a.canonicalId)}, ${sqlStr(a.firstSource)},
            ${sqlNum(a.startedAt)}, ${sqlNum(a.endedAt)}, ${sqlStr(a.project)},
            ${sqlStr(a.repo)}, ${sqlStr(a.branch)}, ${sqlStr(a.agent)},
            ${sqlStr(a.model)}, ${sqlNum(now)})
    ON CONFLICT(canonical_id) DO UPDATE SET
      started_at = COALESCE(wt_sessions.started_at, excluded.started_at),
      ended_at   = COALESCE(excluded.ended_at, wt_sessions.ended_at),
      project    = COALESCE(excluded.project, wt_sessions.project),
      repo       = COALESCE(excluded.repo, wt_sessions.repo),
      branch     = COALESCE(excluded.branch, wt_sessions.branch),
      agent      = COALESCE(wt_sessions.agent, excluded.agent),
      model      = COALESCE(wt_sessions.model, excluded.model),
      updated_at = excluded.updated_at;`;
}

/**
 * Create an EXACT identity link.
 *
 * Exact means both sources obtained the identifier from the same upstream
 * system -- proven for Atlas, whose agent_session.native_session_id matched
 * claude_sessions.session_id on 5 of 5 sessions.
 *
 * There is deliberately no linkInferred(). The confidence column exists so the
 * schema need not change later, but nothing in Stage 3 writes anything but
 * 'exact': a wrong link merges two real sessions and the error is nearly
 * invisible once rolled up.
 */
export interface ExactLink {
  source: string; sourceLocalId: string; linkKind: LinkKind;
  canonicalId: string; evidence: string;
}

export function linkExact(db: string, a: ExactLink): void {
  execSql(db, linkExactSql(a));
}

/** linkExact's statement, for callers that batch it. Validates the same way. */
export function linkExactSql(a: ExactLink): string {
  // Blank is checked after trimming: whitespace is not an audit trail.
  if (!a.evidence || a.evidence.trim() === "") {
    throw new Error("linkExact requires evidence -- a link must be auditable");
  }
  return `INSERT INTO wt_links
      (source, source_local_id, link_kind, canonical_id, confidence, evidence, created_at)
    VALUES (${sqlStr(a.source)}, ${sqlStr(a.sourceLocalId)}, ${sqlStr(a.linkKind)},
            ${sqlStr(a.canonicalId)}, 'exact', ${sqlStr(a.evidence)},
            ${sqlNum(Math.floor(Date.now() / 1000))})
    ON CONFLICT(source, source_local_id, link_kind) DO UPDATE SET
      canonical_id = excluded.canonical_id, evidence = excluded.evidence;`;
}

/**
 * Resolve a source-local id to its canonical id, scoped by source AND link
 * kind -- the full primary key. Dropping either leg would hand back another
 * source's session, or another kind's subject, under the same local id.
 */
export function resolveCanonicalId(
  db: string, source: string, sourceLocalId: string, linkKind: LinkKind,
): string | null {
  const r = querySql<{ canonical_id: string }>(db,
    `SELECT canonical_id FROM wt_links
      WHERE source = ${sqlStr(source)}
        AND source_local_id = ${sqlStr(sourceLocalId)}
        AND link_kind = ${sqlStr(linkKind)};`);
  return r.length ? r[0].canonical_id : null;
}

/**
 * resolveCanonicalId for many ids in ONE query: a Map of the ids that resolve.
 * An id with no link is simply absent from the Map.
 *
 * Callers pass ids in bounded chunks. The IN list rides in argv, so an
 * unbounded list would meet ARG_MAX (see execSql).
 */
export function resolveCanonicalIds(
  db: string, source: string, sourceLocalIds: Iterable<string>, linkKind: LinkKind,
): Map<string, string> {
  const ids = [...new Set(sourceLocalIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = querySql<{ source_local_id: string; canonical_id: string }>(db,
    `SELECT source_local_id, canonical_id FROM wt_links
      WHERE source = ${sqlStr(source)}
        AND link_kind = ${sqlStr(linkKind)}
        AND source_local_id IN (${ids.map(sqlStr).join(", ")});`);
  for (const r of rows) out.set(r.source_local_id, r.canonical_id);
  return out;
}

/**
 * Record how complete a session is FOR ONE SOURCE (decision 5).
 *
 * A live session has provenance from one source and no usage yet from
 * another; that is not the same fact as zero usage, so the state is keyed per
 * source and one source going complete never speaks for another.
 *
 * The state is validated here rather than by a CHECK constraint so the caller
 * gets a loud error, not a swallowed sqlite failure.
 */
export function setSessionState(
  db: string, canonicalId: string, source: string, state: SessionState,
): void {
  execSql(db, setSessionStateSql(canonicalId, source, state));
}

/** setSessionState's statement, for callers that batch it. Validates the same way. */
export function setSessionStateSql(
  canonicalId: string, source: string, state: SessionState,
): string {
  if (state !== "pending" && state !== "complete") {
    throw new Error(`invalid session state: ${state}`);
  }
  return `INSERT INTO wt_session_state (canonical_id, source, state, updated_at)
    VALUES (${sqlStr(canonicalId)}, ${sqlStr(source)}, ${sqlStr(state)},
            ${sqlNum(Math.floor(Date.now() / 1000))})
    ON CONFLICT(canonical_id, source) DO UPDATE SET
      state = excluded.state, updated_at = excluded.updated_at;`;
}

/**
 * An AGENT source's session (Codex, Hermes). Unlike upsertSessionSql:
 *
 *  - started_at is the MIN and ended_at the MAX of every observation, because a
 *    resumed Codex session arrives as a second file that may be read first;
 *  - cwd and entry take the newest value present;
 *  - driven is written as given, NULL included: it is a classification from
 *    config, and finish() re-derives it from entry for every session (R18);
 *  - model is fill-if-missing, like upsertSessionSql.
 */
export interface AgentSessionUpsert {
  canonicalId: string;
  source: string;
  startedAt?: number;
  endedAt?: number;
  cwd?: string;
  entry?: string;
  driven: 0 | 1 | null;
  repo?: string;
  branch?: string;
  model?: string;
}

export function agentSessionSql(a: AgentSessionUpsert): string {
  return `INSERT INTO wt_sessions
      (canonical_id, first_source, started_at, ended_at, repo, branch, model,
       cwd, entry, driven, updated_at)
    VALUES (${sqlStr(a.canonicalId)}, ${sqlStr(a.source)}, ${sqlNum(a.startedAt)},
            ${sqlNum(a.endedAt)}, ${sqlStr(a.repo)}, ${sqlStr(a.branch)},
            ${sqlStr(a.model)}, ${sqlStr(a.cwd)}, ${sqlStr(a.entry)},
            ${a.driven === null ? "NULL" : sqlNum(a.driven)},
            ${sqlNum(Math.floor(Date.now() / 1000))})
    ON CONFLICT(canonical_id) DO UPDATE SET
      started_at = MIN(COALESCE(wt_sessions.started_at, excluded.started_at),
                       COALESCE(excluded.started_at, wt_sessions.started_at)),
      ended_at   = MAX(COALESCE(wt_sessions.ended_at, excluded.ended_at),
                       COALESCE(excluded.ended_at, wt_sessions.ended_at)),
      repo       = COALESCE(excluded.repo, wt_sessions.repo),
      branch     = COALESCE(excluded.branch, wt_sessions.branch),
      model      = COALESCE(wt_sessions.model, excluded.model),
      cwd        = COALESCE(excluded.cwd, wt_sessions.cwd),
      entry      = COALESCE(excluded.entry, wt_sessions.entry),
      driven     = excluded.driven,
      updated_at = excluded.updated_at;`;
}
