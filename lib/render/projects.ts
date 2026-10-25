/**
 * The Projects view, as cards: the top project by active hours (the hero),
 * where the range went (repos donut) and which terminals the sessions ran in,
 * the ranked table (sortable), and per-branch tokens.
 *
 * Every figure covers `d.range` (spec §5): the reader bounds them all by the
 * range's whole local days.
 *
 * Pure: `serve` and `report` both render through here.
 */
import type { BranchRow, ProjectSummary, ProjectsData } from "../read/projects.ts";
import { eachDay } from "../read/history.ts";
import { buckets, rangeLabel, type Range } from "../read/range.ts";
import { donut, sortableTable, sparkline, type SortCell } from "./charts.ts";
import { API_PRICES, CC_FIGURE, NO_READING, apiCostBold, apiCostCell, claudeCodeCostBold, claudeCodeCostCell, usd } from "./cost.ts";
import { compact, esc, grouped, localZone, num, stamp, zoneNote } from "./html.ts";
import { card, viewPage, type View } from "./layout.ts";
import { sessionsHref } from "./sessions.ts";

/** Slices in the repos and terminals donuts; the rest fold into one "other" slice. */
const DONUT_SLICES = 5;
/** Rows in the branch table. */
const BRANCH_ROWS = 25;

const hours = (n: number) => `${num(n, 1)}h`;

/** "in the last 7 days" / "on record": for empty states. */
const within = (r: Range) => (r === "all" ? "on record" : `in the ${rangeLabel(r)}`);

const totalTokens = (x: { tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheCreation: number }) =>
  x.tokensIn + x.tokensOut + x.tokensCacheRead + x.tokensCacheCreation;

function linesCell(p: ProjectSummary): SortCell {
  if (p.linesAdded === null && p.linesRemoved === null) {
    return { html: `<span class="absent" title="no session here reported a line count">no reading</span>`, sort: null };
  }
  // Each side on its own: one reported and one NULL must not print a "−0" or
  // "+0" that claims a measured zero.
  const side = (n: number | null, cls: string, sign: string, what: string) =>
    n === null
      ? `<span class="${cls} absent" title="no ${what} count reported">${sign}—</span>`
      : `<span class="${cls}">${sign}${grouped(n)}</span>`;
  return {
    html: `${side(p.linesAdded, "add", "+", "added-line")} ${side(p.linesRemoved, "del", "−", "removed-line")}`,
    sort: p.linesAdded,
  };
}

/**
 * Two repos can share a basename (a clone in two places). Where they do, the
 * parent directory is added so the rows are not indistinguishable.
 */
function labeller(projects: { key: string; label: string }[]): (p: { key: string; label: string }) => string {
  const seen = new Map<string, number>();
  for (const p of projects) seen.set(p.label, (seen.get(p.label) ?? 0) + 1);
  return (p) => ((seen.get(p.label) ?? 0) > 1 && !p.key.startsWith("(") ? p.key.split("/").slice(-2).join("/") : p.label);
}

/**
 * Tokens for a project with sessions and no ingested request at all: the
 * transcripts were gone before ingest ever read them. The rollup stores 0;
 * printed bare, that 0 would claim the sessions used no tokens.
 */
function tokenCell(p: ProjectSummary, n: number): SortCell {
  if (p.sessions > 0 && totalTokens(p) === 0) return { html: `<span class="absent" title="no transcript left to read">—</span>`, sort: null };
  return { html: compact(n), sort: n };
}

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;

/**
 * The hero: the project with the most active hours in range. With none, it
 * says so in words -- never a hero 0 (Review Focus 2).
 */
function heroCard(d: ProjectsData): string {
  const top = d.projects[0];
  const title = `Top project · ${rangeLabel(d.range)}`;
  if (top === undefined || !(top.activeHours > 0)) {
    return card({
      title,
      hero: true,
      body: `<div class="big absent">—</div><div class="muted label">no active time ${within(d.range)}</div>`,
    });
  }
  const all = d.projects.reduce((a, p) => a + p.activeHours, 0);
  const label = labeller(d.projects)(top);
  const hrs = num(top.activeHours, 1);
  const facts = [
    kv("share of active hours", `<b>${num((100 * top.activeHours) / all, 1)}%</b>`),
    kv("sessions", `<b>${grouped(top.sessions)}</b>`),
    kv(`cost · ${API_PRICES}`, apiCostBold(top.apiCost)),
    kv(`cost · ${CC_FIGURE}`, claudeCodeCostBold(top.costUsd)),
    kv(`$ / active hour · ${CC_FIGURE}`, top.costPerActiveHour === null ? `<b class="absent">${NO_READING}</b>` : `<b>${usd(top.costPerActiveHour)}</b>`),
    kv("output tokens", tokenCell(top, top.tokensOut).sort === null ? `<b class="absent">—</b>` : `<b>${compact(top.tokensOut)}</b>`),
  ].join("");
  return card({
    title,
    hero: true,
    body:
      `<div class="hero-name" title="${esc(top.key)}">${esc(label)}</div>` +
      `<div class="big"${Number.isFinite(top.activeHours) ? ` data-count="${hrs}"` : ""}>${hrs}<span class="unit">h</span></div>` +
      `<div class="muted label">active hours</div><div class="block">${facts}</div>`,
  });
}

