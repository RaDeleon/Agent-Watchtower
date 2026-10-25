import { execSqlBatch, pagedRows } from "../../core/sql.ts";
import {
  mintCanonicalId, upsertSessionSql, linkExactSql, resolveCanonicalIds, setSessionStateSql,
} from "../../core/identity.ts";

/** Sessions written per sqlite3 call. Bounds the IN list and the lock hold. */
export const SESSION_CHUNK_SIZE = 500;

export const CLAUDE_SOURCE = "claude";

interface SessionRow {
  session_id: string;
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
 * The raw wall-clock duration column on claude_sessions is deliberately
 * absent from the projection AND from this query. A session_id survives
 * --resume, so ended_at - started_at spans every dormant calendar gap; the
 * only valid duration is window_s, summed per gap by rollup.sh, and it stays
 * in claude_*.
 *
 * Read in pages, like the record generators. This query was not the one that
 * broke sync, but at 632,230 bytes on the live archive it was the CLOSEST of
 * the survivors -- 62% of the 1 MiB default that claudeRequestRecords had
 * already blown through, and growing with every session. Raising the ceiling
 * and leaving this one whole would have relocated the same cliff to a number
 * nobody was watching. session_id is a PRIMARY KEY, so the ordering is total.
 */
export function projectClaudeSessions(db: string): number {
  const sessions = pagedRows<SessionRow>(db, `
    SELECT s.session_id, s.repo, s.project_path, s.model,
           s.started_at, s.ended_at,
           (SELECT COUNT(*) FROM claude_requests r
             WHERE r.session_id = s.session_id) AS request_count
      FROM claude_sessions s
     WHERE s.session_id IS NOT NULL AND s.session_id != ''
     ORDER BY s.session_id`);

  let projected = 0;
  let chunk: SessionRow[] = [];
  for (const s of sessions) {
    chunk.push(s);
    if (chunk.length === SESSION_CHUNK_SIZE) {
      projectChunk(db, chunk);
      projected += chunk.length;
      chunk = [];
    }
  }
  projectChunk(db, chunk);
  projected += chunk.length;

  return projected;
}

/**
 * One chunk of sessions: one query for the links they already have, one batch
 * for every write. session_id is a PRIMARY KEY, so no session appears twice
 * and no write in the batch depends on another.
 */
function projectChunk(db: string, chunk: SessionRow[]): void {
  if (chunk.length === 0) return;
  const known = resolveCanonicalIds(
    db, CLAUDE_SOURCE, chunk.map((s) => s.session_id), "same_session");
  const statements: string[] = [];

  for (const s of chunk) {
    // Re-use the canonical id this session already has. Minting a fresh one on
    // every run would orphan every record written under the previous id.
    const canonicalId = known.get(s.session_id) ?? mintCanonicalId();

    statements.push(upsertSessionSql({
      canonicalId,
      firstSource: CLAUDE_SOURCE,
      startedAt: s.started_at ?? undefined,
      endedAt: s.ended_at ?? undefined,
      project: s.project_path ?? undefined,
      repo: s.repo ?? undefined,
      agent: CLAUDE_SOURCE,
      model: s.model ?? undefined,
    }));

    statements.push(linkExactSql({
      source: CLAUDE_SOURCE,
      sourceLocalId: s.session_id,
      linkKind: "same_session",
      canonicalId,
      evidence: `claude_sessions.session_id=${s.session_id}`,
    }));

    // "Has a transcript but no ingested requests" is pending, NOT zero usage.
    // Measured 2026-09-14: 100 live sessions have exactly this shape.
    statements.push(setSessionStateSql(canonicalId, CLAUDE_SOURCE,
      s.request_count > 0 ? "complete" : "pending"));
  }

  execSqlBatch(db, statements);
}
