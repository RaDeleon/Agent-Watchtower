/**
 * The page shell: one `<html>` document, styles inline, no framework and no
 * network fetches. `serve` and `report` both render through here, which is what
 * keeps the static export from becoming a second implementation.
 *
 * Every colour is a theme token (`var(--…)`, see theme.ts): this file may not
 * contain a literal colour, and a test greps it for one. The navigation is one
 * DOM in two looks -- two rows of pills by default, a left sidebar when
 * `html[data-nav=sidebar]` -- so switching mode re-renders nothing.
 */
import { FAVICON_HREF, crestMark } from "./brand.ts";
import { clientScript } from "./client.ts";
import { esc } from "./html.ts";
import { THEME_LABELS, THEMES, headScript, themeCss } from "./theme.ts";

export interface NavItem {
  href: string;
  label: string;
}

/** Views that exist. Later stages add their routes here and nowhere else. */
export const NAV: NavItem[] = [
  { href: "/", label: "Live" },
  { href: "/history", label: "History" },
  { href: "/projects", label: "Projects" },
  { href: "/sessions", label: "Sessions" },
  { href: "/skills", label: "Models & Skills" },
  { href: "/profile", label: "Usage Profile" },
  { href: "/performance", label: "Performance" },
  { href: "/sources", label: "Sources" },
];

/**
 * One view's content, independent of how it is wrapped. `serve` wraps it as a
 * page of its own (`viewPage`); `report` stacks several into one file. Both
 * take the same `View`, so neither can grow a renderer the other lacks.
 */
export interface View {
  /** The route, which is also the nav entry it marks as current. */
  href: string;
  /** Short name: "History". The document title is derived from it. */
  title: string;
  body: string;
  footer: string;
  /**
   * Extra query the served range pills carry, e.g. `&project=%2Fa%2Fb`, so a
   * filtered page keeps its filter across ranges. Built by the view from
   * values its reader matched, never from raw query text.
   */
  pillQuery?: string;
  /**
   * The body's top-level pieces, in order, when the view supplies them: `body`
   * is exactly their concatenation. The report uses them to emit a piece that
   * is identical in every range once, rather than once per range (views.ts).
   * A view without them is one piece.
   */
  sections?: string[];
}

/**
 * A glass card: the unit every page is built from. The title is text and is
 * escaped; the body is already-rendered HTML. `hero` adds the animated border
 * (one per page, spec §4.2); `wide` spans the full grid row.
 */
export function card(opts: { title: string; body: string; hero?: boolean; wide?: boolean; id?: string }): string {
  const cls = ["c", opts.hero ? "hero" : "", opts.wide ? "wide" : ""].filter(Boolean).join(" ");
  const id = opts.id === undefined ? "" : ` id="${esc(opts.id)}"`;
  return `<section class="${cls}"${id}><h2>${esc(opts.title)}</h2>${opts.body}</section>`;
}

/**
 * Structure only: grid, header, pills, sidebar, cards, tables, charts. The
 * effects and every colour value live in theme.ts; the one entrance applied
 * here -- the card rise -- is scoped to `html:not(.settled)` like the rest.
 */
export const LAYOUT_CSS = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
/* The report's range wrappers take no box: their cards stay items of the view's grid (or of a grid row), gaps and columns intact. */
.ranged, [data-range] { display: contents; }
body { margin: 0; min-height: 100vh; overflow-x: hidden;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
a { color: inherit; }
.shell { max-width: 1240px; margin: 0 auto; padding: 18px 20px 24px; }
.rail { position: relative; margin-bottom: 18px; }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; position: relative; }
.brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; letter-spacing: .22em; font-size: 13px;
  margin-right: 14px; }
