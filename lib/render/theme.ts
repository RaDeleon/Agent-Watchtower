/**
 * Themes: every colour on the dashboard, and the effects that use them.
 *
 * A theme is one block of CSS custom properties. Switching theme swaps a
 * `data-theme` attribute on `<html>`, so nothing re-renders and the server
 * never needs to know which one is showing. This is the ONLY file under
 * `lib/render/` allowed a literal colour; everything else says `var(--…)`.
 *
 * Values are verbatim from the approved mockups (spec §4.1): the amber column
 * from `live-page-v2.html`, the other four and every rgba token from
 * `palettes.html`. Team themes are colours only -- no logos, images, URLs or
 * team names, beyond each theme's label in Settings.
 */

export type ThemeId = "amber" | "claude" | "giants" | "raptors" | "bills";

export const THEMES: readonly ThemeId[] = ["amber", "claude", "giants", "raptors", "bills"];

export const THEME_LABELS: Record<ThemeId, string> = {
  amber: "Amber",
  claude: "Claude",
  giants: "SF Giants",
  raptors: "Toronto Raptors",
  bills: "Buffalo Bills",
};

export const TOKEN_NAMES = [
  "bg", "ink", "dim", "label", "line", "glass", "card", "track", "a1", "a2", "on-accent",
  "glow1", "glow2", "glow-soft", "live", "ok", "warn", "over",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

/**
 * Shared on purpose: a limit warning must read the same in every theme, and
 * where a theme's `--ok` is silver (Raptors) these two plus the ring's text
 * label are what keep the states apart.
 */
const WARN = "#f59e0b";
const OVER = "#ef4444";

export const TOKENS: Record<ThemeId, Record<TokenName, string>> = {
  amber: {
    bg: "#08080c", ink: "#f5f5f4", dim: "#a8a29e", label: "#fde68a",
    line: "rgba(255,255,255,.08)", glass: "rgba(255,255,255,.04)", card: "rgba(20,18,22,.55)",
    track: "rgba(255,255,255,.07)", a1: "#f59e0b", a2: "#fde68a", "on-accent": "#1c1917",
    glow1: "rgba(245,158,11,.35)", glow2: "rgba(124,58,237,.28)", "glow-soft": "rgba(251,191,36,.35)",
    live: "#34d399", ok: "#34d399", warn: WARN, over: OVER,
  },
  claude: {
    bg: "#141413", ink: "#F0EEE6", dim: "#A8A49A", label: "#E3B99A",
    line: "rgba(240,238,230,.10)", glass: "rgba(240,238,230,.04)", card: "rgba(31,30,28,.62)",
    track: "rgba(240,238,230,.08)", a1: "#D97757", a2: "#EBC5A0", "on-accent": "#141413",
    glow1: "rgba(217,119,87,.42)", glow2: "rgba(204,120,92,.18)", "glow-soft": "rgba(217,119,87,.35)",
    live: "#8FBF8A", ok: "#D97757", warn: WARN, over: OVER,
  },
  giants: {
    bg: "#0B0A09", ink: "#FFF6E6", dim: "#B3A48C", label: "#EFD19F",
    line: "rgba(239,209,159,.12)", glass: "rgba(239,209,159,.04)", card: "rgba(27,24,21,.65)",
    track: "rgba(255,246,230,.08)", a1: "#FD5A1E", a2: "#EFD19F", "on-accent": "#0B0A09",
    glow1: "rgba(253,90,30,.45)", glow2: "rgba(239,209,159,.16)", "glow-soft": "rgba(253,90,30,.4)",
    live: "#FD5A1E", ok: "#FD5A1E", warn: WARN, over: OVER,
  },
  raptors: {
    bg: "#070708", ink: "#F4F4F5", dim: "#A1A1A4", label: "#B4975A",
    line: "rgba(161,161,164,.16)", glass: "rgba(161,161,164,.05)", card: "rgba(22,22,24,.65)",
    track: "rgba(244,244,245,.08)", a1: "#CE1141", a2: "#B4975A", "on-accent": "#ffffff",
    glow1: "rgba(206,17,65,.45)", glow2: "rgba(161,161,164,.16)", "glow-soft": "rgba(206,17,65,.4)",
    live: "#CE1141", ok: "#A1A1A4", warn: WARN, over: OVER,
  },
  bills: {
    bg: "#050B1C", ink: "#FFFFFF", dim: "#9AA8C7", label: "#8FB3FF",
    line: "rgba(154,168,199,.16)", glass: "rgba(154,168,199,.05)", card: "rgba(10,22,52,.62)",
    track: "rgba(255,255,255,.08)", a1: "#00338D", a2: "#C60C30", "on-accent": "#ffffff",
    glow1: "rgba(0,51,141,.65)", glow2: "rgba(198,12,48,.28)", "glow-soft": "rgba(60,110,230,.45)",
    live: "#3D7BFF", ok: "#3D7BFF", warn: WARN, over: OVER,
  },
};

/**
 * Four derived properties, not spec tokens: where an accent sits on the
 * background itself. They equal `--a1` everywhere except Bills, whose royal
 * blue `#00338D` is unreadable on its navy (~1.7:1): there the active pill
 * starts at `#1a4fbf` (spec §4.1), and bars and big-number tints use
 * `#3D7BFF` / `#8FB3FF`, as `palettes.html` does.
 *
 * `mark` is the colour of every DATA mark -- lines, areas, points,
 * sparklines, heatmap cells, the progress ring, the meter
 * -- "wherever royal blue would sit on navy" (spec §4.1). Before the fix wave
 * (I3) those used `--a1` directly, so Bills drew its charts at 1.7:1 and its
 * heatmaps read inverted: an empty cell (`--track` grey) was brighter than a
 * busy one. A test holds every theme's `--mark` at >= 3:1 against `--bg`.
 */
export const LIFT: Record<ThemeId, { "pill-a": string; "num-tint": string; bar: string; mark: string }> = {
  amber: { "pill-a": "#f59e0b", "num-tint": "#fcd34d", bar: "#f59e0b", mark: "#f59e0b" },
  claude: { "pill-a": "#D97757", "num-tint": "#D97757", bar: "#D97757", mark: "#D97757" },
  giants: { "pill-a": "#FD5A1E", "num-tint": "#FD5A1E", bar: "#FD5A1E", mark: "#FD5A1E" },
  raptors: { "pill-a": "#CE1141", "num-tint": "#CE1141", bar: "#CE1141", mark: "#CE1141" },
  bills: { "pill-a": "#1a4fbf", "num-tint": "#8FB3FF", bar: "#3D7BFF", mark: "#3D7BFF" },
};

/**
 * The categorical series: the colours of donut slices, stacked-bar segments
 * and their legend swatches, emitted as `--c0` … `--c5`. Six per theme, each
 * derived from the theme's own palette (its accents, live and label colours,
 * plus hues that sit beside them), pairwise distinct, at least 3:1 against the
 * theme's `--bg`, and never `--warn` or `--over`: a share of a whole is not an
 * alarm. Amber's own accent IS `--warn`, so its first slice is the lighter
 * `#fbbf24`. A remainder ("N others", "not recorded", "unknown") is drawn in
 * neither: it takes the neutral `--dim`, faded, in layout.ts.
 */
export const SERIES: Record<ThemeId, readonly string[]> = {
  amber: ["#fbbf24", "#fde68a", "#34d399", "#a78bfa", "#38bdf8", "#f9a8d4"],
  claude: ["#D97757", "#EBC5A0", "#8FBF8A", "#6A9BCC", "#B8A4D9", "#C9B26B"],
  giants: ["#FD5A1E", "#EFD19F", "#8FA3B8", "#7FB77E", "#E8A87C", "#A89BD9"],
  raptors: ["#CE1141", "#B4975A", "#E4E4E7", "#9B6CD8", "#5FB3A1", "#E8C98A"],
  bills: ["#3D7BFF", "#C60C30", "#8FB3FF", "#E8EDF7", "#F28C9B", "#5FC9C0"],
};

/** Entrance keyframes: run once per load, gated by `html:not(.settled)`. */
export const ENTRANCE_ANIMATIONS = ["rise", "sweep", "grow", "bar"];

/**
 * Continuous effects: loops, not entrances, so a poll landing mid-cycle
 * replays nothing. Reduced motion still switches every one of them off.
 */
export const CONTINUOUS_ANIMATIONS = ["drift", "spin", "ping", "flow", "dash", "shine", "pulse"];

function block(t: ThemeId): string {
  const series = Object.fromEntries(SERIES[t].map((c, i) => [`c${i}`, c]));
  const vars = { ...TOKENS[t], ...LIFT[t], ...series };
  return Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(";");
}

/** A swatch in Settings shows the theme's own accents, whichever theme is active. */
function swatch(t: ThemeId): string {
  return `.swatch-${t}{background:linear-gradient(135deg,${LIFT[t]["pill-a"]},${TOKENS[t].a2});` +
    `box-shadow:inset 0 0 0 3px ${TOKENS[t].bg}}`;
}

const EFFECTS = `
@property --ang { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
html { color-scheme: dark; background: var(--bg); color: var(--ink); }
/* body stays transparent: its own background would paint over the aurora. */
body { background: transparent; }
.aurora { position: fixed; inset: -30%; z-index: -1; pointer-events: none; filter: blur(60px); opacity: .9;
  background: radial-gradient(30% 35% at 80% 10%, var(--glow1), transparent 70%),
              radial-gradient(25% 30% at 15% 80%, var(--glow2), transparent 70%),
              radial-gradient(20% 25% at 55% 55%, var(--glow-soft), transparent 70%);
  animation: drift 18s ease-in-out infinite alternate; }
@keyframes drift { to { transform: translate(-6%, 5%) rotate(8deg) scale(1.08); } }
.brand { background: linear-gradient(90deg, var(--ink) 0%, var(--a2) 40%, var(--a1) 60%, var(--ink) 100%);
  background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: shine 6s linear infinite; }
@keyframes shine { to { background-position: 200% center; } }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--live);
  margin-right: 7px; position: relative; vertical-align: 1px; }
.dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--live);
  animation: ping 1.6s cubic-bezier(0,0,.2,1) infinite; }
@keyframes ping { 75%, 100% { transform: scale(2.6); opacity: 0; } }
.hero::before { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.5px; pointer-events: none;
  background: conic-gradient(from var(--ang), transparent 0 60%, var(--mark) 75%, var(--a2) 86%, transparent 95%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: spin 5s linear infinite; }
@keyframes spin { to { --ang: 360deg; } }
.big { font-size: 38px; font-weight: 800; letter-spacing: -.04em; line-height: 1.1; font-variant-numeric: tabular-nums;
  background: linear-gradient(180deg, var(--ink) 35%, var(--num-tint) 150%); -webkit-background-clip: text;
  background-clip: text; color: transparent; filter: drop-shadow(0 0 18px var(--glow-soft)); }
.big .unit, .big.absent { -webkit-text-fill-color: var(--dim); letter-spacing: 0; }
.meter { height: 7px; border-radius: 99px; background: var(--track); overflow: hidden; margin-top: 8px; }
.meter > i { display: block; height: 100%; border-radius: 99px;
  background: linear-gradient(90deg, var(--mark), var(--a2), var(--mark)); background-size: 200% 100%;
  box-shadow: 0 0 14px var(--glow-soft); animation: flow 3s linear infinite; }
html:not(.settled) .meter > i { animation: grow 1.2s cubic-bezier(.2,.8,.2,1) both, flow 3s linear infinite; }
@keyframes grow { from { width: 0; } }
@keyframes flow { to { background-position: -200% 0; } }
html:not(.settled) .ring-arc { animation: sweep 1.4s cubic-bezier(.2,.8,.2,1) both; }
@keyframes sweep { from { stroke-dasharray: 0 400; } }
.ring-ok .ring-arc { stroke: var(--ok); filter: drop-shadow(0 0 7px var(--ok)); }
.ring-warn .ring-arc { stroke: var(--warn); filter: drop-shadow(0 0 8px var(--warn)); }
.ring-over .ring-arc { stroke: var(--over); filter: drop-shadow(0 0 10px var(--over)); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .55; } }
.ring-state { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; fill: var(--dim); }
.ring-warn .ring-state { fill: var(--warn); } .ring-over .ring-state { fill: var(--over); }
.burn-area { fill: var(--glow-soft); opacity: .6; }
.burn-line { fill: none; stroke: var(--a2); stroke-width: 2.2; stroke-dasharray: 6 4;
  filter: drop-shadow(0 0 5px var(--mark)); animation: dash 1.2s linear infinite; }
@keyframes dash { to { stroke-dashoffset: -20; } }
html:not(.settled) .chart rect.bar { transform-box: fill-box; transform-origin: bottom;
  animation: bar .9s cubic-bezier(.2,.8,.2,1) both; }
@keyframes bar { from { transform: scaleY(0); } }
@keyframes rise { from { opacity: 0; transform: translateY(14px) scale(.98); } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

/**
 * Every theme block, the swatches, the effects, and the reduced-motion block.
 * Amber is also `:root`, so a page whose script never ran is still amber.
 */
export function themeCss(): string {
  const blocks = THEMES.map((t) =>
    t === "amber" ? `:root,[data-theme=amber]{${block(t)}}` : `[data-theme=${t}]{${block(t)}}`,
  );
  return `${blocks.join("\n")}\n${THEMES.map(swatch).join("\n")}\n${EFFECTS}`;
}

/**
 * The tiny blocking script in `<head>`: applies a stored theme and nav mode
 * before first paint, so a non-default choice never flashes amber first. Only
 * known values are applied, and storage is touched only inside `try` -- a
 * browser with storage blocked (Safari private mode, `file://`) keeps the
 * document's own amber + pills.
 */
export function headScript(): string {
  const themes = THEMES.join("|");
  return `(function(){try{var s=window.localStorage,r=document.documentElement,` +
    `t=s.getItem("wt.theme"),n=s.getItem("wt.nav");` +
    `if(/^(${themes})$/.test(t||""))r.setAttribute("data-theme",t);` +
    `if(n==="pills"||n==="sidebar")r.setAttribute("data-nav",n);}catch(e){}})();`;
}
