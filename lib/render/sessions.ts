/**
 * The Sessions view: the most expensive session in range (the hero) and a
 * sortable table of every session in range, newest first, capped.
 *
 * Served, each project cell links to `/sessions?project=…` to filter the
 * table; the report is a file with no server to ask, so it prints the project
 * as text and shows every project.
 *
 * Cost is the honesty case here, and it is shown two ways (spec 4B): at API
 * prices, the rollup's price of the session's requests, and Claude Code's
 * figure, the status line's running total. A session with no status-line
 * reading has no figure: its cell is "no reading" with an empty sort value
 * (last in both directions), never `$0.00`; a session whose requests had no
 * price is "not priced". A range where no session has a reading says "no
 * cost data" in the hero rather than crowning a $0.
 *
 * Pure: `serve` and `report` both render through here.
 */
import { projectLabel } from "../read/projects.ts";
import { rangeLabel, type Range } from "../read/range.ts";
import { SESSION_CAP, type SessionRow, type SessionsData } from "../read/sessions.ts";
import { sortableTable, type SortCell } from "./charts.ts";
import { API_PRICES, CC_FIGURE, apiCostBold, apiCostCell, claudeCodeCostCell, usd } from "./cost.ts";
import { compact, esc, grouped, localZone, minute, num, stamp, zoneNote } from "./html.ts";
import { card, viewPage, type View } from "./layout.ts";

export interface SessionsViewOpts {
  /** Epoch seconds the page was generated at, for the footer. */
  now: number;
  /** Served: project cells link to their filter. The report leaves this off. */
  served?: boolean;
  /** The zone times are printed in. Defaults to the process's. */
  tz?: string;
}

/**
 * Rows per range in the report. A file carries every range's table at once
 * and has a size budget (REPORT_BUDGET_BYTES), so it lists the most recent sessions
 * only; served, the page lists up to {@link SESSION_CAP}.
 */
export const REPORT_ROWS = 60;

const DASH = `<span class="absent">—</span>`;
/** The filter link for a project, keeping the range. */
export function sessionsHref(range: Range, project?: string): string {
  return `/sessions?range=${range}${project === undefined ? "" : `&project=${encodeURIComponent(project)}`}`;
}

/** A known filter: one the reader matched against a project on record. */
const knownFilter = (d: SessionsData): string | null =>
  d.project !== null && d.projects.includes(d.project) ? d.project : null;

/** "in the last 7 days" / "at all": for empty states. */
const within = (r: Range) => (r === "all" ? "on record" : `in the ${rangeLabel(r)}`);

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;

/**
 * The hero: the highest cost reading among the listed sessions. With no
 * session at all, or none with a reading, it says so in words -- the hero
 * never shows `$0.00` for a cost nobody measured.
 */
function heroCard(d: SessionsData, tz: string): string {
  const title = `Most expensive session · ${rangeLabel(d.range)}`;
  if (d.rows.length === 0) {
    return card({
      title,
      hero: true,
      body: `<div class="big absent">—</div><div class="muted label">no sessions ${d.project === null ? "" : "for this project "}${within(d.range)}</div>`,
    });
  }
  let top: SessionRow | null = null;
  for (const r of d.rows) if (r.costUsd !== null && (top === null || top.costUsd === null || r.costUsd > top.costUsd)) top = r;
  if (top === null || top.costUsd === null) {
    return card({
      title,
      hero: true,
      body:
        `<div class="big absent">no cost data</div>` +
        `<div class="muted label">none of the ${grouped(d.rows.length)} listed ${d.rows.length === 1 ? "session has" : "sessions have"} a status-line cost reading</div>`,
    });
  }
  const cost = top.costUsd;
  const facts = [
    kv("project", `<b title="${esc(top.project)}">${esc(projectLabel(top.project))}</b>`),
    kv("terminal", top.terminal === null ? `<b class="absent">unknown</b>` : `<b>${esc(top.terminal)}</b>`),
    kv("first request", `<b>${stamp(top.firstTs, tz)}</b>`),
    kv("last request", `<b>${stamp(top.lastTs, tz)}</b>`),
    kv("requests", `<b>${grouped(top.requests)}</b>`),
    kv("in + out tokens", `<b>${compact(top.freshTokens)}</b>`),
    kv("context / turn ≈", top.contextPerTurn === null ? `<b class="absent">—</b>` : `<b>${compact(top.contextPerTurn)}</b>`),
    kv(`cost · ${API_PRICES}`, apiCostBold(top.apiCost)),
  ].join("");
  return card({
    title,
    hero: true,
    body:
      `<div class="rank-hero"><div>` +
      `<div class="big"${Number.isFinite(cost) ? ` data-count="${num(cost, 2)}"` : ""}>${usd(cost)}</div>` +
      `<div class="muted label">${esc(CC_FIGURE)}: the highest status-line cost reading, whole session (lifetime)${d.capped ? `, among the ${SESSION_CAP} most recent` : ""}</div>` +
      `<div class="sid">${esc(top.sessionId)}</div></div>` +
      `<div class="block">${facts}</div></div>`,
  });
}

const COLUMNS = [
  { key: "started", label: "first request" },
  { key: "last", label: "last request" },
  { key: "project", label: "project" },
  { key: "terminal", label: "terminal" },
  { key: "requests", label: "requests", num: true },
  { key: "fresh", label: "in + out", num: true },
  { key: "cache", label: "cache read", num: true },
  { key: "ctx", label: "context / turn ≈", num: true },
  { key: "api", label: `${API_PRICES} (lifetime)`, num: true },
  { key: "cost", label: `${CC_FIGURE} (lifetime)`, num: true },
  { key: "session", label: "session" },
];

