/**
 * The Character page (Stage 6, spec §5): an OSRS-style skills tab. Every tool
 * is a skill, its projects and models are sub-skills, and the page shows pace,
 * streaks and the level-up log. It labels what the rollup stored. Its only
 * arithmetic is a meter's percent (level.ts) and seconds shown as hours (or,
 * under an hour, as minutes and seconds).
 * Stage 7 adds Skill use: a tile outside the Total level and a section after
 * Claude's, with its packs and skills.
 */
import {
  LEVEL_UP_CAP, SKILL_USE_LABEL, labelOf, type CharacterData, type LevelUp, type Pace, type Skill, type SkillUse, type ToolCharacter,
} from "../read/character.ts";
import { AGENT_LABEL, type AgentSource, type CapRaise, type Level } from "../read/level.ts";
import { attributesCard } from "./attributes.ts";
import { sortableTable, type SortCell, type SortColumn } from "./charts.ts";
import {
  AT_PACE, EXCLUDED_HIDDEN, LEVEL_PENDING, LEVEL_PENDING_WHY_V8, LEVEL_PENDING_WHY_V9, NO_DRIVEN_HOURS, NO_LEVEL_UPS, NO_PACE, NO_SKILL_TIME,
  SKILL_USE_COUNTED, SKILL_USE_NOT_IN_TOTAL, noSkillRows, noSubSkills,
} from "./empty.ts";
import { duration, esc, grouped, localZone, num, stamp } from "./html.ts";
import { card, type View } from "./layout.ts";
import { formatXp, levelBlock, meter } from "./level.ts";
import { REPORT_ROWS } from "./sessions.ts";

/** The report lists this many level-ups; served, the reader's LEVEL_UP_CAP. */
export const REPORT_LEVEL_UPS = 30;

/** A tool's section: the same id served and in the report, which stacks every view in one file. */
export const characterAnchor = (s: AgentSource): string => `character-${s}`;
/** Where an Overview level card links: the route when served, the in-file anchor in the report (R11). */
export const characterHref = (s: AgentSource, served: boolean): string =>
  `${served ? "/character" : ""}#${characterAnchor(s)}`;

/** Stage 7: Skill use's section, the same id served and in the report. */
export const SKILL_USE_ANCHOR = "character-skill-use";

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;
const DASH = `<span class="absent">—</span>`;
const days = (n: number) => `${grouped(n)} ${n === 1 ? "day" : "days"}`;
/** R10: a window with no XP is "none", never "0 XP". */
const gain = (xp: number) => (xp > 0 ? `<b>+${esc(formatXp(xp))} XP</b>` : absent("none"));
const perDay = (p: number) => `${p >= 100 ? grouped(Math.floor(p)) : num(p, 1)} XP a day`;
const paceKv = (p: Pace) => kv("pace · 28 days", p.xp28d > 0 ? `<b>${perDay(p.perDay)}</b>` : absent(NO_PACE));
const streak = (p: Pace) =>
  p.streakBest > 0 ? `<b>${days(p.streakCurrent)} · best ${days(p.streakBest)}</b>` : absent("none");
const atPace = `<span class="muted"> ${esc(AT_PACE)}</span>`;

function characterCard(d: CharacterData): string {
  const total = d.totalLevel === null ? `<div class="big absent">—</div>` : `<div class="big">${d.totalLevel}</div>`;
  const a = d.all;
  const facts = a === null ? "" : [
    kv("XP today", gain(a.xpToday)), kv("XP · 7 days", gain(a.xp7d)), paceKv(a), kv("streak", streak(a)),
  ].join("");
  const capKv = d.cap === null ? "" : kv("level cap", `<b>${d.cap}</b>`);
  return card({ title: "Character", hero: true, body: total + `<div class="muted label">total level</div><div class="block">${capKv}${facts}</div>` });
}

function tileOf(label: string, anchor: string, l: Level): string {
  const stars = l.stars > 0
    ? ` <span class="stars" aria-label="${l.stars} ${l.stars === 1 ? "star" : "stars"} past 200">★×${l.stars}</span>` : "";
  return `<a class="c tile" href="#${anchor}"><h2>${esc(label)}</h2>` +
    `<div class="big lv">Lv ${l.level}${l.cap == null ? "" : `<span class="muted">/${l.cap}</span>`}</div>` +
    `<div class="muted label">${esc(l.tier)}${stars}</div>${meter(l)}</a>`;
}

function tile(t: ToolCharacter): string {
  return t.state.state === "level" ? tileOf(t.label, characterAnchor(t.source), t.state.level) : "";
}

