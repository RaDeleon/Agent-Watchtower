/**
 * The Codex and Hermes pages (spec §5). On Hermes the cost column is Hermes's
 * own figure and sessions group by entry point; on Codex it is "at API
 * prices", and unclassified originators are listed with the config key that
 * classifies them. Every empty state is spec §5's string.
 */
import { AGENT_SESSION_CAP, type AgentData, type AgentSessionRow } from "../read/agent.ts";
import { rangeLabel } from "../read/range.ts";
import { dayBars, sortableTable, type SortCell } from "./charts.ts";
import { API_PRICES, apiCostBold, apiCostCell, HERMES_FIGURE, hermesCostBold, hermesCostCell } from "./cost.ts";
import {
  AUTOMATED_ONLY, dataAsOf, lookedFor, firstSyncFailed, NO_DRIVEN_HOURS, NO_REQUESTS, NOT_SYNCED, ROLLUP_PENDING,
} from "./empty.ts";
import { compact, esc, grouped, localZone, minute, num, stamp, zoneNote } from "./html.ts";
import { card, type View } from "./layout.ts";
import { levelCard } from "./level.ts";
import { REPORT_ROWS } from "./sessions.ts";

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;
const DASH = `<span class="absent">—</span>`;

function costHead(d: AgentData): string {
  return d.source === "hermes" ? HERMES_FIGURE : API_PRICES;
}

function costCellOf(d: AgentData, c: { apiCost: AgentData["models"][number]["apiCost"]; hermesCost: AgentData["models"][number]["hermesCost"] }): SortCell {
  return d.source === "hermes" ? hermesCostCell(c.hermesCost) : apiCostCell(c.apiCost);
}

function summaryCard(d: AgentData, tz: string): string {
  const t = d.totals;
  if (t === null) return card({ title: `${d.label} · ${rangeLabel(d.range)}`, body: `<div class="state absent">${esc(ROLLUP_PENDING)}</div>` });
  const hours = t.activeS !== null ? `<b>${num(t.activeS / 3600, 1)}h</b>`
    : t.requests > 0 && t.sessions.driven === 0 ? absent(AUTOMATED_ONLY) : absent(NO_DRIVEN_HOURS);
  const cost = d.source === "hermes" ? hermesCostBold(t.hermesCost) : apiCostBold(t.apiCost);
  const asOf = d.status.state === "synced" && d.status.degraded
    ? `<p class="note">${esc(dataAsOf(stamp(d.status.lastOkAt, tz)))}</p>` : "";
  return card({
    title: `${d.label} · ${rangeLabel(d.range)}`,
    body: [
      kv("active hours", hours),
      kv("sessions", `<b>${grouped(t.sessions.driven)} driven · ${grouped(t.sessions.automated)} automated · ${grouped(t.sessions.unclassified)} unclassified</b>`),
      kv("requests", t.requests === 0 ? absent(NO_REQUESTS) : `<b>${grouped(t.requests)}</b>`),
      kv("tokens in + out", `<b>${compact(t.tokens.in + t.tokens.out)}</b>`),
      kv(costHead(d), cost),
    ].join("") + asOf,
  });
}

function dailyCards(d: AgentData): string {
  const hours = dayBars({
    bars: d.days.map((x) => ({ label: x.day, value: x.activeS === null ? null : x.activeS / 3600 })),
    label: "driven active hours by day · a dashed stub is a day with no driven hours",
    format: (v) => `${num(v, 1)}h`, emptyText: NO_REQUESTS,
  });
  const tokens = dayBars({
    bars: d.days.map((x) => ({ label: x.day, value: x.tokens })),
    label: "tokens in + out by day", format: compact, emptyText: NO_REQUESTS,
  });
  return `<div class="g g-2">${card({ title: "Hours", body: hours })}${card({ title: "Tokens", body: tokens })}</div>`;
}

function modelsCard(d: AgentData): string {
  const total = d.models.reduce((a, m) => a + m.requests, 0);
  const rows = d.models.map((m) => ({ cells: {
    model: { html: esc(m.model), sort: m.model },
    requests: { html: grouped(m.requests), sort: m.requests },
    share: { html: total > 0 ? `${num((100 * m.requests) / total, 1)}%` : DASH, sort: total > 0 ? m.requests / total : null },
    tokens: { html: compact(m.tokens), sort: m.tokens },
    cost: costCellOf(d, m),
  } }));
  return card({ title: "Models", wide: true, body: sortableTable(
    [{ key: "model", label: "model" }, { key: "requests", label: "requests", num: true },
     { key: "share", label: "share of requests", num: true }, { key: "tokens", label: "in + out", num: true },
     { key: "cost", label: costHead(d), num: true }],
    rows, { empty: NO_REQUESTS }) });
}

function projectsCard(d: AgentData): string {
  const rows = d.projects.map((p) => ({ cells: {
    project: { html: `<span title="${esc(p.project)}">${esc(p.project.startsWith("(") ? p.project : p.project.split("/").pop() ?? p.project)}</span>`, sort: p.project },
    hours: p.activeS === null ? { html: DASH, sort: null } : { html: `${num(p.activeS / 3600, 1)}h`, sort: p.activeS },
    requests: { html: grouped(p.requests), sort: p.requests },
    tokens: { html: compact(p.tokens), sort: p.tokens },
  } }));
  return card({ title: "Projects", wide: true, body: sortableTable(
    [{ key: "project", label: "project" }, { key: "hours", label: "driven hours", num: true },
     { key: "requests", label: "requests", num: true }, { key: "tokens", label: "in + out", num: true }],
    rows, { empty: NO_REQUESTS }) });
}

