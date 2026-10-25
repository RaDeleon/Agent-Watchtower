/**
 * The Overview (spec §5): a card per detected tool, active hours stacked by
 * tool, Total level and Max Cape, the two cost bases kept apart, and the
 * OpenViking card. Every number is a stored rollup value, summed or counted;
 * nothing here derives an hour, a price or a level.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay } from "./history.ts";
import { AGENT_LABEL, hasTable, maxCape, readLevelCaps, readLevels, totalLevel, type AgentSource, type LevelState } from "./level.ts";
import { API_COST_SQL, apiCostOf, sumApiCosts, type ApiCost } from "./perf.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";
import { toolStatus, type ToolStatus } from "./tools.ts";

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/** A Codex or Hermes tool's figures over a span of days, from agent_daily_rollups. Null fields are "not measured". */
export interface AgentTotals {
  /** Null when no row in the span has a driven gap. */
  activeS: number | null;
  sessions: { driven: number; automated: number; unclassified: number };
  requests: number;
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
  /** Codex: at API prices. Null for Hermes. */
  apiCost: ApiCost | null;
  /** Hermes: its own figure. Null for Codex. */
  hermesCost: ApiCost | null;
}

/** The span a range covers, as local days: `from` is null for "all". */
export function dayRange(db: string, range: Range, now: number): { from: string | null; today: string } {
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
  return { from: rangeStartDay(today, range), today };
}

const inSpan = (col: string, from: string | null, today: string): string =>
  `${col} <= ${sqlStr(today)}${from === null ? "" : ` AND ${col} >= ${sqlStr(from)}`}`;

export function agentTotals(db: string, source: "codex" | "hermes", from: string | null, today: string): AgentTotals {
  const r = read<{
    active_s: number | null; driven: number | null; automated: number | null; unclassified: number | null;
    requests: number | null; tin: number | null; tout: number | null; tcr: number | null; tcw: number | null;
    usd: number; priced: number | null; unpriced: number | null;
    own_usd: number; own_priced: number | null; own_unpriced: number | null;
  }>(db,
    `SELECT SUM(active_s) AS active_s, SUM(sessions_driven) AS driven, SUM(sessions_automated) AS automated,
            SUM(sessions_unclassified) AS unclassified, SUM(requests) AS requests,
            SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_cache_read) AS tcr,
            SUM(tokens_cache_creation) AS tcw,
            TOTAL(cost_table_usd) AS usd, SUM(priced_requests) AS priced, SUM(unpriced_requests) AS unpriced,
            TOTAL(own_cost_usd) AS own_usd, SUM(own_priced_requests) AS own_priced,
            SUM(own_unpriced_requests) AS own_unpriced
     FROM agent_daily_rollups WHERE source = ${sqlStr(source)} AND ${inSpan("day", from, today)};`)[0];
  return {
    activeS: r.active_s,
    sessions: { driven: r.driven ?? 0, automated: r.automated ?? 0, unclassified: r.unclassified ?? 0 },
    requests: r.requests ?? 0,
    tokens: { in: r.tin ?? 0, out: r.tout ?? 0, cacheRead: r.tcr ?? 0, cacheWrite: r.tcw ?? 0 },
    apiCost: source === "codex" ? apiCostOf({ usd: r.usd, priced: r.priced, unpriced: r.unpriced }) : null,
    hermesCost: source === "hermes" ? apiCostOf({ usd: r.own_usd, priced: r.own_priced, unpriced: r.own_unpriced }) : null,
  };
}

export interface ToolSummary {
  source: AgentSource;
  label: string;
  /** Claude Code is always present: its data comes from the hooks, not from sync. */
  status: ToolStatus | { state: "core" };
  level: LevelState;
  /** In range. Null: nothing measured -- not synced, rollup pending, or no driven hours. */
  activeS: number | null;
  /** Claude: its session count, with no driven split (decision 8). */
  sessions: { total: number; driven: number | null; automated: number | null } | null;
  requests: number | null;
  tokens: { in: number; out: number } | null;
  apiCost: ApiCost | null;
  hermesCost: ApiCost | null;
}

export type OpenVikingState =
  | { state: "absent" }
  | {
      state: "seen"; checkedAt: number; reachable: boolean;
      recall: { at: number; count: number | null; latencyMs: number | null; tokens: number | null } | null;
      capture: { at: number; turns: number | null; committed: boolean | null } | null;
    };

export interface OverviewDay { day: string; claudeS: number | null; codexS: number | null; hermesS: number | null }

export interface OverviewData {
  range: Range;
  today: string;
  generatedAt: number;
  /** The installed rollup has not written agent_daily_rollups yet (v6 or never run since sync). */
  rollupPending: boolean;
  tools: ToolSummary[];
  daily: OverviewDay[];
  totalLevel: number | null;
  maxCape: { at: number; reached: number; of: number } | null;
  /** Claude Code + Codex, at API prices. Hermes's figure is NEVER summed in here (decision 4). */
  apiCost: ApiCost | null;
  hermesCost: ApiCost | null;
  openviking: OpenVikingState;
}

