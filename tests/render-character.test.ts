import { describe, expect, it } from "vitest";
import type { CharacterData, LevelUp, Pace, Skill, SkillUse, ToolCharacter } from "@/lib/read/character";
import type { Level } from "@/lib/read/level";
import { characterHref, characterView, REPORT_LEVEL_UPS } from "@/lib/render/character";
import { TOOLS, page } from "@/lib/render/layout";
import { REPORT_ROWS } from "@/lib/render/sessions";

// Stage 6, Task 4. The page labels stored values; these feed it data directly.

const lv = (over: Partial<Level> = {}): Level => ({
  source: "codex", activeS: 149400, xp: 216370, level: 57, tier: "Intermediate",
  xpIntoLevel: 13116, xpToNext: 8096, sToNext: 5590, stars: 0, cap: 99, ...over,
});
const pace = (over: Partial<Pace> = {}): Pace => ({
  asOfDay: "2026-09-30", xpToday: 144, xp7d: 1200, xp28d: 434, perDay: 15.5,
  etaNextDays: 15, eta99Days: 840810, date99: "4328-06-11", etaCapDays: 840810, dateCap: "4328-06-11", streakCurrent: 3, streakBest: 9, ...over,
});
const skill = (key: string, over: Partial<Level> = {}): Skill =>
  ({ key, label: key, level: lv(over), firstDay: "2026-08-01", lastDay: "2026-09-30" });
const tool = (over: Partial<ToolCharacter> = {}): ToolCharacter => ({
  source: "codex", label: "Codex", state: { state: "level", level: lv() }, pace: pace(),
  projects: [skill("TheOneOS")], excludedHidden: false, models: [skill("gpt-5.5")], ...over,
});
const up = (i: number, over: Partial<LevelUp> = {}): LevelUp => ({
  day: `2026-09-${String(30 - (i % 28)).padStart(2, "0")}`, source: "codex", kind: "project", key: `k${String(i).padStart(2, "0")}`,
  label: `k${String(i).padStart(2, "0")}`, level: 12, tier: "Apprentice", tierChanged: false, ...over,
});
const data = (over: Partial<CharacterData> = {}): CharacterData => ({
  generatedAt: 1790766000, pending: false, tools: [tool()], totalLevel: 57, all: pace(), levelUps: [up(0)], levelUpCount: 1,
  skillUse: { pending: false, level: null, packs: [], skills: [] }, points: null,
  cap: 99, capRaises: [], attributes: { pending: true, asOfDay: null, attributes: [], lowest: null }, ...over,
});
const html = (d: CharacterData, served = true) => characterView(d, { served, tz: "UTC" }).body;
/** A pace row with nothing in any window: skill_pace has one for every registered tool. */
const idle = (): Pace => pace({
  xpToday: 0, xp7d: 0, xp28d: 0, perDay: 0, etaNextDays: null, eta99Days: null, date99: null, etaCapDays: null, dateCap: null, streakCurrent: 0, streakBest: 0,
});
/** A registered tool with no driven seconds: agent_progress's level-less row. */
const noHours = (): ToolCharacter => tool({
  source: "hermes", label: "Hermes", state: { state: "none", activeS: 0 }, pace: idle(), projects: [], models: [],
});
/** Skill use with a level, two packs and two skills. */
const use = (over: Partial<SkillUse> = {}): SkillUse => ({
  pending: false, level: lv({ source: "claude", level: 40, tier: "Apprentice" }),
  packs: [skill("superpowers"), skill("(no pack)")],
  skills: [{ ...skill("superpowers:brainstorming"), pack: "superpowers" }, { ...skill("health"), pack: "gstack" }],
  ...over,
});
const claudeTool = () => tool({ source: "claude", label: "Claude Code" });
/** One tool's section: its card and its two tables, up to the next tool's section or the level-up log. */
const sectionOf = (h: string, s: string): string => {
  const rest = h.slice(h.indexOf(`id="character-${s}"`) + 1);
  const ends = [rest.indexOf(`id="character-`), rest.indexOf("<h2>Level-ups</h2>")].filter((i) => i >= 0);
  return rest.slice(0, Math.min(...ends));
};