const RANKED_COLUMNS = [
  { key: "rank", label: "#", num: true },
  { key: "project", label: "project" },
  { key: "trend", label: "by day" },
  { key: "active", label: "active", num: true },
  { key: "sessions", label: "sessions", num: true },
  { key: "api", label: API_PRICES, num: true },
  { key: "cost", label: CC_FIGURE, num: true },
  { key: "rate", label: "$ / active h", num: true },
  { key: "out", label: "output tok", num: true },
  { key: "all", label: "all tok", num: true },
  { key: "lines", label: "lines", num: true },
];

function rankedSection(d: ProjectsData, served: boolean): string {
  const title = `Projects · ranked by active hours · ${rangeLabel(d.range)}`;
  if (d.projects.length === 0) {
    return card({
      title,
      wide: true,
      body: `<div class="chart-empty"><div class="empty-msg">no project activity ${within(d.range)}</div></div>`,
    });
  }
  const label = labeller(d.projects);
  // Past 90 days (`all`), one sparkline point a week: the week's hours summed.
  const b = buckets(eachDay(d.recentFrom, d.today));
  const at = new Map(eachDay(d.recentFrom, d.today).map((day, i) => [day, i]));
  const trend = (p: ProjectSummary) =>
    b.weekly ? b.buckets.map((k) => k.days.reduce((a, day) => a + (p.recent[at.get(day) ?? -1] ?? 0), 0)) : p.recent;
  const rows = d.projects.map((p, i) => {
    const name = esc(label(p));
    return {
      cells: {
        rank: { html: String(i + 1), sort: i + 1 },
        project: {
          html: served
            ? `<a href="${esc(sessionsHref(d.range, p.key))}" title="${esc(p.key)} · its sessions">${name}</a>`
            : `<span title="${esc(p.key)}">${name}</span>`,
          sort: label(p),
        },
        trend: {
          html: sparkline({ values: trend(p), label: `${p.label}: active hours per ${b.weekly ? "week" : "day"}, ${rangeLabel(d.range)}` }),
          sort: p.activeHours,
        },
        active: { html: hours(p.activeHours), sort: p.activeHours },
        sessions: { html: grouped(p.sessions), sort: p.sessions },
        api: apiCostCell(p.apiCost),
        cost: claudeCodeCostCell(p.costUsd),
        rate:
          p.costPerActiveHour === null
            ? p.activeHours > 0 && p.costUsd === null
              ? { html: `<span class="absent" title="no status-line cost reading">${NO_READING}</span>`, sort: null }
              : { html: `<span class="absent" title="no active time">—</span>`, sort: null }
            : { html: usd(p.costPerActiveHour), sort: p.costPerActiveHour },
        out: tokenCell(p, p.tokensOut),
        all: tokenCell(p, totalTokens(p)),
        lines: linesCell(p),
      } satisfies Record<string, SortCell>,
    };
  });
  return card({
    title,
    wide: true,
    body:
      sortableTable(RANKED_COLUMNS, rows) +
      `<p class="note">Hours, sessions and cost as the rollup attributes them: a session belongs whole to the project it spent most active time in. ` +
      `Cost ${esc(API_PRICES)} is the rollup's price of the requests; ${esc(CC_FIGURE)} is the status line's, and $ / active h divides it by active hours. ` +
      `Tokens attribute per request, by the directory each request ran in. ` +
      `Lines are the status line's running totals, the highest reading per session (${grouped(d.sessionsWithLines)} ${d.sessionsWithLines === 1 ? "session" : "sessions"} reported one), ` +
      `booked to the project and range of the session's last reading. ` +
      `A dash under tokens is a project whose sessions have no transcript left to read, not one that used none. Excluded paths are not shown.` +
      `${served ? " A project's name opens its sessions." : ""}</p>`,
  });
}

