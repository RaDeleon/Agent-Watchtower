/**
 * The level card (spec §5): one component for Claude Code, Codex and Hermes,
 * on History, Live, the Overview and the agent pages. Shows the stored level,
 * tier, XP in OSRS style, a meter to the next level and the hours left, or
 * stars past the top. Display arithmetic only: a meter's percent from two
 * stored columns, and stored seconds shown as hours.
 */
import type { Level, LevelState } from "../read/level.ts";
import { LEVEL_PENDING, LEVEL_PENDING_WHY_AGENT, LEVEL_PENDING_WHY_CLAUDE, NO_DRIVEN_HOURS } from "./empty.ts";
import { esc, grouped, num } from "./html.ts";
import { card } from "./layout.ts";

/** OSRS-style XP: "1.52M", "23.7K", "477". Floored, so a figure never rounds up past what was earned. */
export function formatXp(xp: number): string {
  if (xp >= 1e6) return `${(Math.floor(xp / 1e4) / 100).toFixed(2)}M`;
  if (xp >= 1e4) return `${(Math.floor(xp / 100) / 10).toFixed(1)}K`;
  return grouped(xp);
}

export function meter(l: Level): string {
  const span = l.xpToNext === null ? null : l.xpIntoLevel + l.xpToNext;
  const pct = span === null ? 100 : span > 0 ? (100 * l.xpIntoLevel) / span : 0;
  return `<div class="meter" role="progressbar" aria-label="XP through this level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${num(pct, 0)}"><i style="width:${num(pct, 1)}%"></i></div>`;
}

function next(l: Level): string {
  if (l.xpToNext !== null && l.sToNext !== null) {
    return `<div class="muted block">${esc(formatXp(l.xp))} XP · ${num(l.sToNext / 3600, 1)}h to Lv ${l.level + 1}</div>`;
  }
  const stars = l.stars > 0
    ? ` · <span class="stars" aria-label="${l.stars} ${l.stars === 1 ? "star" : "stars"} past 200">${"★".repeat(Math.min(l.stars, 10))}${l.stars > 10 ? ` ×${l.stars}` : ""}</span>`
    : "";
  return `<div class="muted block">${esc(formatXp(l.xp))} XP${stars}</div>`;
}

/** The level, or the reason there is none -- never "Lv 1" or "0 XP" for nothing. */
export function levelBlock(s: LevelState, source?: "claude" | "codex" | "hermes"): string {
  if (s.state === "pending") {
    return `<div class="state absent">${esc(LEVEL_PENDING)}</div><div class="muted">${esc(source === "claude" ? LEVEL_PENDING_WHY_CLAUDE : LEVEL_PENDING_WHY_AGENT)}</div>`;
  }
  if (s.state === "none") return `<div class="state absent">${esc(NO_DRIVEN_HOURS)}</div>`;
  const l = s.level;
  return `<div class="big lv">Lv ${l.level}${l.cap == null ? "" : `<span class="muted">/${l.cap}</span>`}</div><div class="muted label">${esc(l.tier)}</div>` + meter(l) + next(l);
}

export function levelCard(opts: { title: string; state: LevelState; hero?: boolean; source?: "claude" | "codex" | "hermes" }): string {
  return card({ title: opts.title, body: levelBlock(opts.state, opts.source), hero: opts.hero });
}