describe("characterView", () => {
  it("draws a tile per tool with a level, Lv N/99, and the Total level", () => {
    const h = html(data());
    expect(h).toContain(`Lv 57<span class="muted">/99</span>`);
    expect(html(data({ tools: [tool({ state: { state: "level", level: lv({ cap: 120 }) } })] }))).toContain(`Lv 57<span class="muted">/120</span>`);
    expect(h).toContain(`href="#character-codex"`);
    expect(h).toContain(`id="character-codex"`);
    expect(h).toContain("Total level");
  });

  // Stage 8: the two point totals sit after the Total level, outside it, once stored.
  it("shows Quest and Achievement Points after the Total level, and nothing before the v10 rollup", () => {
    const h = html(data({ points: { qp: 14, ap: 43 } }));
    expect(h).toContain(`<div class="kv"><span>Total level</span><b>57</b></div><div class="kv"><span>Quest Points</span><b>14</b></div><div class="kv"><span>Achievement Points</span><b>43</b></div>`);
    expect(html(data())).not.toContain("Quest Points");
  });

  // Review Focus 3.
  it("at 200 shows stars past 200 and no ETA", () => {
    const top = lv({ level: 200, tier: "Master", xpToNext: null, sToNext: null, stars: 2 });
    const h = html(data({ tools: [tool({ state: { state: "level", level: top }, pace: pace({ etaNextDays: null, eta99Days: null, date99: null, etaCapDays: null, dateCap: null }) })] }));
    expect(h).toContain("★×2");
    expect(h).toContain('aria-label="2 stars past 200"');
    expect(h).not.toContain("<span>next level</span>");
    expect(h).not.toContain("<span>99</span>");
  });

  // Guard 12 (R8).
  it("an attribute level-up is labelled by its name", () => {
    const h = html(data({ levelUps: [up(0, { source: "character", kind: "attribute", key: "str", label: "Strength", level: 78 })] }));
    expect(h).toContain(">Strength<");
    expect(h).not.toContain("undefined");
  });
  // Guard 14.
  it("the log shows a cap raise", () => {
    const h = html(data({ cap: 120, capRaises: [{ cap: 120, reachedLevel: 99, day: "2026-09-30", source: "claude", kind: "tool", key: "claude" }] }));
    expect(h).toContain("Level cap raised to 120 · Claude Code reached Lv 99");
  });
  // The log merges two newest-first lists; on a shared day the raise comes first.
  it("a cap raise leads the level-ups of its own day", () => {
    const h = html(data({
      levelUps: [up(0, { day: "2026-09-20", key: "same-day", label: "same-day" })], levelUpCount: 1,
      capRaises: [{ cap: 120, reachedLevel: 99, day: "2026-09-20", source: "claude", kind: "tool", key: "claude" }],
    }));
    const raise = h.indexOf("Level cap raised to 120");
    expect(raise).toBeGreaterThanOrEqual(0);
    expect(h.indexOf("Codex › project › same-day")).toBeGreaterThan(raise);
  });
  it("shows the cap on the hero card and the pace to it", () => {
    const h = html(data({ cap: 120, tools: [tool({ pace: pace({ etaCapDays: 40, dateCap: "2026-11-09" }) })] }));
    expect(h).toContain("level cap");
    expect(h).toContain("Lv 120");
    expect(h).toContain("by 2026-11-09");
  });

  it("says when the next level and 99 land, at the 28-day pace", () => {
    const h = html(data());
    expect(h).toContain("in 15 days");
    expect(h).toContain("by 4328-06-11");
    expect(h).toContain("at your 28-day pace");
    expect(h).toContain("15.5 XP a day");
  });

  // Review Focus 4.
  it("escapes every name", () => {
    const nasty = "<o'brien & co>";
    const h = html(data({
      tools: [tool({ projects: [skill(nasty)], models: [skill(nasty)] })],
      levelUps: [up(0, { label: nasty })],
    }));
    expect(h).not.toContain(nasty);
    expect(h).toContain("&lt;o&#39;brien &amp; co&gt;");
  });

  it("names the skill path and the tier change in the level-up log", () => {
    const h = html(data({ levelUps: [up(0, { label: "TheOneOS", level: 10, tierChanged: true })] }));
    expect(h).toContain("Codex › project › TheOneOS");
    expect(h).toContain("→ Apprentice");
  });

  // Review Focus 5. Codex has a level but no sub-skills and no XP in 28 days, so
  // its section keeps its pace block, which says so; Hermes has no driven hours.
  it("renders every empty state", () => {
    const quiet = tool({ projects: [], models: [], pace: idle() });
    const h = html(data({ tools: [quiet, noHours()], all: idle(), levelUps: [], levelUpCount: 0 }));
    const codex = sectionOf(h, "codex");
    for (const s of ["No projects with driven hours yet.", "No models with driven hours yet.", "no pace in the last 28 days"]) {
      expect(codex).toContain(s);
    }
    expect(sectionOf(h, "hermes")).toContain("No driven hours yet.");
    expect(h).toContain("No level-ups yet.");
    const bare = html(data({ tools: [noHours()], totalLevel: null, all: idle(), levelUps: [], levelUpCount: 0 }));
    expect(bare.split("No driven hours yet.").length - 1).toBe(2); // the skills grid and the section
    for (const page of [h, bare]) for (const s of ["Lv 1<", "0 XP", "NaN", "in 0 days"]) expect(page).not.toContain(s);
  });

  // Final review M6: spec §5's one line is the whole state of a tool with no
  // driven hours -- no pace block of "none"s, no empty sub-skill tables.
  it("shows a tool with no driven hours as its one line", () => {
    const hermes = sectionOf(html(data({ tools: [tool(), noHours()] })), "hermes");
    expect(hermes).toContain("No driven hours yet.");
    for (const s of ["XP today", "streak", "no pace", ">none<", "with driven hours yet", "<table", "Hermes · "]) {
      expect(hermes).not.toContain(s);
    }
  });

  // Final review M7: under an hour a sub-skill's time is minutes and seconds
  // (html.ts's duration), never "0.0h" beside a real level.
  it("shows a sub-skill's time under an hour in minutes and seconds", () => {
    const h = html(data({ tools: [tool({
      projects: [skill("brief", { activeS: 58 }), skill("short", { activeS: 432 })],
      models: [skill("long", { activeS: 5400 }), skill("hour", { activeS: 3600 })],
    })] }));
    for (const s of [">58s<", ">7m 12s<", ">1.5h<", ">1.0h<"]) expect(h).toContain(s);
    expect(h).not.toContain("0.0h");
  });

  it("is pending, as one card, before the v8 rollup has run", () => {
    const h = html(data({ pending: true, tools: [], all: null, levelUps: [], levelUpCount: 0, totalLevel: null }));
    expect(h).toContain("level pending");
    expect(h).toContain("Watchtower&#39;s rollup has not run since its v8 install");
  });

  it("hides (excluded) with a caption", () => {
    expect(html(data({ tools: [tool({ excludedHidden: true })] })))
      .toContain("Excluded projects are hidden here; their time still counts toward the tool.");
  });

  it("cuts the report to the newest level-ups and REPORT_ROWS sub-skills, with notes", () => {
    const many = Array.from({ length: 45 }, (_, i) => up(i));
    const projects = Array.from({ length: REPORT_ROWS + 10 }, (_, i) => skill(`p${String(i).padStart(3, "0")}`));
    const d = data({ levelUps: many, levelUpCount: 45, tools: [tool({ projects })] });
    const report = html(d, false);
    expect(report).toContain(`the ${REPORT_LEVEL_UPS} newest of 45 entries`);
    // A level-up's skill cell is its whole path: "Codex › project › k29".
    expect(report).toContain(`› k${String(REPORT_LEVEL_UPS - 1).padStart(2, "0")}<`);
    expect(report).not.toContain(`› k${REPORT_LEVEL_UPS}<`);
    expect(report).toContain(`the ${REPORT_ROWS} highest of ${REPORT_ROWS + 10} projects`);
    const served = html(d, true);
    expect(served).toContain("› k44<");
    expect(served).not.toContain("newest of 45");
  });
});

