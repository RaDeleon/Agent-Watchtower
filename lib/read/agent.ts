/**
 * The Codex and Hermes pages (spec §5): one reader for both. Stored rollup
 * values and wt_* rows, grouped, summed and counted; no hour, price or level
 * is derived here.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay } from "./history.ts";
import { AGENT_LABEL, hasTable, readLevel, type LevelState } from "./level.ts";
import { agentTotals, dayRange, type AgentTotals } from "./overview.ts";
import { apiCostOf, type ApiCost } from "./perf.ts";
import { DEFAULT_RANGE, type Range } from "./range.ts";
import { toolStatus, type ToolStatus } from "./tools.ts";

export const AGENT_SESSION_CAP = 300;

export interface AgentModel { model: string; requests: number; tokens: number; apiCost: ApiCost | null; hermesCost: ApiCost | null }
export interface AgentProject { project: string; activeS: number | null; requests: number; tokens: number }
export interface AgentSessionRow {
  /** The tool's own session id (wt_links), else the canonical id. */
  id: string;
  entry: string | null;
  driven: 0 | 1 | null;
  startedAt: number;
  endedAt: number | null;
  requests: number;
  tokens: number;
  apiCost: ApiCost | null;
  hermesCost: ApiCost | null;
}

export interface AgentData {
  source: "codex" | "hermes";
  label: string;
  range: Range;
  today: string;
  generatedAt: number;
  status: ToolStatus;
  rollupPending: boolean;
  level: LevelState;
  totals: AgentTotals | null;
  days: { day: string; activeS: number | null; tokens: number | null }[];
  models: AgentModel[];
  projects: AgentProject[];
  sessionRows: AgentSessionRow[];
  capped: boolean;
  /** Entry points with no class (driven NULL), lifetime: config decides, so every session they hold counts. */
  unclassified: { entry: string; sessions: number }[];
  /** The config key that classifies an entry point as driven. */
  configKey: string;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const span = (col: string, from: string | null, today: string): string =>
  `${col} <= ${sqlStr(today)}${from === null ? "" : ` AND ${col} >= ${sqlStr(from)}`}`;

function costs(source: "codex" | "hermes", r: {
  usd: number; priced: number | null; unpriced: number | null;
  own_usd: number; own_priced: number | null; own_unpriced: number | null;
}): { apiCost: ApiCost | null; hermesCost: ApiCost | null } {
  return source === "codex"
    ? { apiCost: apiCostOf(r), hermesCost: null }
    : { apiCost: null, hermesCost: apiCostOf({ usd: r.own_usd, priced: r.own_priced, unpriced: r.own_unpriced }) };
}

const COST_COLS =
  `TOTAL(CASE WHEN m.priced = 1 THEN m.cost_table_usd END) AS usd,
   SUM(CASE WHEN m.priced = 1 THEN 1 ELSE 0 END) AS priced,
   SUM(CASE WHEN m.priced = 0 THEN 1 ELSE 0 END) AS unpriced,
   TOTAL(m.own_cost_usd) AS own_usd,
   SUM(CASE WHEN m.source = 'hermes' AND m.own_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS own_priced,
   SUM(CASE WHEN m.source = 'hermes' AND m.own_cost_usd IS NULL AND m.source_record_id IS NOT NULL THEN 1 ELSE 0 END) AS own_unpriced`;

export function readAgent(db: string, source: "codex" | "hermes", opts: { now?: number; range?: Range; home?: string } = {}): AgentData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const { from, today } = dayRange(db, range, now);
  const status = toolStatus(db, source, opts.home);
  const pending = !hasTable(db, "agent_daily_rollups") || !hasTable(db, "agent_request_metrics");
  const base: AgentData = {
    source, label: AGENT_LABEL[source], range, today, generatedAt: now, status, rollupPending: pending,
    level: readLevel(db, source), totals: null, days: [], models: [], projects: [], sessionRows: [], capped: false,
    unclassified: [], configKey: `sources.${source}.driven`,
  };
  if (status.state !== "synced") return base;

