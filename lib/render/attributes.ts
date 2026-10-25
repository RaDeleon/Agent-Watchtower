/**
 * The Attributes card (Stage 10, spec §5): six tiles, Now over Base with the
 * stored boost, the tier and XP meter, both Forms and their sources. It labels
 * what character_attributes, skill_progress and claude_quests store; it
 * computes no Form, boost or level. NULL reads "no reading", never 0.
 */
import { ATTRIBUTE_NAMES, type Attribute, type AttributesData } from "../read/attributes.ts";
import { ATTRIBUTES_PENDING, NO_ATTRIBUTE_XP, NO_READING, STR_SOURCE } from "./empty.ts";
import { esc, grouped } from "./html.ts";
import { card } from "./layout.ts";
import { meter } from "./level.ts";
import { disciplineLabel } from "./profile.ts";

const reading = (n: number | null) => (n === null ? NO_READING : String(n));
const link = (href: string, text: string, served: boolean) =>
  served ? `<a href="${href}">${esc(text)}</a>` : esc(text);

function nowBase(a: Attribute): string {
  if (a.now === null || a.base === null) return `<div class="state absent">${esc(NO_ATTRIBUTE_XP)}</div>`;
  if (a.boost === null || a.boost === 0) return `<div class="big lv">${a.base}</div>`;
  const arrow = a.boost > 0 ? `<span class="boost">▲${a.boost}</span>` : `<span class="drain">▼${-a.boost}</span>`;
  return `<div class="big lv">${a.now}<span class="muted">/${a.base}</span> ${arrow}</div>`;
}

function sources(a: Attribute, served: boolean): string {
  if (a.id === "str") {
    const r = a.evidence.per_hour_30;
    return `${esc(STR_SOURCE)} · ${r == null ? esc(NO_READING) : grouped(r)}`;
  }
  return Object.entries(a.evidence)
    .map(([d, s]) => `${link("/profile", disciplineLabel(d), served)} ${s === null ? esc(NO_READING) : s}`)
    .join(" · ");
}

function tile(a: Attribute, served: boolean): string {
  const n = ATTRIBUTE_NAMES[a.id];
  const lvl = a.level === null ? "" : `<div class="muted label">${esc(a.level.tier)}</div>${meter(a.level)}`;
  return `<div class="c tile"><h2>${esc(`${n.abbr} ${n.name}`)}</h2>${nowBase(a)}${lvl}` +
    `<div class="muted block">form ${esc(reading(a.form7))} · ${esc(reading(a.form30))} (7d · 30d)</div>` +
    `<div class="muted">${sources(a, served)}</div></div>`;
}

export function attributesCard(d: AttributesData, cap: number | null, served: boolean): string {
  const title = cap === null ? "Attributes" : `Attributes · level cap ${cap}`;
  if (d.pending) return card({ title, wide: true, body: `<div class="state absent">${esc(ATTRIBUTES_PENDING)}</div>` });
  const foot = d.lowest === null ? "" : `<p class="note">Lowest form: ${esc(ATTRIBUTE_NAMES[d.lowest.id].name)}` +
    (d.lowest.quests.length === 0 ? "" : ` · this week: ${d.lowest.quests.map((q) => link("/quests", q.name, served)).join(", ")}`) +
    `</p>`;
  return card({ title, wide: true, body: `<div class="g g-tiles">${d.attributes.map((a) => tile(a, served)).join("")}</div>${foot}` });
}