/* The crest (brand.ts): drawn in the active theme, so it changes with the switch. */
.crest { width: 20px; height: 20px; flex: none; }
.cr-shield { fill: var(--bg); stroke: var(--mark); }
.cr-mark { fill: var(--mark); }
.cr-light { fill: var(--label); }
.cr-ground { fill: var(--bg); }
.tools, .pages { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.pages { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.grp { display: none; }
.pill, .pages a { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; padding: 5px 11px;
  border-radius: 999px; border: 1px solid var(--line); background: var(--glass); color: var(--dim);
  white-space: nowrap; text-decoration: none; transition: color .2s, border-color .2s, box-shadow .2s; }
.pages a:hover { color: var(--label); border-color: var(--a2); }
.pill.on, .pages a[aria-current=page] { color: var(--on-accent); font-weight: 700; border-color: transparent;
  background: linear-gradient(135deg, var(--pill-a), var(--a2)); box-shadow: 0 0 22px -2px var(--glow-soft); }
.pill.on .dot, .pages a[aria-current=page] .dot, .pill.on .dot::after, .pages a[aria-current=page] .dot::after { background: var(--on-accent); }
.pill.soon { opacity: .35; cursor: not-allowed; }
.gear { margin-left: auto; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
  border: 1px solid var(--line); background: var(--glass); color: var(--dim); font-size: 15px; cursor: pointer; }
.gear:hover, .gear[aria-expanded=true] { color: var(--label); border-color: var(--a2); }
.settings { position: absolute; right: 0; top: 40px; z-index: 20; width: 280px; padding: 14px;
  border-radius: 16px; border: 1px solid var(--line);
  /* Opaque: inside the sidebar a nested backdrop-filter cannot blur, so a glass panel would show the page through it. */
  background: linear-gradient(var(--card), var(--card)), var(--bg); box-shadow: 0 20px 60px -20px var(--bg); display: grid; gap: 8px; }
.set-h { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--label); font-weight: 700; }
.themes { display: grid; gap: 4px; }
.settings button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border-radius: 10px;
  border: 1px solid transparent; background: transparent; color: var(--ink); font: inherit; font-size: 12px;
  cursor: pointer; text-align: left; }
.settings button:hover { background: var(--glass); }
.settings button[aria-pressed=true] { border-color: var(--a2); background: var(--glass); }
.swatch { width: 22px; height: 22px; border-radius: 7px; flex: none; border: 1px solid var(--line); }
.navopts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.navopts button { justify-content: center; border-color: var(--line); }
main { display: grid; gap: 12px; }
.g { display: grid; gap: 12px; }
.g-top { grid-template-columns: 1.15fr 1.6fr; }
.g-mid { grid-template-columns: 1fr 1.4fr 1fr; }
.g-2 { grid-template-columns: 1fr 1fr; }
.g-tiles { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); margin-top: 8px; }
a.tile { display: block; text-decoration: none; color: inherit; }
@media (max-width: 900px) { .g-top, .g-mid, .g-2 { grid-template-columns: 1fr; } }
.ranges { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.rp { font: inherit; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; padding: 5px 12px; cursor: pointer;
  border-radius: 999px; border: 1px solid var(--line); background: var(--glass); color: var(--dim); text-decoration: none; }
.rp:hover { color: var(--label); border-color: var(--a2); }
.rp[aria-current=true], .rp[aria-pressed=true] { color: var(--on-accent); font-weight: 700; border-color: transparent;
  background: linear-gradient(135deg, var(--pill-a), var(--a2)); box-shadow: 0 0 22px -2px var(--glow-soft); }
.scroll { overflow-x: auto; }
.rank-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
@media (max-width: 560px) { .rank-hero { grid-template-columns: 1fr; } }
  border-radius: 10px; border: 1px solid transparent; font-size: 12px; color: var(--dim); }
section, .c { position: relative; border-radius: 20px; background: var(--card); backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px); border: 1px solid var(--line); padding: 16px; min-width: 0;
  box-shadow: 0 10px 50px -20px var(--bg); transition: transform .25s, box-shadow .25s; }
.c:hover { transform: translateY(-2px); box-shadow: 0 0 60px -14px var(--glow-soft); }
html:not(.settled) .c { animation: rise .7s cubic-bezier(.2,.8,.2,1) both; }
.g > .c:nth-child(2) { animation-delay: .08s; } .g > .c:nth-child(3) { animation-delay: .16s; }
h2 { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--label); font-weight: 700; margin: 0 0 12px; }
.muted, .label { color: var(--dim); font-size: 11px; }
.absent { color: var(--dim); }
.pending { color: var(--warn); }
.boost { color: var(--ok); } .drain { color: var(--over); }
.stale { color: var(--warn); }
.row { display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start; }
.tile .value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tile .label { text-transform: uppercase; letter-spacing: .08em; margin-top: 4px; }
.unit { font-size: 14px; color: var(--dim); font-weight: 600; margin-left: 3px; }
.stat { min-width: 0; }
.state { font-size: 20px; font-weight: 700; line-height: 1.3; margin-top: 4px; }
.c.wide { grid-column: 1 / -1; }
.stats { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-end; margin-top: 10px; }
.sess-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 11px; color: var(--dim); }
.chip { display: inline-block; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; padding: 3px 8px;
  border-radius: 99px; background: var(--glass); border: 1px solid var(--a2); color: var(--label); }