describe("Character in the nav and on the Overview", () => {
  it("sits in the tool row after the Overview, and is current on its own page", () => {
    expect(TOOLS.map((t) => t.label)).toEqual(["Overview", "Character", "Quests", "Claude Code", "Codex", "Hermes"]);
    const p = page({ title: "x", active: "/character", body: "" });
    expect(p).toContain(`<span class="pill on t-character" aria-current="true">Character</span>`);
  });

  it("links each level card to its section: the route served, the anchor in the report", () => {
    expect(characterHref("claude", true)).toBe("/character#character-claude");
    expect(characterHref("claude", false)).toBe("#character-claude");
  });
});

describe("Skill use", () => {
  it("draws its tile after the tools, outside the Total level, with a note saying so", () => {
    const h = html(data({ skillUse: use() }));
    expect(h).toContain(`href="#character-skill-use"`);
    expect(h.indexOf(`href="#character-codex"`)).toBeLessThan(h.indexOf(`href="#character-skill-use"`));
    expect(h).toContain("Skill use is time already in Claude&#39;s level, so it is not in Total.");
    expect(h).toContain("<b>57</b>"); // the Total level, unchanged
  });

  it("draws no tile and no note without skill time", () => {
    const h = html(data());
    expect(h).not.toContain(`href="#character-skill-use"`);
    expect(h).not.toContain("not in Total");
  });

  it("shows its section after Claude's: what it counts, its packs, its skills and their packs", () => {
    const h = html(data({ tools: [claudeTool(), tool()], skillUse: use() }));
    const at = (s: string) => h.indexOf(`id="character-${s}"`);
    expect(at("claude")).toBeLessThan(at("skill-use"));
    expect(at("skill-use")).toBeLessThan(at("codex"));
    const sec = sectionOf(h, "skill-use");
    expect(sec).toContain("Lv 40");
    expect(sec).toContain("Time in the turns that loaded a skill.");
    for (const s of ["Skill use · packs", "Skill use · skills", ">Pack<", ">superpowers:brainstorming<", ">gstack<", ">(no pack)<"]) {
      expect(sec).toContain(s);
    }
  });

  it("renders its empty states", () => {
    const pending = sectionOf(html(data({ tools: [claudeTool()], skillUse: { pending: true, level: null, packs: [], skills: [] } })), "skill-use");
    expect(pending).toContain("level pending");
    expect(pending).toContain("Watchtower&#39;s rollup has not run since its v9 install");
    const none = sectionOf(html(data({ tools: [claudeTool()] })), "skill-use");
    expect(none).toContain("No skill time yet.");
    for (const s of ["<table", "Lv 1<", "0 XP", "NaN"]) expect(none).not.toContain(s);
  });

  it("names Skill use and the skill paths in the level-up log", () => {
    const h = html(data({ levelUps: [
      up(0, { source: "claude", kind: "skill-use", key: "all", label: "Skill use" }),
      up(1, { source: "claude", kind: "skill", key: "superpowers:brainstorming", label: "superpowers:brainstorming" }),
      up(2, { source: "claude", kind: "pack", key: "gstack", label: "gstack" }),
    ], levelUpCount: 3 }));
    expect(h).toContain(">Skill use<");
    expect(h).toContain("Claude Code › skill › superpowers:brainstorming");
    expect(h).toContain("Claude Code › pack › gstack");
    expect(h).not.toContain("› skill-use ›");
  });

  it("escapes skill and pack names", () => {
    const nasty = "<o'brien & co>";
    const h = html(data({ tools: [claudeTool()], skillUse: use({
      packs: [skill(nasty)], skills: [{ ...skill(nasty), pack: nasty }],
    }) }));
    expect(h).not.toContain(nasty);
    expect(h).toContain("&lt;o&#39;brien &amp; co&gt;");
  });

  it("cuts its tables to REPORT_ROWS in the report", () => {
    const skills = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => ({ ...skill(`s${String(i).padStart(3, "0")}`), pack: "p" }));
    const d = data({ tools: [claudeTool()], skillUse: use({ skills }) });
    expect(html(d, false)).toContain(`the ${REPORT_ROWS} highest of ${REPORT_ROWS + 5} skills`);
    expect(html(d, true)).not.toContain("highest of");
  });
});