const CLASS = (v: 0 | 1 | null) => (v === 1 ? "driven" : v === 0 ? "automated" : "unclassified");

function sessionsTable(d: AgentData, rows: AgentSessionRow[], tz: string): string {
  return sortableTable(
    [{ key: "start", label: "start" }, { key: "end", label: "end" }, { key: "entry", label: "entry point" },
     { key: "class", label: "class" }, { key: "requests", label: "requests", num: true },
     { key: "tokens", label: "in + out", num: true }, { key: "cost", label: costHead(d), num: true },
     { key: "id", label: "session" }],
    rows.map((s) => ({ cells: {
      start: { html: minute(s.startedAt, tz), sort: s.startedAt },
      end: s.endedAt === null ? { html: DASH, sort: null } : { html: minute(s.endedAt, tz), sort: s.endedAt },
      entry: { html: esc(s.entry ?? "—"), sort: s.entry },
      class: { html: CLASS(s.driven), sort: CLASS(s.driven) },
      requests: { html: grouped(s.requests), sort: s.requests },
      tokens: { html: compact(s.tokens), sort: s.tokens },
      cost: costCellOf(d, s),
      id: { html: `<span class="sid" title="${esc(s.id)}">${esc(s.id.slice(0, 8))}</span>`, sort: s.id },
    } })),
    { empty: `no sessions ${rangeLabel(d.range) === "all time" ? "on record" : `in the ${rangeLabel(d.range)}`}` },
  );
}

function sessionsCards(d: AgentData, tz: string, served: boolean): string {
  // The report is a file: like the Sessions page it lists REPORT_ROWS, newest first.
  const shown = served ? d.sessionRows : d.sessionRows.slice(0, REPORT_ROWS);
  const cap = shown.length < d.sessionRows.length
    ? `<p class="note">This report lists the ${REPORT_ROWS} most recent of ${d.capped ? "more than " : ""}${grouped(d.capped ? AGENT_SESSION_CAP : d.sessionRows.length)} sessions in this range; serve the dashboard for up to ${AGENT_SESSION_CAP}.</p>`
    : d.capped ? `<p class="note">Showing the ${grouped(d.sessionRows.length)} most recent sessions.</p>` : "";
  if (d.source !== "hermes") return card({ title: "Sessions", wide: true, body: sessionsTable(d, shown, tz) + cap });
  const entries = [...new Set(shown.map((s) => s.entry ?? "—"))].sort();
  if (entries.length === 0) return card({ title: "Sessions", wide: true, body: sessionsTable(d, [], tz) });
  return entries.map((e) => card({
    title: `Sessions · ${e}`, wide: true,
    body: sessionsTable(d, shown.filter((s) => (s.entry ?? "—") === e), tz),
  })).join("") + cap;
}

function unclassifiedCard(d: AgentData): string {
  if (d.unclassified.length === 0) return "";
  const list = d.unclassified.map((u) => `<li><code>${esc(u.entry)}</code> · ${grouped(u.sessions)} ${u.sessions === 1 ? "session" : "sessions"}</li>`).join("");
  return card({
    title: "Unclassified entry points",
    body: `<p class="note">These earn no hours until classified. Add one to <code>${esc(d.configKey)}</code> (or the matching <code>automated</code> list) in watchtower.config.json; the next sync reclassifies every session.</p><ul>${list}</ul>`,
  });
}

export function agentSections(d: AgentData, tz: string, served = false): string[] {
  if (d.status.state === "not-installed") {
    return [card({ title: d.label, body: `<div class="state absent">${esc(lookedFor(d.label, d.status.lookedAt))}</div>` })];
  }
  if (d.status.state === "failed") {
    return [card({ title: d.label, body: `<div class="state absent">${esc(firstSyncFailed(d.status.lastError))}</div>` })];
  }
  if (d.status.state === "not-synced") {
    return [card({ title: d.label, body: `<div class="state absent">${esc(NOT_SYNCED)}</div>` })];
  }
  const top = `<div class="g g-2">${levelCard({ title: "Level", state: d.level, hero: true, source: d.source })}${summaryCard(d, tz)}</div>`;
  if (d.rollupPending) return [top, unclassifiedCard(d)];
  return [top, dailyCards(d), modelsCard(d), projectsCard(d), sessionsCards(d, tz, served), unclassifiedCard(d)];
}

export function agentView(d: AgentData, opts: { tz?: string; served?: boolean } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = agentSections(d, tz, opts.served === true);
  return {
    href: `/${d.source}`,
    title: d.label,
    body: sections.join(""),
    sections,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · days are local, ${zoneNote(tz, d.generatedAt)} · ` +
      `from agent_daily_rollups, agent_request_metrics, agent_progress and wt_* · hours count driven sessions only` +
      (d.source === "hermes" ? ` · cost is ${HERMES_FIGURE}, never at API prices` : ""),
  };
}
