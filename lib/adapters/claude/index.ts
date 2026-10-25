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
 * A ONE-LINE reason from a failed sqlite3 call.
 *
 * execFileSync's own message is the whole command plus the child's stderr, so
 * it is several lines long and repeats the SQL; the useful part is sqlite3's
 * own complaint ("file is not a database (26)"), which is the child's stderr
 * where there is one and the last line of the message otherwise. This detail
 * is rendered in the Sources view next to a source name, so it has to fit on
 * a line.
 */
function reason(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null;
  const text = String(err?.stderr ?? "").trim() || String(err?.message ?? e).trim();
  return text.split("\n").filter((l) => l.trim() !== "").pop() ?? String(e);
}

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
    // Own-scope (Stage 5 R1): Claude owns these metrics on its own rows, so
    // Codex and Hermes may own theirs.
    authority: [
      { kind: "request", scope: "own", metrics: [
        "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation"] },
      { kind: "session", scope: "own", metrics: ["cost_usd", "lines_added", "lines_removed"] },
    ],

    /**
     * A PROBE: absence is a state, and so is unreadability.
     *
     * existsSync alone is not enough. A path can exist and still not be a
     * SQLite database -- a truncated file, a text file, a directory -- and
     * querySql's execFileSync throws STRAIGHT THROUGH the existsSync guard
     * when that happens, which is the contract this method declares it keeps.
     * safeDetect would catch it, but only callers that remember to use
     * safeDetect; the guarantee belongs here.
     */
    async detect(): Promise<DetectionResult> {
      if (!existsSync(db)) return { detected: false, detail: `no database at ${db}` };
      try {
        const t = querySql<{ name: string }>(db,
          `SELECT name FROM sqlite_master WHERE type='table' AND name='claude_requests';`);
        return t.length > 0
          ? { detected: true, detail: db }
          : { detected: false, detail: "no claude_* tables" };
      } catch (e) {
        return { detected: false, detail: `cannot read ${db}: ${reason(e)}` };
      }
    },

    /** A PROBE, same guarantee: brokenness is reported, never thrown. */
    async health(): Promise<AdapterHealth> {
      const d = await this.detect();
      if (!d.detected) return { state: "unavailable", detail: d.detail };
      try {
        const n = querySql<{ n: number }>(db,
          `SELECT COUNT(*) AS n FROM claude_requests;`)[0].n;
        // Zero requests is not brokenness: a fresh install has captured nothing
        // yet. It is reported as degraded so the Sources view can say so.
        return n > 0 ? { state: "ok", detail: `${n} requests` }
                     : { state: "degraded", detail: "no requests captured yet" };
      } catch (e) {
        // Readable enough for detect() and not for a count means the database
        // turned unreadable between the two -- a state, not an exception.
        return { state: "unavailable", detail: reason(e) };
      }
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