  const unclassified = read<{ entry: string; n: number }>(db,
    `SELECT COALESCE(entry, '(none)') AS entry, COUNT(*) AS n FROM wt_sessions
     WHERE first_source = ${sqlStr(source)} AND driven IS NULL GROUP BY 1 ORDER BY n DESC, 1;`)
    .map((r) => ({ entry: r.entry, sessions: r.n }));
  if (pending) return { ...base, unclassified };

  const byDay = new Map(read<{ day: string; s: number | null; tok: number }>(db,
    `SELECT day, SUM(active_s) AS s, SUM(tokens_in + tokens_out) AS tok FROM agent_daily_rollups
     WHERE source = ${sqlStr(source)} AND ${span("day", from, today)} GROUP BY day;`).map((r) => [r.day, r]));
  const first = from ?? [...byDay.keys()].sort()[0];
  const days = first === undefined ? [] : eachDay(first, today).map((day) => {
    const r = byDay.get(day);
    return { day, activeS: r?.s ?? null, tokens: r === undefined ? null : r.tok };
  });

  const models = read<{ model: string; n: number; tok: number; usd: number; priced: number | null; unpriced: number | null; own_usd: number; own_priced: number | null; own_unpriced: number | null }>(db,
    `SELECT COALESCE(NULLIF(m.model, ''), '(unknown)') AS model, COUNT(*) AS n,
            COALESCE(SUM(r.tokens_in + r.tokens_out), 0) AS tok, ${COST_COLS}
     FROM agent_request_metrics m
     LEFT JOIN wt_requests r ON r.source = m.source AND r.source_record_id = m.source_record_id
     WHERE m.source = ${sqlStr(source)} AND ${span("m.day", from, today)}
     GROUP BY 1 ORDER BY n DESC, 1;`)
    .map((r) => ({ model: r.model, requests: r.n, tokens: r.tok, ...costs(source, r) }));

  const projects = read<{ p: string; s: number | null; n: number; tok: number }>(db,
    `SELECT project_key AS p, SUM(active_s) AS s, SUM(requests) AS n, SUM(tokens_in + tokens_out) AS tok
     FROM agent_daily_rollups
     WHERE source = ${sqlStr(source)} AND ${span("day", from, today)} AND project_key <> '(excluded)'
     GROUP BY 1 ORDER BY COALESCE(SUM(active_s), 0) DESC, n DESC, 1;`)
    .map((r) => ({ project: r.p, activeS: r.s, requests: r.n, tokens: r.tok }));

  const raw = read<{ id: string; entry: string | null; driven: number | null; started_at: number; ended_at: number | null; n: number; tok: number; usd: number; priced: number | null; unpriced: number | null; own_usd: number; own_priced: number | null; own_unpriced: number | null }>(db,
    `SELECT COALESCE((SELECT MIN(l.source_local_id) FROM wt_links l
                      WHERE l.canonical_id = s.canonical_id AND l.source = s.first_source
                        AND l.link_kind = 'same_session'), s.canonical_id) AS id,
            s.entry, s.driven, s.started_at, s.ended_at,
            COUNT(m.source_record_id) AS n,
            COALESCE(SUM(r.tokens_in + r.tokens_out), 0) AS tok, ${COST_COLS}
     FROM wt_sessions s
     LEFT JOIN agent_request_metrics m ON m.canonical_id = s.canonical_id AND m.source = s.first_source
     LEFT JOIN wt_requests r ON r.source = m.source AND r.source_record_id = m.source_record_id
     WHERE s.first_source = ${sqlStr(source)} AND s.started_at IS NOT NULL
       AND ${span("date(s.started_at, 'unixepoch', 'localtime')", from, today)}
     GROUP BY s.canonical_id
     ORDER BY s.started_at DESC, s.canonical_id
     LIMIT ${sqlNum(AGENT_SESSION_CAP + 1)};`);
  const sessionRows = raw.slice(0, AGENT_SESSION_CAP).map((r) => ({
    id: r.id, entry: r.entry, driven: r.driven === null ? null : (r.driven === 1 ? 1 : 0) as 0 | 1,
    startedAt: r.started_at, endedAt: r.ended_at, requests: r.n, tokens: r.tok, ...costs(source, r),
  }));

  return {
    ...base, unclassified, totals: agentTotals(db, source, from, today),
    days, models, projects, sessionRows, capped: raw.length > AGENT_SESSION_CAP,
  };
}
