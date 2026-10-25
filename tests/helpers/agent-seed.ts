import { execFileSync } from "node:child_process";
import { applyWtSchema } from "@/lib/core/schema";
import { sqlNum, sqlStr } from "@/lib/core/sql";
import { rerollup } from "./fixture-db";

export type AgentEvent = "session_start" | "session_end" | "prompt" | "stop" | "activity";
export interface SeedRequest {
  id: string; ts: number; model?: string | null;
  tin?: number; tout?: number; tcr?: number; tcw?: number; cost?: number | null;
}
export interface SeedSession {
  source: "codex" | "hermes"; id: string; entry: string; driven: 0 | 1 | null;
  startedAt: number; cwd?: string;
  /** [epoch seconds, event]; seq is the array index, so ties keep this order. */
  events?: Array<[number, AgentEvent]>;
  requests?: SeedRequest[];
}

/**
 * Write Codex/Hermes sessions, events and requests straight into wt_*, the way
 * the adapters would, so a rollup test's numbers depend on rollup.sh alone.
 * canonical_id is "<source>:<id>". Registers each source in wt_sources.
 */
export function seedAgents(db: string, sessions: SeedSession[]): void {
  applyWtSchema(db);
  const now = 1790000000;
  const sql: string[] = [".bail on", "BEGIN;"];
  for (const src of new Set(sessions.map((s) => s.source))) {
    sql.push(`INSERT OR IGNORE INTO wt_sources (source, source_type, label, adapter_version, updated_at)
              VALUES (${sqlStr(src)}, 'agent', ${sqlStr(src)}, 1, ${now});`);
  }
  for (const s of sessions) {
    const cid = `${s.source}:${s.id}`;
    sql.push(`INSERT INTO wt_sessions (canonical_id, first_source, started_at, cwd, entry, driven, updated_at)
              VALUES (${sqlStr(cid)}, ${sqlStr(s.source)}, ${sqlNum(s.startedAt)}, ${sqlStr(s.cwd)},
                      ${sqlStr(s.entry)}, ${s.driven === null ? "NULL" : s.driven}, ${now});`);
    (s.events ?? []).forEach(([ts, event], seq) => {
      sql.push(`INSERT INTO wt_events (source, source_record_id, canonical_id, ts, kind, dimensions)
                VALUES (${sqlStr(s.source)}, ${sqlStr(`${s.id}:${seq}`)}, ${sqlStr(cid)}, ${ts}, 'event',
                        ${sqlStr(JSON.stringify({ event, seq }))});`);
    });
    for (const r of s.requests ?? []) {
      sql.push(`INSERT INTO wt_requests (source, source_record_id, canonical_id, ts, model,
                  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cost_usd)
                VALUES (${sqlStr(s.source)}, ${sqlStr(r.id)}, ${sqlStr(cid)}, ${r.ts}, ${sqlStr(r.model ?? null)},
                        ${r.tin ?? 0}, ${r.tout ?? 0}, ${r.tcr ?? 0}, ${r.tcw ?? 0}, ${sqlNum(r.cost ?? null)});`);
    }
  }
  sql.push("COMMIT;");
  execFileSync("sqlite3", [db], { input: sql.join("\n"), encoding: "utf8" });
}

/** Re-run rollup.sh (TZ=UTC) and fail loudly, with its stderr, on a non-zero exit. */
export function roll(db: string, env: Record<string, string> = {}): void {
  const r = rerollup(db, ["--quiet"], env);
  if (r.status !== 0) throw new Error(`rollup.sh exited ${r.status}: ${r.stderr}`);
}