function skillsCard(d: CharacterData): string {
  // Stage 7: Skill use's tile sits after the tools; its time is already in
  // Claude's level, so it stays out of the Total and the footer says so.
  const use = d.skillUse.level;
  const tiles = d.tools.map(tile).join("") + (use === null ? "" : tileOf(SKILL_USE_LABEL, SKILL_USE_ANCHOR, use));
  const grid = tiles === "" ? `<div class="state absent">${esc(NO_DRIVEN_HOURS)}</div>` : `<div class="g g-tiles">${tiles}</div>`;
  const foot = kv("Total level", d.totalLevel === null ? absent("—") : `<b>${d.totalLevel}</b>`) +
    (d.points === null ? "" : kv("Quest Points", `<b>${grouped(d.points.qp)}</b>`) + kv("Achievement Points", `<b>${grouped(d.points.ap)}</b>`));
  const note = use === null ? "" : `<p class="note">${esc(SKILL_USE_NOT_IN_TOTAL)}</p>`;
  return card({ title: "Skills", wide: true, body: grid + `<div class="block">${foot}${note}</div>` });
}

function paceBlock(p: Pace | null, cap: number | null): string {
  if (p === null) return "";
  return [
    kv("XP today", gain(p.xpToday)), kv("XP · 7 days", gain(p.xp7d)), kv("XP · 28 days", gain(p.xp28d)),
    paceKv(p),
    p.etaNextDays === null ? "" : kv("next level", `<b>in ${days(p.etaNextDays)}</b>${atPace}`),
    cap !== null && p.dateCap !== null ? kv(`Lv ${cap}`, `<b>by ${esc(p.dateCap)}</b>${atPace}`)
      : p.date99 === null ? "" : kv("99", `<b>by ${esc(p.date99)}</b>${atPace}`),
    kv("streak", streak(p)),
  ].join("");
}

const COLS: SortColumn[] = [
  { key: "skill", label: "Skill" }, { key: "lv", label: "Lv", num: true }, { key: "tier", label: "Tier" },
  { key: "xp", label: "XP", num: true }, { key: "next", label: "XP to next", num: true },
  { key: "hours", label: "Hours", num: true }, { key: "first", label: "First" }, { key: "last", label: "Last" },
];

/** Stored seconds as hours, or under an hour as minutes and seconds: a 58 s skill at Lv 2 never reads "0.0h". */
const hours = (s: number) => (s < 3600 ? duration(s) : `${num(s / 3600, 1)}h`);

type Row = { cells: Record<string, SortCell> };

function skillRow(s: Skill): Row {
  const l = s.level;
  return {
    cells: {
      skill: { html: esc(s.label), sort: s.label },
      lv: { html: String(l.level), sort: l.level },
      tier: { html: esc(l.tier), sort: l.level },
      xp: { html: esc(formatXp(l.xp)), sort: l.xp },
      next: l.xpToNext === null ? { html: DASH, sort: null } : { html: esc(formatXp(l.xpToNext)), sort: l.xpToNext },
      hours: { html: hours(l.activeS), sort: l.activeS },
      first: { html: esc(s.firstDay), sort: s.firstDay },
      last: { html: esc(s.lastDay), sort: s.lastDay },
    },
  };
}

/** A sub-skill table, cut to REPORT_ROWS in the report with the usual note. */
function cutTable(title: string, cols: SortColumn[], all: Row[], what: string, empty: string, served: boolean, extra = ""): string {
  const shown = served ? all : all.slice(0, REPORT_ROWS);
  const cut = shown.length < all.length
    ? `<p class="note">This report lists the ${REPORT_ROWS} highest of ${grouped(all.length)} ${what}; serve the dashboard for all of them.</p>`
    : "";
  return card({ title, wide: true, body: sortableTable(cols, shown, { empty }) + cut + extra });
}

function skillTable(t: ToolCharacter, what: "projects" | "models", served: boolean): string {
  const all = what === "projects" ? t.projects : t.models;
  const excluded = what === "projects" && t.excludedHidden ? `<p class="note">${esc(EXCLUDED_HIDDEN)}</p>` : "";
  return cutTable(`${t.label} · ${what}`, COLS, all.map(skillRow), what, noSubSkills(what), served, excluded);
}

function toolSection(t: ToolCharacter, served: boolean, cap: number | null): string {
  // Spec §5: a tool with no driven hours is the one line, "No driven hours
  // yet." -- not a pace block of "none"s and two empty tables beneath it. A
  // tool with a level and no XP in 28 days keeps its pace block, which says so.
  if (t.state.state === "none") {
    return card({ id: characterAnchor(t.source), title: t.label, wide: true, body: levelBlock(t.state, t.source) });
  }
  return card({
    id: characterAnchor(t.source), title: t.label, wide: true,
    body: levelBlock(t.state, t.source) + `<div class="block">${paceBlock(t.pace, cap)}</div>`,
  }) + skillTable(t, "projects", served) + skillTable(t, "models", served);
}

/** The skills table's columns: a Pack column after the skill (plan R9). */
const PACK_COLS: SortColumn[] = [COLS[0], { key: "pack", label: "Pack" }, ...COLS.slice(1)];

