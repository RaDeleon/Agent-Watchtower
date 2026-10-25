import { execSql, querySql, sqlStr, sqlNum } from "./sql.ts";
import type { RecordKind, WatchtowerRecord } from "./records.ts";

export type Capability =
  | "sessions" | "requests" | "usage" | "tools"
  | "git" | "checkpoints" | "memory" | "health";

/**
 * What kind of thing a source is. This is NOT cosmetic: it decides what the
 * source may contribute to cross-tool totals.
 *
 *  agent      a coding agent whose activity and spend are the thing Watchtower
 *             measures -- Claude Code, Codex
 *  provenance observes work another source already reported; contributes git
 *             history and links, never usage -- Atlas
 *  memory     a memory/retrieval service; its tokens are its own, not a coding
 *             agent's -- OpenViking
 *  health     liveness and service telemetry only, no activity, no spend -- Hermes
 */
export type SourceType = "agent" | "provenance" | "memory" | "health";

/**
 * Only agent sources belong in cross-tool activity and spend totals.
 *
 * Without this, the Overview would add OpenViking's embedding tokens and
 * Atlas's re-reported session tokens to Claude's and call the sum "AI spend" --
 * the same category error as double-counting, arriving by a different route.
 */
export function contributesToActivityTotals(type: SourceType): boolean {
  return type === "agent";
}

export interface MetricAuthority {
  kind: RecordKind;
  metrics: string[];
  /**
   * "own": the claim covers only records this source emits itself, which land on
   * its own (source, source_record_id) rows -- Codex's tokens on Codex requests,
   * Claude's on Claude requests. Two own claims never contend: when each source
   * writes only its own rows, no number can be counted twice.
   *
   * Absent: EXCLUSIVE, the Stage 3 rule. One source in the registry owns
   * (kind, metric) and every other claim on it is refused -- which is what keeps
   * Atlas's re-reported token_totals out (see isAuthoritative).
   */
  scope?: "own";
}
export interface DetectionResult { detected: boolean; detail?: string }
export interface AdapterHealth { state: "ok" | "degraded" | "unavailable"; detail?: string }

export interface WatchtowerAdapter {
  readonly id: string;
  readonly type: SourceType;
  readonly label: string;
  readonly version: number;
  readonly capabilities: Capability[];
  readonly authority: MetricAuthority[];
  /** A PROBE. Must not throw -- absence is a state, not an error. See safeDetect. */
  detect(): Promise<DetectionResult>;
  /** A PROBE. Must not throw -- brokenness is a state, not an error. See safeHealth. */
  health(): Promise<AdapterHealth>;
  ingest(cursor?: string): AsyncIterable<WatchtowerRecord>;
  /**
   * Optional. Called by runSync once ingest() is drained. `clean` is true when
   * every record of the run was written. An adapter with an advisory cursor
   * commits it here, and only when clean. Returns source-side malformed lines
   * (ones that never became records) for runSync to add to the run.
   */
  finish?(opts: { clean: boolean }): { malformed: number; detail?: string };
}

export interface SourceRow {
  source: string; source_type: SourceType; label: string | null;
  adapter_version: number; enabled: number;
  capabilities: string; authority: string;
}

interface AuthorityRow { source: string; authority: string }

/**
 * Every registered source's claims, in OWNERSHIP ORDER: earliest first_seen
 * first, source id as the tie-break so the order is total and stable.
 *
 * first_seen is never rewritten by re-registration (the upsert below leaves it
 * alone), so a source cannot lose a metric it already owns by restarting.
 */
function claimsInOwnershipOrder(db: string): AuthorityRow[] {
  return querySql<AuthorityRow>(db, `SELECT source, authority FROM wt_sources
    ORDER BY COALESCE(first_seen, 0) ASC, source ASC;`);
}

interface Owner { source: string; claims: MetricAuthority[] }

/** The registry in ownership order, with each source's claims parsed. */
function ownersInOrder(db: string): Owner[] {
  // Malformed JSON here is a corrupt registry, not a routine condition: this is
  // not the hook path, so it fails loudly rather than silently reassigning a metric.
  return claimsInOwnershipOrder(db).map((row) => ({
    source: row.source, claims: JSON.parse(row.authority) as MetricAuthority[],
  }));
}

function claimOf(claims: MetricAuthority[], kind: RecordKind, metric: string): MetricAuthority | undefined {
  return claims.find((c) => c.kind === kind && c.metrics.includes(metric));
}

/** Two claims on one (kind, metric) contend unless both are scoped to their own records. */
function contend(a: MetricAuthority, b: MetricAuthority): boolean {
  return !(a.scope === "own" && b.scope === "own");
}