const atlasLine = (a: SessionRow["atlas"]): string =>
  a === null ? "" : `<span class="atlas muted">Atlas: ${grouped(a.checkpoints)} ${a.checkpoints === 1 ? "checkpoint" : "checkpoints"} · ${grouped(a.files)} ${a.files === 1 ? "file" : "files"} touched</span>`;

function rowCells(r: SessionRow, d: SessionsData, served: boolean, tz: string): Record<string, SortCell> {
  const label = projectLabel(r.project);
  const project = served
    ? `<a href="${esc(sessionsHref(d.range, r.project))}" title="${esc(r.project)}">${esc(label)}</a>`
    : `<span title="${esc(r.project)}">${esc(label)}</span>`;
  const n = r.projectsInRange;
  const also = n > 1
    ? ` <span class="absent" title="ran in ${n} projects: each row holds only that project's requests, and the cost is the whole session's">+${n - 1}</span>`
    : "";
  return {
    started: { html: minute(r.firstTs, tz), sort: r.firstTs },
    last: { html: minute(r.lastTs, tz), sort: r.lastTs },
    project: { html: project, sort: label },
    terminal: r.terminal === null ? { html: `<span class="absent">unknown</span>`, sort: null } : { html: esc(r.terminal), sort: r.terminal },
    requests: { html: grouped(r.requests), sort: r.requests },
    fresh: { html: compact(r.freshTokens), sort: r.freshTokens },
    cache: { html: compact(r.cacheRead), sort: r.cacheRead },
    ctx: r.contextPerTurn === null ? { html: DASH, sort: null } : { html: compact(r.contextPerTurn), sort: Math.round(r.contextPerTurn) },
    // Guard 3: no reading is "no reading" with an empty sort value -- never
    // `$0.00`, and never a 0 that would sort among the cheapest sessions.
    api: apiCostCell(r.apiCost),
    cost: claudeCodeCostCell(r.costUsd),
    // The whole id, as text (M2): an 8-character prefix could be all digits.
    session: { html: `<span class="sid" title="${esc(r.sessionId)}">${esc(r.sessionId.slice(0, 8))}</span>${also}${atlasLine(r.atlas)}`, sort: r.sessionId },
  };
}

function tableCard(d: SessionsData, served: boolean, tz: string): string {
  const known = knownFilter(d);

  // An unknown filter is never echoed: it came from a query string.
  const filter =
    d.project === null
      ? ""
      : `<p class="note">${known === null ? "No sessions on record for that project." : `Only <b title="${esc(known)}">${esc(projectLabel(known))}</b>.`}` +
        `${served ? ` <a href="${esc(sessionsHref(d.range))}">Show every project</a>.` : ""}</p>`;
  const empty =
    d.project === null ? `no sessions ${within(d.range)}` : `no sessions for this project ${within(d.range)}`;
  const shown = served ? d.rows : d.rows.slice(0, REPORT_ROWS);
  const table = sortableTable(
    COLUMNS,
    shown.map((r) => ({ cells: rowCells(r, d, served, tz) })),
    { empty },
  );
  const cap =
    shown.length < d.rows.length
      ? `<p class="note">This report lists the ${REPORT_ROWS} most recent of ${d.capped ? "more than " : ""}${grouped(d.capped ? SESSION_CAP : d.rows.length)} sessions in this range; serve the dashboard for up to ${SESSION_CAP}.</p>`
      : d.capped
        ? `<p class="note">Showing the ${SESSION_CAP} most recent sessions in this range; older ones are not listed.</p>`
        : "";
  const note =
    `<p class="note">Newest first; click a heading to sort. Every figure is summed from the ingested requests, including sessions from before the hooks were installed. ` +
    `In + out is uncached input plus output; context per turn ≈ (input + cache read + cache write) / requests, subagent requests included. ` +
    `Both costs are the whole session's, lifetime, even where only some of its requests fall in this range; ${esc(CC_FIGURE)} is the status line's highest reading. ` +
    `"No reading" and "not priced" are never $0, and sort last. ` +
    `A session that ran in two projects has a row in each, holding that project's requests. Excluded paths are not shown. Times are local, in the zone the footer names.</p>`;
  return card({
    title: `Sessions · ${rangeLabel(d.range)}${known === null ? "" : ` · ${projectLabel(known)}`}`,
    wide: true,
    body: filter + table + cap + note,
  });
}

export function renderSessionsBody(d: SessionsData, opts: { served?: boolean; tz?: string } = {}): string {
  const tz = opts.tz ?? localZone();
  return heroCard(d, tz) + tableCard(d, opts.served === true, tz);
}

export function sessionsView(d: SessionsData, opts: SessionsViewOpts): View {
  const known = knownFilter(d);
  const tz = opts.tz ?? localZone();
  return {
    href: "/sessions",
    title: "Sessions",
    body: renderSessionsBody(d, { served: opts.served, tz }),
    footer: `generated ${stamp(opts.now, tz)} · times are local, ${zoneNote(tz, opts.now)} · tokens from claude_requests · cost ${API_PRICES} from claude_request_metrics, ${CC_FIGURE} from status-line snapshots`,
    // The range pills keep a filter -- only one the reader matched, never raw query text.
    pillQuery: known === null ? undefined : `&project=${encodeURIComponent(known)}`,
  };
}

export function renderSessionsPage(d: SessionsData, opts: SessionsViewOpts): string {
  return viewPage(sessionsView(d, opts));
}