.sid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; overflow-wrap: anywhere; }
.split { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.block { margin-top: 12px; }
.kv { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--dim);
  padding: 6px 0; border-bottom: 1px solid var(--line); }
.kv:last-child { border-bottom: 0; }
.kv b { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
.kv b.absent { color: var(--dim); font-weight: 400; }
.stars { letter-spacing: .08em; color: var(--ink); }
.rank-name { font-size: 30px; }
.limits { display: flex; flex-wrap: wrap; justify-content: space-around; gap: 12px; }
.ring { margin: 0; text-align: center; }
/* The arc's drop-shadow glow extends past the ring's viewBox; unclipped, it does not end in a hard square edge. */
.ring svg { overflow: visible; }
.ring figcaption { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin-top: 4px; }
.ring-sub { display: block; text-transform: none; letter-spacing: 0; color: var(--dim); }
.ring-track { stroke: var(--track); }
.ring-value { fill: var(--ink); font-size: 19px; font-weight: 800; }
.ring-low .ring-arc { stroke: var(--ok); } .ring-mid .ring-arc { stroke: var(--warn); }
.ring-high .ring-arc { stroke: var(--over); } .ring-over .ring-arc { stroke: var(--over); }
.ring-progress .ring-arc { stroke: var(--mark); }
.ring-unknown .ring-arc { stroke: var(--dim); } .ring-unknown .ring-value { fill: var(--dim); font-size: 13px; }
.spark-burn { display: block; width: 100%; height: 48px; margin-top: 4px; }
.trow { display: grid; grid-template-columns: 80px 150px 1fr; gap: 8px; font-size: 11.5px; padding: 5px 6px;
  border-bottom: 1px solid var(--line); }
.trow:last-child { border-bottom: 0; }
.trow:first-child { background: linear-gradient(90deg, var(--glass), transparent 70%); border-radius: 6px;
  box-shadow: inset 2px 0 0 var(--a1); }
.trow span:first-child { color: var(--dim); font-variant-numeric: tabular-nums; }
.trow .ev { color: var(--label); font-weight: 600; }
.trow .times { color: var(--dim); font-weight: 600; font-variant-numeric: tabular-nums; }
.trow span:last-child { overflow-wrap: anywhere; }
html:not(.settled) .trow { animation: rise .5s both; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 5px 12px 5px 0; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.atlas { display: block; font-size: 11px; }
table.sortable th { cursor: pointer; }
.th-sort { all: unset; cursor: pointer; }
.th-sort:focus-visible, figure.chart svg:focus-visible, svg.spark:focus-visible, .comp:focus-visible {
  outline: 2px solid var(--a2); outline-offset: 3px; border-radius: 4px; }
table.sortable th[aria-sort=descending]::after { content: " ▾"; } table.sortable th[aria-sort=ascending]::after { content: " ▴"; }
footer { padding: 16px 0 0; color: var(--dim); font-size: 11px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.note { color: var(--dim); font-size: 12px; margin: 8px 0 20px; max-width: 80ch; }
.c > .note:last-child { margin-bottom: 0; }
.chart { margin: 0; }
.chart svg { display: block; max-width: 100%; height: auto; }
.chart figcaption { color: var(--dim); font-size: 11px; margin-top: 6px; }
.chart-empty .empty-msg { color: var(--dim); padding: 28px 0; text-align: center;
  border: 1px dashed var(--line); border-radius: 10px; }
.tick { fill: var(--dim); font-size: 10px; }
.tick-today { fill: var(--label); font-weight: 700; }
.axis { stroke: var(--line); }
/* A chart's hover columns: vertical strokes, as wide as the group's stroke-width (charts.ts hitGroup). */
.hits path { fill: none; stroke: transparent; }
.hits path:hover { stroke: var(--glass); }
/* Data marks take --mark, never --a1: Bills' royal blue is ~1.7:1 on its navy (I3). */
.line { fill: none; stroke: var(--mark); stroke-width: 1.8; }
.area { fill: var(--mark); fill-opacity: 0.15; }
.pt-solo { fill: var(--mark); }
/* A rescaled hygiene day: --warn when one term is missing from a real window (75, 70), --over when more is (65, 60, 45, 35). */
.pt-r75, .key.r75, .pt-r70, .key.r70 { fill: var(--warn); color: var(--warn); }
.pt-r65, .key.r65, .pt-r60, .key.r60, .pt-r45, .key.r45, .pt-r35, .key.r35 { fill: var(--over); color: var(--over); }
rect.bar { fill: var(--bar); opacity: .6; rx: 6px; }
rect.bar-today { opacity: 1; filter: drop-shadow(0 0 10px var(--glow-soft)); }
.bar-absent { fill: none; stroke: var(--dim); stroke-dasharray: 4 3; }
.seg.s0, .sw.s0 { fill: var(--c0); stroke: var(--c0); background: var(--c0); }
.seg.s1, .sw.s1 { fill: var(--c1); stroke: var(--c1); background: var(--c1); }
.seg.s2, .sw.s2 { fill: var(--c2); stroke: var(--c2); background: var(--c2); }
.seg.s3, .sw.s3 { fill: var(--c3); stroke: var(--c3); background: var(--c3); }
.seg.s4, .sw.s4 { fill: var(--c4); stroke: var(--c4); background: var(--c4); }
.seg.s5, .sw.s5 { fill: var(--c5); stroke: var(--c5); background: var(--c5); }
/* A remainder ("N others", "not recorded", "unknown") is neutral: never a categorical colour, never --warn/--over. */
.seg.s-other, .sw.s-other { fill: var(--dim); stroke: var(--dim); background: var(--dim); opacity: .45; }
path.seg { stroke: none; }
/* A donut arc is a stroked circle: the .sN fill above would paint its whole disc. */
.donut circle.seg { fill: none; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.comp { display: flex; height: 12px; border-radius: 99px; overflow: hidden; background: var(--track); margin: 2px 0 8px; }
.comp .sw { display: block; height: 100%; margin: 0; border-radius: 0; }
.metrics { display: grid; gap: 8px; margin-top: 12px; }
.legend { display: flex; gap: 16px; color: var(--dim); font-size: 12px; margin-top: 6px; }
.donut { display: flex; flex-wrap: wrap; gap: 24px; align-items: center; }
.donut figcaption { width: 100%; }
.donut-key { width: auto; }
.cell.l0 { fill: var(--track); stroke: var(--line); stroke-linejoin: round; }
.cell.l1 { fill: color-mix(in srgb, var(--mark) 30%, transparent); }
.cell.l2 { fill: color-mix(in srgb, var(--mark) 52%, transparent); }
.cell.l3 { fill: color-mix(in srgb, var(--mark) 76%, transparent); }
.cell.l4 { fill: var(--mark); }
.cell.cal-absent { fill: none; stroke: var(--line); stroke-dasharray: 2 2; }
.spark path { fill: none; stroke: var(--mark); stroke-width: 1.5; }
.spark circle { fill: var(--mark); }
table.hygiene td, table.hygiene th { font-size: 12px; }
tr.rescaled.r75 td:nth-child(3), tr.rescaled.r70 td:nth-child(3) { color: var(--warn); }
tr.rescaled.r65 td:nth-child(3), tr.rescaled.r60 td:nth-child(3),
tr.rescaled.r45 td:nth-child(3), tr.rescaled.r35 td:nth-child(3) { color: var(--over); }
.health-ok { color: var(--ok); } .health-degraded { color: var(--warn); } .warn { color: var(--over); }
/* The Usage Profile's "ok" status: body-ink colour, and colour ONLY -- the status words share one size. */
.status-ok { color: var(--ink); }
table.sources td { font-size: 13px; vertical-align: top; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; font-size: 13px; border: 0; }
dl.kv dt { color: var(--dim); } dl.kv dd { margin: 0; overflow-wrap: anywhere; color: var(--ink); }
.view { display: grid; gap: 12px; }
h1.view-title { font-size: 18px; letter-spacing: .02em; margin: 16px 0 0; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.view-foot { color: var(--dim); font-size: 12px; margin: 0; }
.add { color: var(--ok); } .del { color: var(--over); }
table.projects td, table.branches td, table.leaders td, table.models td, table.totals td { font-size: 13px; }
table.projects .spark, table.sortable .spark { vertical-align: middle; }
table.sortable td { font-size: 13px; white-space: nowrap; }
table.sortable th { white-space: nowrap; user-select: none; }
table.sortable td a { color: var(--label); text-decoration: none; } table.sortable td a:hover { text-decoration: underline; }
.hero-name { font-size: 26px; font-weight: 800; overflow-wrap: anywhere; }
.tip { position: fixed; z-index: 30; pointer-events: none; max-width: 320px; padding: 6px 10px; border-radius: 8px;
  font-size: 12px; background: var(--card); border: 1px solid var(--line); color: var(--ink);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
@media (min-width: 900px) {
  html[data-nav=sidebar] .shell { max-width: none; margin: 0; padding-left: 216px; }
  html[data-nav=sidebar] .rail { position: fixed; left: 0; top: 0; bottom: 0; width: 188px; margin: 0; z-index: 10;
    display: flex; flex-direction: column; gap: 6px; padding: 18px 12px; border-right: 1px solid var(--line);
    background: var(--card); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
  html[data-nav=sidebar] .top, html[data-nav=sidebar] .tools, html[data-nav=sidebar] .pages { display: contents; }
  /* The rail is 188px and the gear sits at its top right: the crest and wordmark fit beside it only tighter. */
  html[data-nav=sidebar] .brand { order: 0; margin: 0 0 12px; gap: 7px; font-size: 12px; letter-spacing: .12em; }
  html[data-nav=sidebar] .crest { width: 18px; height: 18px; }
  html[data-nav=sidebar] .grp { display: block; font-size: 9px; letter-spacing: .2em; text-transform: uppercase;
    color: var(--label); font-weight: 700; margin: 12px 4px 2px; }
  html[data-nav=sidebar] .grp-all { order: 1; margin-top: 0; }
  html[data-nav=sidebar] .t-overview, html[data-nav=sidebar] .t-character, html[data-nav=sidebar] .t-quests { order: 2; }
  html[data-nav=sidebar] .tool-cc { order: 3; background: none; box-shadow: none; border: 0; padding: 12px 4px 2px;
    font-size: 9px; letter-spacing: .2em; color: var(--label); }
  html[data-nav=sidebar] .pages a, html[data-nav=sidebar] .pages .pill { order: 4; }
  html[data-nav=sidebar] .grp-agents { order: 5; }
  html[data-nav=sidebar] .t-agent { order: 6; }
  html[data-nav=sidebar] .pages a[href$="sources"] { order: 7; margin-top: auto; }
  html[data-nav=sidebar] .pill, html[data-nav=sidebar] .pages a { display: block; width: 100%; text-align: left; }
  html[data-nav=sidebar] .gear { position: absolute; top: 12px; right: 10px; margin: 0; }
  html[data-nav=sidebar] .settings { position: fixed; left: 200px; top: 12px; right: auto; }
}
`;

export interface ToolLink { label: string; href: string; cls: string }

/** Every tool, the Overview and Character: real links since Stage 5 (spec §5 Nav; Stage 6 §5). */
export const TOOLS: ToolLink[] = [
  { label: "Overview", href: "/overview", cls: "t-overview" },
  { label: "Character", href: "/character", cls: "t-character" },
  { label: "Quests", href: "/quests", cls: "t-quests" },
  { label: "Claude Code", href: "/", cls: "tool-cc" },
  { label: "Codex", href: "/codex", cls: "t-agent" },
  { label: "Hermes", href: "/hermes", cls: "t-agent" },
];

/**
 * The tool row. The current tool is a span, the rest are links. Claude Code is
 * current on every page of the page row (its pages); the report, whose active
 * is "", has no current tool, and every entry is an in-page anchor.
 */
function toolRow(active: string, tools: ToolLink[]): string {
  const own = tools.find((t) => t.href === active && t.cls !== "tool-cc");
  const current = own ?? (NAV.some((n) => n.href === active) ? tools.find((t) => t.cls === "tool-cc") : undefined);
  const pill = (t: ToolLink): string =>
    t === current
      ? `<span class="pill on ${t.cls}" aria-current="true">${esc(t.label)}</span>`
      : `<a class="pill ${t.cls}" href="${esc(t.href)}">${esc(t.label)}</a>`;
  const all = tools.filter((t) => t.cls !== "t-agent").map(pill).join("");
  const agents = tools.filter((t) => t.cls === "t-agent").map(pill).join("");
  return (
    `<nav class="tools" aria-label="Tools">` +
    `<span class="grp grp-all">All tools</span>${all}` +
    `<span class="grp grp-agents">Agents</span>${agents}` +
    `</nav>`
  );
}

/**
 * The page row. A current entry keeps the exact `<a href aria-current>` shape
 * it has always had; the Live entry carries the live dot. Usage Profile is a
 * real link now (spec §5), in `NAV` itself, before Sources.
 */
function pageRow(nav: NavItem[], active: string): string {
  const links = nav.map((n) => {
    const dot = n.href === "/" ? `<span class="dot"></span>` : "";
    return `<a href="${esc(n.href)}"${n.href === active ? ' aria-current="page"' : ""}>${dot}${esc(n.label)}</a>`;
  });
  return `<nav class="pages" aria-label="Pages">${links.join("")}</nav>`;
}

function settingsPanel(): string {
  const themes = THEMES.map(
    (t) =>
      `<button type="button" data-set-theme="${t}" aria-pressed="${t === "amber"}">` +
      `<i class="swatch swatch-${t}"></i>${esc(THEME_LABELS[t])}</button>`,
  ).join("");
  return (
    `<button type="button" class="gear" data-settings-toggle aria-label="Settings" aria-expanded="false" aria-controls="wt-settings">⚙</button>` +
    `<div class="settings" id="wt-settings" role="dialog" aria-label="Settings" hidden>` +
    `<div class="set-h">Theme</div><div class="themes">${themes}</div>` +
    `<div class="set-h">Navigation</div><div class="navopts">` +
    `<button type="button" data-set-nav="pills" aria-pressed="true">Pills</button>` +
    `<button type="button" data-set-nav="sidebar" aria-pressed="false">Sidebar</button>` +
    `</div></div>`
  );
}

export interface PageOpts {
  title: string;
  /** Which nav entry is current. */
  active: string;
  body: string;
  /** Poll interval. Omitted for `report`, whose output is a file and never polls. */
  pollSeconds?: number;
  footer?: string;
  /** Nav entries. Defaults to the server's routes; `report` passes in-page anchors. */
  nav?: NavItem[];
  /** The tool row's links. Defaults to the served routes; `report` passes in-page anchors. */
  tools?: ToolLink[];
}

export function page(opts: PageOpts): string {
  return `<!doctype html>
<html lang="en" data-theme="amber" data-nav="pills">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<script>${headScript()}</script>
<style>${themeCss()}${LAYOUT_CSS}</style>
</head>
<body>
<div class="aurora" aria-hidden="true"></div>
<div class="shell">
<div class="rail">
<header class="top"><span class="brand">${crestMark()}WATCHTOWER</span>${toolRow(opts.active, opts.tools ?? TOOLS)}${settingsPanel()}</header>
${pageRow(opts.nav ?? NAV, opts.active)}
</div>
<main>${opts.body}</main>
${opts.footer ? `<footer>${esc(opts.footer)}</footer>` : ""}
</div>
<script>${clientScript({ pollSeconds: opts.pollSeconds })}</script>
</body>
</html>`;
}

/** A view as a page of its own: what `serve` returns for the view's route. */
export function viewPage(v: View, opts: { pollSeconds?: number } = {}): string {
  return page({
    title: `Watchtower — ${v.title}`,
    active: v.href,
    body: v.body,
    footer: v.footer,
    pollSeconds: opts.pollSeconds,
  });
}