function claudeSummary(db: string, from: string | null, today: string, level: LevelState): ToolSummary {
  const d = read<{ rows: number; active_ms: number | null; sessions: number | null; tin: number | null; tout: number | null }>(db,
    `SELECT COUNT(*) AS rows, SUM(active_ms) AS active_ms, SUM(sessions_count) AS sessions,
            SUM(tokens_in) AS tin, SUM(tokens_out) AS tout
     FROM claude_daily_rollups WHERE ${inSpan("day", from, today)};`)[0];
  const m = hasTable(db, "claude_request_metrics")
    ? read<{ n: number; usd: number; priced: number | null; unpriced: number | null }>(db,
        `SELECT COUNT(*) AS n, ${API_COST_SQL} FROM claude_request_metrics WHERE ${inSpan("day", from, today)};`)[0]
    : undefined;
  return {
    source: "claude", label: AGENT_LABEL.claude, status: { state: "core" }, level,
    activeS: d.rows === 0 || d.active_ms === null ? null : Math.floor(d.active_ms / 1000),
    sessions: { total: d.sessions ?? 0, driven: null, automated: null },
    requests: m?.n ?? null,
    tokens: { in: d.tin ?? 0, out: d.tout ?? 0 },
    apiCost: m === undefined ? null : apiCostOf(m),
    hermesCost: null,
  };
}

function agentSummary(db: string, source: "codex" | "hermes", status: ToolStatus, level: LevelState,
                      pending: boolean, from: string | null, today: string): ToolSummary {
  const base = { source, label: AGENT_LABEL[source], status, level };
  if (status.state !== "synced" || pending) {
    return { ...base, activeS: null, sessions: null, requests: null, tokens: null, apiCost: null, hermesCost: null };
  }
  const t = agentTotals(db, source, from, today);
  return {
    ...base, activeS: t.activeS,
    sessions: { total: t.sessions.driven + t.sessions.automated + t.sessions.unclassified, driven: t.sessions.driven, automated: t.sessions.automated },
    requests: t.requests, tokens: { in: t.tokens.in, out: t.tokens.out },
    apiCost: t.apiCost, hermesCost: t.hermesCost,
  };
}

function readOpenViking(db: string): OpenVikingState {
  if (!hasTable(db, "wt_events") || !hasTable(db, "wt_usage")) return { state: "absent" };
  const latest = (probe: string): { ts: number; m: Map<string, number> } | null => {
    const rows = read<{ ts: number; metric: string; value: number }>(db,
      `SELECT e.ts, u.metric, u.value
       FROM wt_events e JOIN wt_usage u ON u.source = e.source AND u.source_record_id = e.source_record_id
       WHERE e.source = 'openviking' AND e.source_record_id = (
         SELECT source_record_id FROM wt_events
         WHERE source = 'openviking' AND json_extract(dimensions, '$.probe') = ${sqlStr(probe)}
         ORDER BY ts DESC, source_record_id DESC LIMIT 1);`);
    return rows.length === 0 ? null : { ts: rows[0].ts, m: new Map(rows.map((r) => [r.metric, r.value])) };
  };
  const h = latest("health");
  if (h === null) return { state: "absent" };
  const rc = latest("recall");
  const cp = latest("capture");
  return {
    state: "seen", checkedAt: h.ts, reachable: h.m.get("reachable") === 1,
    recall: rc === null ? null : {
      at: rc.ts, count: rc.m.get("recall_count") ?? null,
      latencyMs: rc.m.get("recall_latency_ms") ?? null, tokens: rc.m.get("recall_tokens") ?? null,
    },
    capture: cp === null ? null : {
      at: cp.ts, turns: cp.m.get("capture_turns") ?? null,
      committed: cp.m.has("capture_committed") ? cp.m.get("capture_committed") === 1 : null,
    },
  };
}

function daily(db: string, from: string | null, today: string, sources: readonly AgentSource[], pending: boolean): OverviewDay[] {
  const claude = new Map(read<{ day: string; s: number | null }>(db,
    `SELECT day, active_ms / 1000 AS s FROM claude_daily_rollups WHERE ${inSpan("day", from, today)};`).map((r) => [r.day, r.s]));
  const agent = new Map<string, number | null>();
  if (!pending && sources.some((s) => s !== "claude")) {
    for (const r of read<{ source: string; day: string; s: number | null }>(db,
      `SELECT source, day, SUM(active_s) AS s FROM agent_daily_rollups
       WHERE ${inSpan("day", from, today)} GROUP BY source, day;`)) agent.set(`${r.source}|${r.day}`, r.s);
  }
  const first = from ?? [...claude.keys(), ...[...agent.keys()].map((k) => k.split("|")[1])].sort()[0];
  if (first === undefined) return [];
  return eachDay(first, today).map((day) => ({
    day,
    claudeS: claude.get(day) ?? null,
    codexS: sources.includes("codex") ? agent.get(`codex|${day}`) ?? null : null,
    hermesS: sources.includes("hermes") ? agent.get(`hermes|${day}`) ?? null : null,
  }));
}

export function readOverview(db: string, opts: { now?: number; range?: Range; home?: string } = {}): OverviewData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const { from, today } = dayRange(db, range, now);
  const pending = !hasTable(db, "agent_daily_rollups");
  const caps = readLevelCaps(db);
  const levels = readLevels(db, caps);
  const tools: ToolSummary[] = [claudeSummary(db, from, today, levels.claude)];
  for (const source of ["codex", "hermes"] as const) {
    const status = toolStatus(db, source, opts.home);
    if (status.state === "not-installed") continue;
    tools.push(agentSummary(db, source, status, levels[source], pending, from, today));
  }
  const detected = tools.map((t) => t.level);
  const hermes = tools.find((t) => t.source === "hermes");
  return {
    range, today, generatedAt: now, rollupPending: pending, tools,
    daily: daily(db, from, today, tools.map((t) => t.source), pending),
    totalLevel: totalLevel(detected),
    maxCape: maxCape(detected, caps?.first ?? null),
    apiCost: sumApiCosts(tools.map((t) => t.apiCost)),
    hermesCost: hermes?.hermesCost ?? null,
    openviking: readOpenViking(db),
  };
}