/** Stage 7 (spec §5): Skill use's level, what it counts, its packs and its skills. No pace (decision 7). */
function skillUseSection(u: SkillUse, served: boolean): string {
  const head = (body: string) => card({ id: SKILL_USE_ANCHOR, title: SKILL_USE_LABEL, wide: true, body });
  if (u.pending) {
    return head(`<div class="state absent">${esc(LEVEL_PENDING)}</div><div class="muted">${esc(LEVEL_PENDING_WHY_V9)}</div>`);
  }
  if (u.level === null) return head(`<div class="state absent">${esc(NO_SKILL_TIME)}</div>`);
  const skills = u.skills.map((s): Row => ({ cells: { ...skillRow(s).cells, pack: { html: esc(s.pack), sort: s.pack } } }));
  return head(levelBlock({ state: "level", level: u.level }) + `<p class="note">${esc(SKILL_USE_COUNTED)}</p>`) +
    cutTable(`${SKILL_USE_LABEL} · packs`, COLS, u.packs.map(skillRow), "packs", noSkillRows("packs"), served) +
    cutTable(`${SKILL_USE_LABEL} · skills`, PACK_COLS, skills, "skills", noSkillRows("skills"), served);
}

const UP_COLS: SortColumn[] = [
  { key: "day", label: "Day" }, { key: "skill", label: "Skill" }, { key: "lv", label: "Level", num: true },
  { key: "tier", label: "Tier" },
];

const sourceLabel = (s: LevelUp["source"]): string => (s === "character" ? "Character" : AGENT_LABEL[s]);

const pathOf = (u: LevelUp) =>
  u.kind === "tool" ? sourceLabel(u.source)
    : u.kind === "attribute" ? u.label
    : u.kind === "skill-use" ? SKILL_USE_LABEL
      : `${sourceLabel(u.source)} › ${u.kind} › ${u.label}`;

/** A cap raise as the level-up it names, for pathOf's label. */
function asUp(r: CapRaise): LevelUp {
  const source = r.source as LevelUp["source"];
  const label = r.kind === "tool" ? sourceLabel(source) : labelOf(r.kind, r.key);
  return { day: r.day, source, kind: r.kind as LevelUp["kind"], key: r.key, label, level: r.reachedLevel, tier: "", tierChanged: false };
}

type LogRow = { day: string; cells: Record<string, SortCell> };

function levelUpsCard(d: CharacterData, served: boolean): string {
  const raises: LogRow[] = d.capRaises.map((r) => {
    const text = `Level cap raised to ${r.cap} · ${pathOf(asUp(r))} reached Lv ${r.reachedLevel}`;
    return {
      day: r.day,
      cells: {
        day: { html: esc(r.day), sort: r.day }, skill: { html: esc(text), sort: text },
        lv: { html: "", sort: null }, tier: { html: "", sort: null },
      },
    };
  });
  const ups: LogRow[] = d.levelUps.map((u) => ({
    day: u.day,
    cells: {
      day: { html: esc(u.day), sort: u.day },
      skill: { html: esc(pathOf(u)), sort: pathOf(u) },
      lv: { html: `Lv ${u.level}`, sort: u.level },
      tier: u.tierChanged ? { html: `→ ${esc(u.tier)}`, sort: u.level } : { html: "", sort: null },
    } as Record<string, SortCell>,
  }));
  // Both lists arrive newest first. Merge, never re-sort: a cap raise leads the level-ups of its day.
  const all: LogRow[] = [];
  let i = 0;
  for (const u of ups) {
    while (i < raises.length && raises[i].day >= u.day) all.push(raises[i++]);
    all.push(u);
  }
  all.push(...raises.slice(i));
  const total = d.levelUpCount + d.capRaises.length;
  const shown = served ? all.slice(0, LEVEL_UP_CAP) : all.slice(0, REPORT_LEVEL_UPS);
  const note = shown.length >= total ? ""
    : served
      ? `<p class="note">Showing the ${grouped(shown.length)} newest of ${grouped(total)} entries.</p>`
      : `<p class="note">This report lists the ${grouped(shown.length)} newest of ${grouped(total)} entries; serve the dashboard for up to ${grouped(LEVEL_UP_CAP)}.</p>`;
  const rows = shown.map((x) => ({ cells: x.cells }));
  return card({ title: "Level-ups", wide: true, body: sortableTable(UP_COLS, rows, { empty: NO_LEVEL_UPS }) + note });
}

export function characterView(d: CharacterData, opts: { served?: boolean; tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const served = opts.served === true;
  const body = d.pending
    ? card({ title: "Character", body: `<div class="state absent">${esc(LEVEL_PENDING)}</div><div class="muted">${esc(LEVEL_PENDING_WHY_V8)}</div>` })
    : characterCard(d) + attributesCard(d.attributes, d.cap, served) + skillsCard(d) +
      d.tools.map((t) => toolSection(t, served, d.cap) + (t.source === "claude" ? skillUseSection(d.skillUse, served) : "")).join("") +
      levelUpsCard(d, served);
  return {
    href: "/character",
    title: "Character",
    body,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · levels are lifetime; pace and streaks as of ${d.all?.asOfDay ?? "—"}, local days · ` +
      `from skill_progress, skill_pace, skill_level_ups, claude_skill_packs, agent_progress, character_attributes and level_caps · hours count driven sessions only`,
  };
}