/**
 * The single source that EXCLUSIVELY owns (kind, metric), or null. Own-scope
 * claims are not ownership of the metric everywhere, so they never answer here.
 * If a database somehow holds two exclusive claimants, the FIRST keeps it.
 */
export function authorityOwner(db: string, kind: RecordKind, metric: string): string | null {
  for (const o of ownersInOrder(db)) {
    const c = claimOf(o.claims, kind, metric);
    if (c !== undefined && c.scope !== "own") return o.source;
  }
  return null;
}

/**
 * May `source` write `metric` on its records of `kind`? Yes when it declares the
 * metric and no EARLIER source in ownership order holds a contending claim.
 *
 * The registry is read ONCE: ingest asks this for every metric of every record,
 * and a sqlite3 spawn per question was most of why a sync once took ~14 minutes.
 * It does not change during a run -- registerSource happens before ingest starts.
 */
export function writeAuthority(db: string): (source: string, kind: RecordKind, metric: string) => boolean {
  const owners = ownersInOrder(db);
  return (source, kind, metric) => {
    const i = owners.findIndex((o) => o.source === source);
    if (i === -1) return false;
    const mine = claimOf(owners[i].claims, kind, metric);
    if (mine === undefined) return false;
    return !owners.slice(0, i).some((o) => {
      const theirs = claimOf(o.claims, kind, metric);
      return theirs !== undefined && contend(mine, theirs);
    });
  };
}

export function registerSource(db: string, a: WatchtowerAdapter): void {
  // Exclusivity is enforced at REGISTRATION as well as at query time. A second
  // source declaring an owned metric is a configuration error, and this is not
  // the hook path, so it is refused loudly instead of being quietly ignored.
  const owners = ownersInOrder(db);
  const at = owners.findIndex((o) => o.source === a.id);
  const earlier = at === -1 ? owners : owners.slice(0, at);
  for (const claim of a.authority) {
    for (const metric of claim.metrics) {
      for (const o of earlier) {
        const theirs = claimOf(o.claims, claim.kind, metric);
        if (theirs !== undefined && contend(claim, theirs)) {
          throw new Error(
            `source "${a.id}" claims authority over (${claim.kind}, ${metric}), ` +
            `already owned by "${o.source}"; exactly one source may own a metric`);
        }
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  execSql(db, `INSERT INTO wt_sources
      (source, source_type, label, adapter_version, enabled, capabilities,
       authority, first_seen, updated_at)
    VALUES (${sqlStr(a.id)}, ${sqlStr(a.type)}, ${sqlStr(a.label)},
            ${sqlNum(a.version)}, 1,
            ${sqlStr(JSON.stringify(a.capabilities))},
            ${sqlStr(JSON.stringify(a.authority))},
            ${sqlNum(now)}, ${sqlNum(now)})
    ON CONFLICT(source) DO UPDATE SET
      source_type     = excluded.source_type,
      label           = excluded.label,
      adapter_version = excluded.adapter_version,
      capabilities    = excluded.capabilities,
      authority       = excluded.authority,
      updated_at      = excluded.updated_at;`);
}

export function listSources(db: string): SourceRow[] {
  return querySql<SourceRow>(db, `SELECT source, source_type, label,
    adapter_version, enabled, capabilities, authority
    FROM wt_sources ORDER BY source;`);
}

/**
 * The load-bearing rule: exactly one authoritative source per (kind, metric).
 *
 * Atlas carries token_totals that disagree with claude_requests by 2.03x on
 * one session and 0.42x on another -- high where it sums duplicate requestIds,
 * low where it cannot see subagent traffic. Two observers that disagree in
 * both directions cannot be reconciled into one metric, so ownership is
 * declared rather than negotiated.
 *
 * Scoped by kind, so a metric name shared across kinds (checkpoint.insertions
 * vs request.insertions) never grants ownership by accident.
 *
 * Own-scope claims coexist (R1); an exclusive claim still excludes everyone
 * else.
 */
export function isAuthoritative(
  db: string, source: string, kind: RecordKind, metric: string,
): boolean {
  return writeAuthority(db)(source, kind, metric);
}

/**
 * Run an adapter's detect() probe with the never-throws guarantee enforced.
 *
 * Discovery probes every known source in turn; one adapter blowing up must not
 * take the rest of the sweep with it. A failed probe is "not detected", with
 * the reason carried in `detail`.
 */
export async function safeDetect(a: WatchtowerAdapter): Promise<DetectionResult> {
  try {
    return await a.detect();
  } catch (e) {
    return { detected: false, detail: String(e) };
  }
}

/** Same guarantee for health(): a probe that fails reports "unavailable". */
export async function safeHealth(a: WatchtowerAdapter): Promise<AdapterHealth> {
  try {
    return await a.health();
  } catch (e) {
    return { state: "unavailable", detail: String(e) };
  }
}
