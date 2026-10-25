import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { fileCursorSql, readFileCursor, stampOf, unchanged, type FileStamp } from "../../core/cursor.ts";
import { detectSource } from "../../core/discovery.ts";
import {
  agentSessionSql, linkExactSql, mintCanonicalId, resolveCanonicalIds, setSessionStateSql,
} from "../../core/identity.ts";
import type { WatchtowerRecord } from "../../core/records.ts";
import { execSql, execSqlBatch, querySql, sqlStr } from "../../core/sql.ts";
import { classifyEntry, reclassifySql, type EntryLists } from "../entry.ts";
import { CODEX_SOURCE, parseRollout, type RolloutSession } from "./parse.ts";

export const CODEX_ADAPTER_VERSION = 1;

const byName = (a: string, b: string): number => {
  const ka = path.basename(a), kb = path.basename(b);
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Every rollout under sessions/ and archived_sessions/, sorted by basename then path (R19). */
export function listRollouts(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(path.join(home, ".codex", "sessions"));
  walk(path.join(home, ".codex", "archived_sessions"));
  return out.sort(byName);
}

/** Resolve or mint the session's canonical id and write it, BEFORE any of its records. */
function ensureSession(db: string, s: RolloutSession, lists: EntryLists, pending: boolean): string {
  const canonical = resolveCanonicalIds(db, CODEX_SOURCE, [s.id], "same_session").get(s.id)
    ?? mintCanonicalId();
  execSqlBatch(db, [
    agentSessionSql({
      canonicalId: canonical, source: CODEX_SOURCE, startedAt: s.startedAt, endedAt: s.endedAt,
      cwd: s.cwd, entry: s.entry, driven: classifyEntry(s.entry, lists),
      repo: s.repo, branch: s.branch, model: s.model,
    }),
    linkExactSql({
      source: CODEX_SOURCE, sourceLocalId: s.id, linkKind: "same_session",
      canonicalId: canonical, evidence: `session_meta.id=${s.id}`,
    }),
    setSessionStateSql(canonical, CODEX_SOURCE, pending ? "pending" : "complete"),
  ]);
  return canonical;
}

/**
 * This file's response ids already held by ANOTHER session (R19): first arrival
 * wins, as claude_requests.session_id does. A forked or copied rollout repeats
 * ids, and re-owning them would move tokens between sessions on every sync.
 */
function takenElsewhere(db: string, canonical: string, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = querySql<{ id: string }>(db, `SELECT source_record_id AS id FROM wt_requests
      WHERE source = ${sqlStr(CODEX_SOURCE)} AND canonical_id <> ${sqlStr(canonical)}
        AND source_record_id IN (${chunk.map(sqlStr).join(", ")});`);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/**
 * Codex, from its rollout logs. Read-only: files are read whole with
 * readFileSync, never opened for writing. A file whose size and mtime match
 * wt_file_cursor is skipped (R17); the cursor is committed in finish(), and
 * only after a clean run.
 */
export function createCodexAdapter(opts: { db: string; home?: string; lists: EntryLists }): WatchtowerAdapter {
  const { db, lists } = opts;
  const home = opts.home ?? os.homedir();
  let done: { path: string; stamp: FileStamp }[] = [];
  let malformed = 0;

  return {
    id: CODEX_SOURCE,
    type: "agent",
    label: "Codex",
    version: CODEX_ADAPTER_VERSION,
    capabilities: ["sessions", "requests", "usage"],
    authority: [{
      kind: "request", scope: "own",
      metrics: ["tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation", "reasoning_tokens"],
    }],

    async detect(): Promise<DetectionResult> {
      return detectSource("codex", { home });
    },

    async health(): Promise<AdapterHealth> {
      const d = await this.detect();
      if (!d.detected) return { state: "unavailable", detail: d.detail };
      return { state: "ok", detail: `${listRollouts(home).length} rollout files` };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      done = [];
      malformed = 0;
      const cursor = readFileCursor(db, CODEX_SOURCE);
      const seen = new Set<string>();
      for (const file of listRollouts(home)) {
        const stamp = stampOf(file);
        if (unchanged(cursor.get(file), stamp)) continue;
        const parsed = parseRollout(readFileSync(file, "utf8"), path.basename(file, ".jsonl"));
        malformed += parsed.malformed;
        if (parsed.session !== null) {
          const canonical = ensureSession(db, parsed.session, lists, parsed.partialTail);
          const ids = parsed.records.filter((r) => r.kind === "request").map((r) => r.sourceRecordId);
          const taken = takenElsewhere(db, canonical, ids);
          for (const r of parsed.records) {
            if (r.kind === "request") {
              if (seen.has(r.sourceRecordId) || taken.has(r.sourceRecordId)) continue;
              seen.add(r.sourceRecordId);
            }
            yield r;
          }
        }
        // A file still being written is read again next sync, whole (R17).
        if (!parsed.partialTail) done.push({ path: file, stamp });
      }
    },

    finish({ clean }) {
      // Never prunes: a deleted or archived log keeps its rows (spec §5, guard 9).
      if (clean && done.length > 0) {
        execSqlBatch(db, done.map((d) => fileCursorSql(CODEX_SOURCE, d.path, d.stamp)));
      }
      execSql(db, reclassifySql(CODEX_SOURCE, lists));
      return { malformed, detail: malformed > 0 ? `${malformed} malformed lines in Codex logs` : undefined };
    },
  };
}
