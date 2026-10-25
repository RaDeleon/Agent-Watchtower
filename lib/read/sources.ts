/**
 * The Sources view's reads: what each telemetry source is, and what the last
 * `watchtower sync` recorded about it. Source-neutral: every figure comes from
 * the `wt_*` namespace, never from `claude_*`.
 *
 * This is where §3A.4's refusals become visible. A metric a source sent for a
 * (kind, metric) another source owns is counted in `wt_ingest_state.
 * metrics_rejected` and never written -- so this page is the only place it
 * shows up at all.
 *
 * Read-only, like every reader: nothing here runs an adapter or a probe.
 * `detect()` is a live probe that opens the source without `-readonly`, and the
 * dashboard does not write. "Detected" therefore means what sync recorded: a
 * sync registers a source in `wt_sources` only on a run that detected it.
 *
 * NULL is not zero anywhere below. A source that has never run has no
 * `wt_ingest_state` row, and that is a different fact from one that ran and
 * wrote nothing, so the state fields are null rather than defaulted.
 */
import { contributesToActivityTotals, type MetricAuthority, type SourceType } from "../core/adapters.ts";
import { querySql } from "../core/sql.ts";

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/** What config says about a source. Only `enabled` matters here. */
export interface ConfiguredSource {
  enabled: boolean;
}

export interface SourceIngest {
  /** NULL for every current adapter: sync compares fingerprints instead of keeping a cursor. */
  cursor: string | null;
  lastRunAt: number | null;
  lastOkAt: number | null;
  /** LIFETIME records written (new or changed), not records held. */
  recordsWritten: number;
  metricsRejected: number;
  malformed: number;
  /** As stored: 'ok' | 'degraded' | 'unknown'. */
  health: string;
  lastError: string | null;
}

/** Rows currently held in wt_* for this source: an inventory, unlike `recordsWritten`. */
export interface SourceHeld {
  requests: number;
  events: number;
  tools: number;
  usage: number;
  sessions: number;
  fingerprints: number;
}

export interface SourceRow {
  source: string;
  /** In config. Null when config does not name the source at all. */
  enabled: boolean | null;
  /** A sync has registered it, which happens only on a run that detected it. */
  registered: boolean;
  type: SourceType | null;
  label: string | null;
  adapterVersion: number | null;
  /** Whether its activity may enter cross-tool totals. Null when unregistered. */
  inActivityTotals: boolean | null;
  capabilities: string[];
  /** Null when the stored JSON does not parse -- shown as such, not as "owns nothing". */
  authority: MetricAuthority[] | null;
  firstSeen: number | null;
  /** Null: no sync has ever run for this source. */
  ingest: SourceIngest | null;
  held: SourceHeld;
}

export interface SourcesData {
  generatedAt: number;
  /** False when the database has no wt_* tables: `watchtower sync` has never run against it. */
  synced: boolean;
  sources: SourceRow[];
}

interface RegRow {
  source: string; source_type: string; label: string | null; adapter_version: number;
  capabilities: string; authority: string; first_seen: number | null;
}
interface StateRow {
  source: string; cursor: string | null; last_run_at: number | null; last_ok_at: number | null;
  records_ingested: number; metrics_rejected: number; records_malformed: number;
  health: string; last_error: string | null;
}
interface CountRow { source: string; n: number }

function parseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Every table this reader touches. All are created together by applyWtSchema. */
const WT_TABLES = [
  "wt_sources", "wt_ingest_state", "wt_requests", "wt_events", "wt_tools",
  "wt_usage", "wt_sessions", "wt_record_fingerprints",
];

export function readSources(
  db: string,
  opts: { now?: number; configured?: Record<string, ConfiguredSource> } = {},
): SourcesData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const configured = opts.configured ?? {};

  const present = read<{ name: string }>(db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wt\\_%' ESCAPE '\\';`);
  const synced = WT_TABLES.every((t) => present.some((p) => p.name === t));

  const reg = synced ? read<RegRow>(db,
    `SELECT source, source_type, label, adapter_version, capabilities, authority, first_seen
       FROM wt_sources;`) : [];
  const state = synced ? read<StateRow>(db,
    `SELECT source, cursor, last_run_at, last_ok_at, records_ingested, metrics_rejected,
            records_malformed, health, last_error
       FROM wt_ingest_state;`) : [];

  // One statement, so a page load is one sqlite3 process for the inventory.
  const held = synced ? read<CountRow & { t: string }>(db, `
    SELECT 'requests' AS t, source, COUNT(*) AS n FROM wt_requests GROUP BY source
    UNION ALL SELECT 'events', source, COUNT(*) FROM wt_events GROUP BY source
    UNION ALL SELECT 'tools', source, COUNT(*) FROM wt_tools GROUP BY source
    UNION ALL SELECT 'usage', source, COUNT(*) FROM wt_usage GROUP BY source
    UNION ALL SELECT 'sessions', first_source, COUNT(*) FROM wt_sessions GROUP BY first_source
    UNION ALL SELECT 'fingerprints', source, COUNT(*) FROM wt_record_fingerprints GROUP BY source;`) : [];

  const ids = [...new Set([
    ...Object.keys(configured), ...reg.map((r) => r.source), ...state.map((s) => s.source),
  ])].sort();

  const sources = ids.map((id): SourceRow => {
    const r = reg.find((x) => x.source === id);
    const s = state.find((x) => x.source === id);
    const count = (t: string) => held.find((h) => h.t === t && h.source === id)?.n ?? 0;
    const type = (r?.source_type ?? null) as SourceType | null;
    return {
      source: id,
      enabled: configured[id] === undefined ? null : configured[id].enabled,
      registered: r !== undefined,
      type,
      label: r?.label ?? null,
      adapterVersion: r?.adapter_version ?? null,
      inActivityTotals: type === null ? null : contributesToActivityTotals(type),
      capabilities: r ? (parseJson<string[]>(r.capabilities) ?? []) : [],
      authority: r ? parseJson<MetricAuthority[]>(r.authority) : [],
      firstSeen: r?.first_seen ?? null,
      ingest: s === undefined ? null : {
        cursor: s.cursor,
        lastRunAt: s.last_run_at,
        lastOkAt: s.last_ok_at,
        recordsWritten: s.records_ingested,
        metricsRejected: s.metrics_rejected,
        malformed: s.records_malformed,
        health: s.health,
        lastError: s.last_error,
      },
      held: {
        requests: count("requests"), events: count("events"), tools: count("tools"),
        usage: count("usage"), sessions: count("sessions"), fingerprints: count("fingerprints"),
      },
    };
  });

  return { generatedAt: now, synced, sources };
}
