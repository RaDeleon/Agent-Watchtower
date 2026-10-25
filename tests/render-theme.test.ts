import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CONTINUOUS_ANIMATIONS,
  ENTRANCE_ANIMATIONS,
  LIFT,
  SERIES,
  THEME_LABELS,
  THEMES,
  TOKEN_NAMES,
  TOKENS,
  headScript,
  themeCss,
} from "@/lib/render/theme";
import { LAYOUT_CSS } from "@/lib/render/layout";
import { animationNames, cssRules } from "./helpers/css.ts";

const ROOT = path.resolve(__dirname, "..");

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme tokens", () => {
  it("names exactly the five themes, amber first", () => {
    expect(THEMES).toEqual(["amber", "claude", "giants", "raptors", "bills"]);
    expect(THEME_LABELS).toEqual({
      amber: "TheOne amber", claude: "Claude", giants: "SF Giants",
      raptors: "Toronto Raptors", bills: "Buffalo Bills",
    });
  });

  // Spec §4.1's token list, spelled out here rather than imported, so a token
  // dropped from theme.ts cannot also drop out of the assertion.
  it("defines every spec token in every theme", () => {
    const spec = ["bg", "ink", "dim", "label", "line", "glass", "card", "track", "a1", "a2",
      "on-accent", "glow1", "glow2", "glow-soft", "live", "ok", "warn", "over"];
    expect([...TOKEN_NAMES].sort()).toEqual([...spec].sort());
    for (const t of THEMES) {
      for (const k of spec) expect(TOKENS[t][k as keyof (typeof TOKENS)["amber"]], `${t} --${k}`).toMatch(/\S/);
    }
  });

  it("carries the spec's amber column verbatim", () => {
    expect(TOKENS.amber).toMatchObject({
      bg: "#08080c", ink: "#f5f5f4", dim: "#a8a29e", label: "#fde68a", a1: "#f59e0b",
      a2: "#fde68a", "on-accent": "#1c1917", live: "#34d399", ok: "#34d399",
      warn: "#f59e0b", over: "#ef4444",
    });
  });

  it("carries the spec's table for the other four themes", () => {
    const col = (t: keyof typeof TOKENS) => [
      TOKENS[t].bg, TOKENS[t].ink, TOKENS[t].dim, TOKENS[t].label, TOKENS[t].a1,
      TOKENS[t].a2, TOKENS[t]["on-accent"], TOKENS[t].live, TOKENS[t].ok,
    ];
    expect(col("claude")).toEqual(["#141413", "#F0EEE6", "#A8A49A", "#E3B99A", "#D97757", "#EBC5A0", "#141413", "#8FBF8A", "#D97757"]);
    expect(col("giants")).toEqual(["#0B0A09", "#FFF6E6", "#B3A48C", "#EFD19F", "#FD5A1E", "#EFD19F", "#0B0A09", "#FD5A1E", "#FD5A1E"]);
    expect(col("raptors")).toEqual(["#070708", "#F4F4F5", "#A1A1A4", "#B4975A", "#CE1141", "#B4975A", "#ffffff", "#CE1141", "#A1A1A4"]);
    expect(col("bills")).toEqual(["#050B1C", "#FFFFFF", "#9AA8C7", "#8FB3FF", "#00338D", "#C60C30", "#ffffff", "#3D7BFF", "#3D7BFF"]);
  });

  // --warn and --over are shared on purpose: a limit warning reads the same in
  // every theme, and Review Focus 5 leans on it where --ok is silver.
  it("shares --warn and --over across every theme", () => {
    for (const t of THEMES) {
      expect(TOKENS[t].warn).toBe("#f59e0b");
      expect(TOKENS[t].over).toBe("#ef4444");
    }
  });

  it("meets WCAG AA: --ink >= 4.5 and --dim >= 3 against --bg, in every theme", () => {
    for (const t of THEMES) {
      expect(contrast(TOKENS[t].ink, TOKENS[t].bg), `${t} ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(TOKENS[t].dim, TOKENS[t].bg), `${t} dim`).toBeGreaterThanOrEqual(3);
    }
  });
});

// The donut palette. A slice of a whole is not an alarm: before this, the sixth
// slice ("N others") was --over red, and Raptors drew two slices the same red.
describe("categorical series", () => {
  it("gives every theme at least 6 pairwise-distinct slice colours, none --warn, --over or the neutral --dim", () => {
    for (const t of THEMES) {
      const s = SERIES[t].map((c) => c.toLowerCase());
      expect(s.length, t).toBeGreaterThanOrEqual(6);
      expect(new Set(s).size, `${t}: ${s.join(" ")}`).toBe(s.length);
      for (const c of s) {
        expect(c, `${t} ${c}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(c, `${t} ${c} is --warn`).not.toBe(TOKENS[t].warn.toLowerCase());
        expect(c, `${t} ${c} is --over`).not.toBe(TOKENS[t].over.toLowerCase());
        expect(c, `${t} ${c} is --dim`).not.toBe(TOKENS[t].dim.toLowerCase());
      }
    }
  });

  // WCAG 1.4.11: a graphical object needs 3:1 against what it sits on.
  it("keeps every slice colour readable on its theme's --bg (>= 3:1)", () => {
    for (const t of THEMES) {
      for (const c of SERIES[t]) expect(contrast(c, TOKENS[t].bg), `${t} ${c}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("emits the series as --c0 … --c5 in each theme block", () => {
    const css = themeCss();
    for (const t of THEMES) {
      const at = css.indexOf(t === "amber" ? ":root,[data-theme=amber]{" : `[data-theme=${t}]{`);
      const block = css.slice(at, css.indexOf("}", at));
      SERIES[t].forEach((c, i) => expect(block).toContain(`--c${i}:${c}`));
    }
  });
});

/** Luminance of `fg` (#rrggbb at `alpha`, or an rgba() string) composited over the opaque `bg`. */
function over(fg: string, bg: string, alpha = 1): number {
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16));
  let f: number[];
  let a = alpha;
  const m = /^rgba\((\d+),(\d+),(\d+),([.\d]+)\)$/.exec(fg.replace(/\s/g, ""));
  if (m) { f = [Number(m[1]), Number(m[2]), Number(m[3])]; a = Number(m[4]); } else f = rgb(fg);
  const b = rgb(bg);
  const mix = f.map((v, i) => Math.round(a * v + (1 - a) * b[i]));
  return relativeLuminance(`#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`);
}

// I3. Every data mark -- lines, areas, points, sparklines, heatmap cells, the
// progress ring, the meter -- is drawn in --mark. Bills' --a1
// (#00338D) is ~1.7:1 on its navy, which made its charts nearly invisible and
// its heatmaps read inverted. Planted: set Bills' mark back to #00338D and
// both tests below go red.
describe("data marks (--mark)", () => {
  it("holds every data-mark colour at >= 3:1 against --bg, in every theme", () => {
    for (const t of THEMES) {
      expect(contrast(LIFT[t].mark, TOKENS[t].bg), `${t} --mark`).toBeGreaterThanOrEqual(3);
      expect(contrast(LIFT[t].bar, TOKENS[t].bg), `${t} --bar`).toBeGreaterThanOrEqual(3);
    }
    expect(LIFT.bills.mark).toBe("#3D7BFF");
    for (const t of ["amber", "claude", "giants", "raptors"] as const) expect(LIFT[t].mark).toBe(TOKENS[t].a1);
  });

  // An empty heatmap cell is --track; levels 1-4 are --mark at 30/52/76/100%.
  // Each level must read brighter than the one below it, the empty cell darkest.
  it("orders the heatmap levels empty < l1 < l2 < l3 < l4 in every theme", () => {
    for (const t of THEMES) {
      const bg = TOKENS[t].bg;
      const lum = [over(TOKENS[t].track, bg), ...[0.3, 0.52, 0.76, 1].map((a) => over(LIFT[t].mark, bg, a))];
      for (let i = 1; i < lum.length; i++) expect(lum[i], `${t} level ${i}`).toBeGreaterThan(lum[i - 1]);
    }
  });

  it("draws every data mark in --mark, not --a1", () => {
    const css = LAYOUT_CSS + themeCss();
    for (const sel of [".line", ".area", ".pt-solo", ".cell.l1", ".cell.l4", ".spark path", ".spark circle", ".ring-progress .ring-arc"]) {
      const rule = cssRules(css).rules.find((r) => r.selector === sel);
      expect(rule?.body, sel).toContain("var(--mark)");
      expect(rule?.body, sel).not.toContain("var(--a1)");
    }
    const block = (t: string) => { const at = themeCss().indexOf(t === "amber" ? ":root,[data-theme=amber]{" : `[data-theme=${t}]{`); return themeCss().slice(at, themeCss().indexOf("}", at)); };
    for (const t of THEMES) expect(block(t)).toContain(`--mark:${LIFT[t].mark}`);
  });
});

describe("themeCss", () => {
  const css = themeCss();

  it("emits amber as :root and one block per theme", () => {
    expect(css).toContain(":root,[data-theme=amber]{");
    for (const t of THEMES) expect(css).toContain(`[data-theme=${t}]{`);
    expect(css).toContain("--on-accent:#1c1917");
  });

  // Team themes are colours only (spec D5): no logos, images, URLs or names.
  it("carries no image, URL or team name", () => {
    expect(css).not.toContain("url(");
    expect(css).not.toContain("<img");
    expect(css).not.toContain("http");
    for (const name of ["Giants", "Raptors", "Bills"]) expect(css).not.toContain(name);
    expect(headScript()).not.toMatch(/Giants|Raptors|Bills|http/);
  });

  it("switches every animation and transition off under reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = cssRules(css).rules.filter((r) => r.at.some((a) => a.includes("prefers-reduced-motion")));
    expect(reduced.some((r) => /animation:\s*none\s*!important/.test(r.body) && /transition:\s*none\s*!important/.test(r.body)
      && r.selector.split(",").map((s) => s.trim()).includes("*"))).toBe(true);
  });

  // Motion rule 1: an entrance runs once per load. Anything that is not one of
  // the named continuous effects must be scoped to html:not(.settled), so the
  // Live poll -- which lands after `settled` -- can never replay it.
  it("applies each keyframe it defines only under html:not(.settled), bar the continuous effects", () => {
    const { rules, keyframes } = cssRules(css);
    expect(keyframes.sort()).toEqual([...ENTRANCE_ANIMATIONS, ...CONTINUOUS_ANIMATIONS].sort());
    const gated = keyframes.filter((k) => !CONTINUOUS_ANIMATIONS.includes(k));
    for (const r of rules) {
      if (animationNames(r.body, gated).length === 0) continue;
      for (const sel of r.selector.split(",")) expect(sel.trim(), r.selector).toMatch(/^html:not\(\.settled\)/);
    }
  });
});

describe("headScript", () => {
  it("applies only known values, inside try", () => {
    const s = headScript();
    expect(s).toContain("try");
    expect(s).toContain("wt.theme");
    expect(s).toContain("wt.nav");
    for (const t of THEMES) expect(s).toContain(t);
  });
});

// Guard 6: an entrance animation that is not gated by html.settled replays on
// every Live poll. Parsed over BOTH stylesheets, since layout.ts applies the
// card entrance and theme.ts the rest.
describe("guard 6: entrance motion is gated by html.settled", () => {
  it("applies rise, sweep, grow and bar only from html:not(.settled) selectors", () => {
    const { rules } = cssRules(themeCss() + LAYOUT_CSS);
    let applied = 0;
    for (const r of rules) {
      const names = animationNames(r.body, ["rise", "sweep", "grow", "bar"]);
      if (names.length === 0) continue;
      applied += names.length;
      for (const sel of r.selector.split(",")) {
        expect(`${sel.trim()} -> ${names.join(",")}`).toMatch(/^html:not\(\.settled\) /);
      }
    }
    // The guard must be looking at something: the card rise at the least.
    expect(applied).toBeGreaterThanOrEqual(4);
  });
});

describe("colours live in theme.ts only", () => {
  it("layout.ts carries no hex colour", () => {
    const src = readFileSync(path.join(ROOT, "lib/render/layout.ts"), "utf8");
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  // Task 4's sweep: every renderer, not only the shell. A colour written into
  // a chart or a page would ignore the theme switch.
  it("no file under lib/render/ but theme.ts carries a hex colour", () => {
    const dir = path.join(ROOT, "lib/render");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    for (const f of ["charts.ts", "client.ts", "level.ts", "layout.ts", "report.ts", "skills.ts", "sources.ts"]) {
      expect(files).toContain(f);
    }
    for (const f of files.filter((x) => x !== "theme.ts")) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(`${f}: ${(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).join(" ")}`).toBe(`${f}: `);
    }
  });
});
