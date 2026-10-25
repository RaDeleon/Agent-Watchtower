import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execSql, querySql } from "./sql.ts";

/**
 * The wt_* namespace's OWN version, separate from CC_SCHEMA_VERSION.
 *
 * capture/lib.sh installs as ~/.claude/cc-track-lib.sh, so bumping
 * CC_SCHEMA_VERSION would mean editing an installed file and requiring a
 * reinstall -- and Stage 3 touches nothing under ~/.claude. Splitting the
 * namespaces lets the capture layer stay at 4, untouched.
 *
 * Declared twice, here and in the marker name, for the same reason
 * CC_SCHEMA_VERSION is. A test pins them together.
 *
 * v3 adds wt_sessions.cwd, entry and driven, plus wt_file_cursor.
 */
export const WT_SCHEMA_VERSION = 3;

/**
 * The marker file that gates the fast path, written in the DATABASE'S
 * DIRECTORY -- exactly like capture/lib.sh's `.schema-vN`.
 *
 * Two markers can share one directory only because the names differ:
 * `.wt-schema-vN` can never equal `.schema-vN` for any N. A test asserts it.
 */
export function wtMarkerName(): string {
  return `.wt-schema-v${WT_SCHEMA_VERSION}`;
}

/** The wt_* DDL, verbatim from spec §3A.3. Column order is load-bearing. */
export function wtSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS wt_sources (
  source          TEXT PRIMARY KEY,
  -- What KIND of thing this source is, which decides what it may contribute to
  -- cross-tool totals. Only 'agent' sources are coding agents whose activity and
  -- spend belong in the Overview: summing OpenViking's embedding tokens into
  -- "coding agent spend" would be a category error, and Atlas is provenance, not
  -- a second observer of usage.
  source_type     TEXT NOT NULL DEFAULT 'agent',  -- agent|provenance|memory|health
  label           TEXT,                            -- display name, e.g. "Claude Code"
  adapter_version INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  capabilities    TEXT NOT NULL DEFAULT '[]',   -- JSON
  authority       TEXT NOT NULL DEFAULT '[]',   -- JSON: [{kind,metrics[]}]
  first_seen      INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wt_ingest_state (
  source            TEXT PRIMARY KEY,
  cursor            TEXT,
  last_run_at       INTEGER,
  last_ok_at        INTEGER,
  -- LIFETIME RECORDS WRITTEN, not records held. It accumulates with += on every
  -- run, but a record whose fingerprint is unchanged is skipped and not counted
  -- (see wt_record_fingerprints), so it counts new and changed records. A record
  -- that changes three times counts three times: render it as work done, never
  -- as an inventory.
  records_ingested  INTEGER NOT NULL DEFAULT 0,
  metrics_rejected  INTEGER NOT NULL DEFAULT 0,   -- authority violations
  records_malformed INTEGER NOT NULL DEFAULT 0,
  health            TEXT NOT NULL DEFAULT 'unknown',
  last_error        TEXT
);

CREATE TABLE IF NOT EXISTS wt_sessions (
  canonical_id  TEXT PRIMARY KEY,
  first_source  TEXT NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  project       TEXT, repo TEXT, branch TEXT,
  agent         TEXT, model TEXT,
  cwd TEXT, entry TEXT, driven INTEGER,   -- Stage 5: raw cwd, entry point, 1|0|NULL (unclassified)
  updated_at    INTEGER NOT NULL
);

-- Per-source completeness. Required by §14 decision 5: a live session has
-- provenance from one source and no usage yet from another, and that is NOT
-- the same fact as "zero usage".
CREATE TABLE IF NOT EXISTS wt_session_state (
  canonical_id TEXT NOT NULL,
  source       TEXT NOT NULL,
  state        TEXT NOT NULL,   -- 'pending' | 'complete'
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (canonical_id, source)
);

CREATE TABLE IF NOT EXISTS wt_links (
  source          TEXT NOT NULL,
  source_local_id TEXT NOT NULL,
  link_kind       TEXT NOT NULL,   -- 'same_session'|'produced_commit'|'touched_file'
  canonical_id    TEXT NOT NULL,
  confidence      TEXT NOT NULL,   -- 'exact' | 'inferred'  (only 'exact' written)
  evidence        TEXT,            -- the join key actually used, for audit
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (source, source_local_id, link_kind)
);

-- Typed common path (decision 1: hybrid, biased typed)
CREATE TABLE IF NOT EXISTS wt_requests (
  source          TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  canonical_id    TEXT,
  ts              INTEGER NOT NULL,
  observed_at     INTEGER,
  model           TEXT, agent TEXT,
  project         TEXT, repo TEXT, branch TEXT,
  is_subagent     INTEGER,
  tokens_in       INTEGER, tokens_out INTEGER,
  tokens_cache_read INTEGER, tokens_cache_creation INTEGER,
  cost_usd        REAL,
  error_status    TEXT,
  PRIMARY KEY (source, source_record_id)
);

-- Tall overflow for adapter-specific metrics (decision 1)
CREATE TABLE IF NOT EXISTS wt_usage (
  source          TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  canonical_id    TEXT,
  ts              INTEGER NOT NULL,
  metric          TEXT NOT NULL,
  value           REAL NOT NULL,
  PRIMARY KEY (source, source_record_id, metric)
);

CREATE TABLE IF NOT EXISTS wt_events (
  source TEXT NOT NULL, source_record_id TEXT NOT NULL,
  canonical_id TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  project TEXT, repo TEXT, branch TEXT,
  dimensions TEXT, metadata TEXT,
  PRIMARY KEY (source, source_record_id)
);

CREATE TABLE IF NOT EXISTS wt_tools (
  source TEXT NOT NULL, source_record_id TEXT NOT NULL,
  canonical_id TEXT, ts INTEGER NOT NULL,
  tool_name TEXT NOT NULL, tool_kind TEXT,   -- 'mcp'|'skill'|'plugin'|'builtin'
  server TEXT, status TEXT,
  PRIMARY KEY (source, source_record_id)
);

-- What each record looked like when it was last written, so an unchanged
-- record is skipped instead of rewritten. This is what makes a steady-state sync
-- cheap. ADVISORY, like claude_ingest_cursor: deleting rows here costs one full
-- rewrite and nothing else. The reverse is NOT safe -- deleting wt_* rows while
-- keeping their fingerprints leaves them missing until the source changes.
-- Keyed id-first so a chunk's IN (...) lookup uses the primary key.
CREATE TABLE IF NOT EXISTS wt_record_fingerprints (
  source           TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  kind             TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  PRIMARY KEY (source, source_record_id, kind)
);

CREATE TABLE IF NOT EXISTS wt_metrics (
  source TEXT NOT NULL, ts INTEGER NOT NULL,
  metric TEXT NOT NULL, value REAL NOT NULL,
  dimensions TEXT,
  PRIMARY KEY (source, ts, metric)
);

-- ADVISORY, like claude_ingest_cursor: a file whose size and mtime are unchanged
-- is skipped. Correctness comes from the primary keys; deleting these rows costs
-- one slow sync and nothing else. mtime_ns is TEXT: nanoseconds overflow a double.
CREATE TABLE IF NOT EXISTS wt_file_cursor (
  source   TEXT NOT NULL,
  path     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  mtime_ns TEXT NOT NULL,
  PRIMARY KEY (source, path)
);

-- The rollup's agent section walks events and requests per canonical session.
CREATE INDEX IF NOT EXISTS idx_wt_events_canonical ON wt_events(canonical_id, ts);
CREATE INDEX IF NOT EXISTS idx_wt_requests_canonical ON wt_requests(canonical_id);
`;
}

/**
 * Columns added to an EXISTING wt_* table after it first shipped. CREATE TABLE
 * IF NOT EXISTS never alters a table, so a v2 database needs these ALTERed in;
 * each is guarded by pragma_table_info, so a fresh v3 database skips them all.
 */
export const WT_ADDED_COLUMNS: readonly (readonly [table: string, column: string, type: string])[] = [
  ["wt_sessions", "cwd", "TEXT"],
  ["wt_sessions", "entry", "TEXT"],
  ["wt_sessions", "driven", "INTEGER"],
];

/**
 * Apply the wt_* schema. Idempotent via CREATE TABLE IF NOT EXISTS.
 *
 * Unlike cc_init_db this is NOT on the hook path, so it fails loudly.
 */
export function applyWtSchema(dbPath: string): void {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, wtMarkerName());
  if (existsSync(marker) && existsSync(dbPath)) return;
  execSql(dbPath, wtSchemaSql());
  for (const [table, column, type] of WT_ADDED_COLUMNS) {
    const has = querySql<{ n: number }>(dbPath,
      `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = '${column}';`)[0].n;
    if (has === 0) execSql(dbPath, `ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
  writeFileSync(marker, "");
}
