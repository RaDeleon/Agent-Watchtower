/**
 * Whether a tool is installed, and whether sync has read it -- the states spec
 * §5 names before any number: not installed (no card), installed but never
 * synced, synced, and synced with the last attempt failed ("data as of").
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { lookedAt } from "../core/discovery.ts";
import { querySql, sqlStr } from "../core/sql.ts";
import { hasTable } from "./level.ts";

export type ToolStatus =
  | { state: "not-installed"; lookedAt: string }
  | { state: "not-synced"; lookedAt: string }
  | { state: "failed"; lookedAt: string; lastError: string | null }
  | { state: "synced"; lookedAt: string; lastOkAt: number; degraded: boolean; lastError: string | null };

/**
 * Synced history wins over the filesystem: a tool uninstalled after a sync
 * keeps its page, because its wt_* rows are durable (spec §5, last row).
 */
export function toolStatus(db: string, source: "codex" | "hermes", home: string = os.homedir()): ToolStatus {
  const where = lookedAt(source, home);
  const r = hasTable(db, "wt_ingest_state")
    ? querySql<{ ok: number | null; run: number | null; health: string; err: string | null }>(db,
        `SELECT last_ok_at AS ok, last_run_at AS run, health, last_error AS err FROM wt_ingest_state WHERE source = ${sqlStr(source)};`,
        { readonly: true })[0]
    : undefined;
  if (r !== undefined && r.ok !== null) {
    return { state: "synced", lookedAt: where, lastOkAt: r.ok, degraded: r.health === "degraded", lastError: r.err };
  }
  // A first sync that threw: tried, never succeeded. Not "not synced": the user
  // already ran it, and the error is what they need.
  if (r !== undefined && r.run !== null) return { state: "failed", lookedAt: where, lastError: r.err };
  return existsSync(where) ? { state: "not-synced", lookedAt: where } : { state: "not-installed", lookedAt: where };
}