function recentSection(d: ProjectsData): string {
  const label = labeller(d.recentShare);
  const top = d.recentShare.slice(0, DONUT_SLICES);
  const rest = d.recentShare.slice(DONUT_SLICES).reduce((a, p) => a + p.activeHours, 0);
  const slices = [
    // `(unfiled)` is a non-answer, like "unknown": drawn neutral (M11).
    ...top.map((p) => ({ label: label(p), value: p.activeHours, other: p.key === "(unfiled)" })),
    ...(rest > 0 ? [{ label: `${d.recentShare.length - DONUT_SLICES} others`, value: rest, other: true }] : []),
  ];
  return card({
    title: `Where the time went · ${rangeLabel(d.range)}`,
    body: donut({
      slices,
      label: `active hours by project since ${d.recentFrom}`,
      format: hours,
      emptyText: `no active time ${within(d.range)}`,
    }),
  });
}

/** Sessions per terminal: a session count, with NULL shown as "unknown". */
function terminalSection(d: ProjectsData): string {
  const top = d.terminals.slice(0, DONUT_SLICES);
  const rest = d.terminals.slice(DONUT_SLICES).reduce((a, t) => a + t.sessions, 0);
  const slices = [
    // "unknown" is a session that recorded no terminal: a non-answer, drawn neutral.
    ...top.map((t) => ({ label: t.terminal, value: t.sessions, other: t.terminal === "unknown" })),
    ...(rest > 0 ? [{ label: `${d.terminals.length - DONUT_SLICES} others`, value: rest, other: true }] : []),
  ];
  return card({
    title: `Terminals · ${rangeLabel(d.range)}`,
    body: donut({
      slices,
      label: `sessions started, by terminal · "unknown" is a session that recorded none`,
      format: (n) => `${grouped(n)} ${n === 1 ? "session" : "sessions"}`,
      emptyText: `no sessions started ${within(d.range)}`,
    }),
  });
}

function branchRow(b: BranchRow): string {
  return (
    `<tr><td title="${esc(b.projectKey)}">${esc(b.projectLabel)}</td>` +
    `<td${b.branch === "(no branch)" ? ` class="absent"` : ""}>${esc(b.branch)}</td>` +
    `<td class="num">${grouped(b.requests)}</td>` +
    `<td class="num">${compact(b.tokensIn)}</td>` +
    `<td class="num">${compact(b.tokensOut)}</td>` +
    `<td class="num">${compact(b.tokensCacheRead)}</td>` +
    `<td class="num">${compact(b.tokensCacheCreation)}</td>` +
    `<td class="num">${compact(totalTokens(b))}</td></tr>`
  );
}

function branchSection(d: ProjectsData): string {
  const title = `Tokens by branch · ${rangeLabel(d.range)}`;
  if (d.branches.length === 0) {
    return card({
      title,
      wide: true,
      body: `<div class="chart-empty"><div class="empty-msg">no requests ${within(d.range)}</div></div>`,
    });
  }
  const shown = d.branches.slice(0, BRANCH_ROWS);
  const more = d.branches.length - shown.length;
  return card({
    title,
    wide: true,
    body:
      `<div class="scroll"><table class="branches"><thead><tr><th>project</th><th>branch</th><th class="num">requests</th>` +
      `<th class="num">fresh in</th><th class="num">output</th><th class="num">cache read</th><th class="num">cache write</th><th class="num">all</th>` +
      `</tr></thead><tbody>${shown.map(branchRow).join("")}</tbody></table></div>` +
      `<p class="note">Each request's own directory and branch, read off every ingested request, including those from before the hooks were installed. ` +
      `${more > 0 ? `${more} smaller ${more === 1 ? "branch" : "branches"} not shown.` : ""}</p>`,
  });
}

export function renderProjectsBody(d: ProjectsData, opts: { served?: boolean } = {}): string {
  return [
    `<div class="g g-mid">`, heroCard(d), recentSection(d), terminalSection(d), `</div>`,
    rankedSection(d, opts.served === true),
    branchSection(d),
  ].join("");
}

export function projectsView(d: ProjectsData, opts: { served?: boolean; tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  return {
    href: "/projects",
    title: "Projects",
    body: renderProjectsBody(d, opts),
    footer:
      // Dated, not just timed: a rollup four days old must not read as today's.
      `generated ${stamp(d.generatedAt, tz)} · days and times are local, ${zoneNote(tz, d.generatedAt)}, as the rollup buckets them · ` +
      `rollup ${d.lastRollup === null ? "never" : stamp(d.lastRollup, tz)}`,
  };
}

export function renderProjectsPage(d: ProjectsData, opts: { served?: boolean; tz?: string } = {}): string {
  return viewPage(projectsView(d, opts));
}
