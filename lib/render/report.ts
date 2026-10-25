/**
 * `watchtower report`: every static view in one self-contained HTML file.
 *
 * It takes the same `View`s the server returns as pages -- built by the same
 * readers and renderers, see lib/views.ts -- and only changes the wrapping:
 * the nav becomes in-page anchors, and there is no poller, because `page()`
 * emits one only when given a poll interval and this never passes one. The
 * file makes no request of any kind: styles are inline, charts are inline SVG,
 * and the one inline script (settings, tooltips, toggles) has no fetch in it.
 */
import { DEFAULT_RANGE, RANGES, type Range } from "../read/range.ts";
import { rangePills } from "./charts.ts";
import { esc, localZone, stamp, zoneNote } from "./html.ts";
import { NAV, page, type View } from "./layout.ts";

/**
 * Spec §4.5 set this at 1 MB; Stage 5 raised it to 2 MB (the user's call,
 * 2026-10-03) once ten pages and four months of history put the live report at
 * 1.21 MB. It is a budget, not a limit -- the file is still written -- but
 * `watchtower report` says so on stderr when it is over, since the size grows
 * with history and nothing else would notice. The per-week pins in
 * tests/report-budget.test.ts are the growth guard.
 */
export const REPORT_BUDGET_BYTES = 2_000_000;

/** The stderr line for a report of `bytes`, or null within `budget`. */
export function budgetWarning(bytes: number, budget: number = REPORT_BUDGET_BYTES): string | null {
  return bytes <= budget
    ? null
    : `watchtower: warning: the report is ${bytes} bytes, over its ${budget}-byte budget (spec §4.5); it was still written`;
}

/** "/skills" -> "skills": the in-page anchor a view is stacked under. */
export function anchorOf(href: string): string {
  return href.replace(/^\//, "") || "live";
}

/**
 * One ranged view, every range of it, for a file with no server behind it.
 *
 * `sections[r]` is the view's body for range `r` as its top-level pieces (a
 * view that does not split its body passes one piece). A piece that is byte
 * for byte the same in all four ranges -- History's calendar, level, drivers
 * and coverage, the Models & Skills leaderboards -- is emitted ONCE, in place.
 * Runs of pieces that differ are emitted as four `data-range` blocks, all but
 * `active` hidden. One row of toggle pills heads the view, and the client
 * flips every block inside this `data-ranges` wrapper only, so two ranged
 * views in one report never flip each other.
 *
 * Nothing is marked "lifetime" by hand: sameness is checked on the rendered
 * bytes, so a piece that does move with the range can never be frozen at one
 * range's value. If the four ranges split into different numbers of pieces,
 * the whole body is repeated per range, as before.
 */
export function rangeBlocks(sections: Record<Range, string[]>, active: Range = DEFAULT_RANGE): string {
  const n = sections[active].length;
  const aligned = RANGES.every((r) => sections[r].length === n);
  const parts = aligned ? sections : (Object.fromEntries(RANGES.map((r) => [r, [sections[r].join("")]])) as Record<Range, string[]>);
  const out: string[] = [];
  let run: Record<Range, string[]> | null = null;
  const flush = () => {
    if (run === null) return;
    const group = run;
    out.push(RANGES.map((r) => `<div data-range="${r}"${r === active ? "" : " hidden"}>${group[r].join("")}</div>`).join(""));
    run = null;
  };
  for (let i = 0; i < parts[active].length; i++) {
    const piece = parts[active][i];
    if (RANGES.every((r) => parts[r][i] === piece)) {
      flush();
      out.push(piece);
      continue;
    }
    if (run === null) run = Object.fromEntries(RANGES.map((r) => [r, [] as string[]])) as Record<Range, string[]>;
    for (const r of RANGES) run[r].push(parts[r][i]);
  }
  flush();
  return `<div class="ranged" data-ranges>${rangePills(active, "toggle", () => "")}${out.join("")}</div>`;
}

/**
 * The report's times are printed in `tz`, fixed when it is generated: its day
 * buckets are already fixed to the generating machine's zone, and converting
 * in the browser would disagree with them when the file is opened elsewhere.
 * The footer names the zone.
 */
export function renderReport(views: View[], opts: { generatedAt: number; tz?: string }): string {
  const tz = opts.tz ?? localZone();
  // The Overview, Character, Codex and Hermes are on the tool row, not the page row.
  const TOOL_ROW = new Set(["/overview", "/character", "/quests", "/codex", "/hermes"]);
  const nav = views.filter((v) => !TOOL_ROW.has(v.href)).map((v) => ({
    href: `#${anchorOf(v.href)}`,
    label: NAV.find((n) => n.href === v.href)?.label ?? v.title,
  }));
  const body = views
    .map((v) =>
      `<article class="view" id="${esc(anchorOf(v.href))}">` +
      `<h1 class="view-title">${esc(v.title)}</h1>${v.body}` +
      `<p class="view-foot">${esc(v.footer)}</p></article>`)
    .join("");
  return page({
    title: `Watchtower report — ${stamp(opts.generatedAt, tz)}`,
    active: "",
    nav,
    tools: [
      { label: "Overview", href: "#overview", cls: "t-overview" },
      { label: "Character", href: "#character", cls: "t-character" },
      { label: "Quests", href: "#quests", cls: "t-quests" },
      { label: "Claude Code", href: "#history", cls: "tool-cc" },
      { label: "Codex", href: "#codex", cls: "t-agent" },
      { label: "Hermes", href: "#hermes", cls: "t-agent" },
    ],
    body,
    footer:
      `static report generated ${stamp(opts.generatedAt, tz)} · every day and time is local to ${zoneNote(tz, opts.generatedAt)}, where it was generated · Live is omitted: rate limits and burn rate describe a moment, ` +
      `and a frozen gauge reads as current · run watchtower serve for the live view`,
  });
}
