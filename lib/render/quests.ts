/**
 * The Quests page (Stage 8, spec §5): this week's quests, Quest and
 * Achievement Points, achievements by tier and the quest log. It labels what
 * the rollup stored; its only arithmetic is a share shown as a percent and
 * tokens shown in thousands.
 */
import type { Achievement, Quest, QuestUnit, QuestWeek, QuestsData } from "../read/quests.ts";
import { sortableTable, type SortCell, type SortColumn } from "./charts.ts";
import {
  ACHIEVEMENTS_PENDING, NO_CLOSED_WEEKS, NO_QUESTS_THIS_WEEK, NO_QUESTS_YET, NO_READING, NO_UNLOCKS,
  QUESTS_PENDING, UNDER_20_SO_FAR,
} from "./empty.ts";
import { compact, esc, grouped, localZone, num, stamp } from "./html.ts";
import { card, type View } from "./layout.ts";
import { REPORT_ROWS } from "./sessions.ts";

/**
 * The profile's 20-request gate. It only picks which absent label an open
 * week's missing value gets; no number is derived from it.
 */
const GATE_REQUESTS = 20;

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;

/** A stored quest number in its unit. Values are stored at the precision shown here. */
export function questNumber(unit: QuestUnit, v: number): string {
  switch (unit) {
    case "share": return `${num(v * 100, 1)}%`;
    case "tokens": return `${grouped(v / 1000)}k`;
    case "ratio":
    case "count": return grouped(v);
  }
}

const op = (q: Quest) => (q.direction === "at-least" ? "≥" : "≤");

/** "≥ 6.1% (last week 4.1%)", or "hold ≥ 50.0%" at full marks. */
export function targetText(q: Quest): string {
  const t = `${op(q)} ${questNumber(q.unit, q.target)}`;
  return q.hold ? `hold ${t}` : `${t} (last week ${questNumber(q.unit, q.baseline)})`;
}

function valueHtml(q: Quest): string {
  if (q.value !== null) return `<b>${esc(questNumber(q.unit, q.value))}</b>`;
  return absent(q.status === "open" && q.requests < GATE_REQUESTS ? UNDER_20_SO_FAR : NO_READING);
}

const statusHtml = (q: Quest) =>
  q.status === "done" ? `<b>done</b>` : absent(q.status);

function questTile(q: Quest): string {
  return `<div class="c tile"><h2>${esc(q.name)}</h2><div class="muted label">${esc(q.discipline)} · ${esc(q.measure)}</div>` +
    `<div class="block">${kv("target", `<b>${esc(targetText(q))}</b>`)}${kv("this week", valueHtml(q))}` +
    `${kv("status", statusHtml(q))}</div></div>`;
}

function thisWeekCard(d: QuestsData): string {
  const w = d.thisWeek;
  if (w === null) {
    return card({ title: "This week", wide: true, body: `<div class="state absent">${esc(d.anyQuests ? NO_QUESTS_THIS_WEEK : NO_QUESTS_YET)}</div>` });
  }
  return card({
    title: `This week · ${w.week} – ${w.weekEnd}`, wide: true,
    body: `<div class="g g-tiles">${w.quests.map(questTile).join("")}</div>`,
  });
}

function pointsCard(d: QuestsData): string {
  const big = (n: number, label: string) =>
    `<div class="c tile"><div class="value">${grouped(n)}</div><div class="muted label">${esc(label)}</div></div>`;
  return card({
    title: "Points", wide: true,
    body: `<div class="g g-tiles">${big(d.qp, "Quest Points")}${big(d.ap, "Achievement Points")}</div>`,
  });
}

/** An achievement's value or threshold in its unit. */
function achievementNumber(a: Achievement, v: number): string {
  return a.unit === "level" ? `Lv ${v}` : a.unit === "tokens" ? compact(v) : grouped(v);
}

const ACH_COLS: SortColumn[] = [
  { key: "name", label: "Achievement" }, { key: "tool", label: "Tool" }, { key: "value", label: "Now", num: true },
  { key: "t1", label: "Bronze" }, { key: "t2", label: "Silver" }, { key: "t3", label: "Gold" }, { key: "t4", label: "Platinum" },
];

function achievementRow(a: Achievement): { cells: Record<string, SortCell> } {
  const next = a.tiers.find((t) => t.unlockedDay === null);
  const cells: Record<string, SortCell> = {
    name: { html: esc(a.name), sort: a.name },
    tool: { html: esc(a.tool), sort: a.tool },
    value: a.value === null ? { html: `<span class="absent">—</span>`, sort: null } : { html: esc(achievementNumber(a, a.value)), sort: a.value },
  };
  for (const t of a.tiers) {
    const th = achievementNumber(a, t.threshold);
    cells[`t${t.tier}`] = t.unlockedDay !== null
      ? { html: `<b>${esc(t.unlockedDay)}</b>`, sort: t.unlockedDay }
      : t === next && a.value !== null
        ? { html: `<span class="absent">${esc(`${achievementNumber(a, a.value)} / ${th} to ${t.name}`)}</span>`, sort: null }
        : { html: `<span class="absent">${esc(th)}</span>`, sort: null };
  }
  return { cells };
}

const GROUPS: Array<[Achievement["group"], string]> = [
  ["tools", "Achievements · every tool"], ["skills", "Achievements · Claude Code skills"], ["habits", "Achievements · habits"],
];

function recentCard(d: QuestsData): string {
  const rows = d.recent.map((u) =>
    `<div class="kv"><span>${esc(u.day)}</span><b>${esc(`${u.name} · ${u.tool} · ${u.tierName}`)}</b></div>`).join("");
  return card({ title: "Recent unlocks", wide: true, body: rows === "" ? `<div class="state absent">${esc(NO_UNLOCKS)}</div>` : rows });
}

function achievementCards(d: QuestsData): string {
  return recentCard(d) + GROUPS.map(([g, title]) =>
    card({ title, wide: true, body: sortableTable(ACH_COLS, d.achievements.filter((a) => a.group === g).map(achievementRow), { empty: NO_UNLOCKS }) }),
  ).join("");
}

const LOG_COLS: SortColumn[] = [
  { key: "week", label: "Week" }, { key: "quests", label: "Quests" }, { key: "qp", label: "QP", num: true },
];

function logCard(d: QuestsData, served: boolean): string {
  const shown = served ? d.log : d.log.slice(0, REPORT_ROWS);
  const cut = shown.length < d.log.length
    ? `<p class="note">This report lists the ${REPORT_ROWS} newest of ${grouped(d.log.length)} weeks; serve the dashboard for all of them.</p>`
    : "";
  const rows = shown.map((w: QuestWeek) => ({
    cells: {
      week: { html: esc(`${w.week} – ${w.weekEnd}`), sort: w.week },
      quests: { html: w.quests.map((q) => `${esc(q.name)} <span class="muted">${esc(q.status)}</span>`).join(" · "), sort: null },
      qp: { html: grouped(w.qp), sort: w.qp },
    } as Record<string, SortCell>,
  }));
  return card({ title: "Quest log", wide: true, body: sortableTable(LOG_COLS, rows, { empty: NO_CLOSED_WEEKS }) + cut });
}

export function questsView(d: QuestsData, opts: { served?: boolean; tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const served = opts.served === true;
  const body = d.pending
    ? card({ title: "Quests", body: `<div class="state absent">${esc(QUESTS_PENDING)}</div>` }) +
      card({ title: "Achievements", body: `<div class="state absent">${esc(ACHIEVEMENTS_PENDING)}</div>` })
    : thisWeekCard(d) + pointsCard(d) + achievementCards(d) + logCard(d, served);
  return {
    href: "/quests",
    title: "Quests",
    body,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · a week runs Monday to Sunday, local; quests are Claude Code's · ` +
      `from claude_quests, achievement_tiers and character_points`,
  };
}
