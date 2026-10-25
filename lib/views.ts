/**
 * The views that describe days rather than seconds, as one table that both
 * entry points walk: `serve` answers each `href` with the view as a page, and
 * `report` stacks every one of them into a single file.
 *
 * That shared table is the whole of "two entry points, one renderer". A view
 * added here appears in both; a view that exists in only one of them has to be
 * written around this table on purpose.
 *
 * Live is deliberately not here. It is served at `/` and polled, and `report`
 * omits it: a frozen gauge reads as current.
 *
 * A `ranged` view covers a time span (spec §4.5). Served, it is built for the
 * one range in the query and gets link pills above it. In the report it is
 * built once per range, with toggle pills flipping between the ranges -- the
 * file has no server to ask. A piece of the body that is the same in every
 * range (a lifetime card) is carried once; only the pieces that differ are
 * repeated per range, each run in its own `data-range` blocks (report.ts).
 */
import { readAgent } from "./read/agent.ts";
import { readOverview } from "./read/overview.ts";
import { readCharacter } from "./read/character.ts";
import { readHistory } from "./read/history.ts";
import { readPerformance } from "./read/perf.ts";
import { readProfile } from "./read/profile.ts";
import { DEFAULT_RANGE, RANGES, type Range } from "./read/range.ts";
import { readProjects } from "./read/projects.ts";
import { readQuests } from "./read/quests.ts";
import { readSessions } from "./read/sessions.ts";
import { readSkills } from "./read/skills.ts";
import { readSources, type ConfiguredSource } from "./read/sources.ts";
import { rangePills } from "./render/charts.ts";
import { agentView } from "./render/agent.ts";
import { characterView } from "./render/character.ts";
import { historyView } from "./render/history.ts";
import { localZone } from "./render/html.ts";
import { viewPage, type View } from "./render/layout.ts";
import { overviewView } from "./render/overview.ts";
import { performanceView } from "./render/perf.ts";
import { profileView } from "./render/profile.ts";
import { questsView } from "./render/quests.ts";
import { rangeBlocks, renderReport } from "./render/report.ts";
import { projectsView } from "./render/projects.ts";
import { sessionsView } from "./render/sessions.ts";
import { skillsView } from "./render/skills.ts";
import { sourcesView } from "./render/sources.ts";

export interface ViewContext {
  db: string;
  /** Epoch seconds. Injected, so a test can pin a fixture's clock. */
  now: number;
  /** Sources named in config, for the Sources view's enabled column. */
  configured?: Record<string, ConfiguredSource>;
  /** The span a ranged view covers. Only ever a parsed `Range`, never the raw query. */
  range: Range;
  /**
   * A project filter, for views that take one (Sessions). Raw query text: the
   * reader matches it against the projects on record and uses it only if it
   * names one, and the renderer never echoes one it did not match.
   */
  project?: string;
  /** The zone every time is printed in: resolved once where serve or report starts. */
  tz?: string;
  /**
   * Rendering a page for the server rather than the report: in-page links to
   * other routes (the Sessions project filter) exist only here. The report, a
   * file with no server behind it, leaves this unset.
   */
  served?: boolean;
  /** The home directory tools are looked for under. Tests inject one; default os.homedir(). */
  home?: string;
}

export interface StaticView {
  href: string;
  /** Covers a time span: gets range pills, and one body per range in the report. */
  ranged: boolean;
  build: (ctx: ViewContext) => View;
}

export const STATIC_VIEWS: StaticView[] = [
  { href: "/overview", ranged: true, build: (c) => overviewView(readOverview(c.db, { now: c.now, range: c.range, home: c.home }), { tz: c.tz, served: c.served }) },
  { href: "/character", ranged: false, build: (c) => characterView(readCharacter(c.db, { now: c.now, home: c.home }), { served: c.served, tz: c.tz }) },
  { href: "/quests", ranged: false, build: (c) => questsView(readQuests(c.db, { now: c.now }), { served: c.served, tz: c.tz }) },
  { href: "/history", ranged: true, build: (c) => historyView(readHistory(c.db, { now: c.now, range: c.range }), { tz: c.tz }) },
  { href: "/projects", ranged: true, build: (c) => projectsView(readProjects(c.db, { now: c.now, range: c.range }), { served: c.served, tz: c.tz }) },
  {
    href: "/sessions",
    ranged: true,
    build: (c) =>
      sessionsView(readSessions(c.db, { now: c.now, range: c.range, project: c.project }), { now: c.now, served: c.served, tz: c.tz }),
  },
  { href: "/skills", ranged: true, build: (c) => skillsView(readSkills(c.db, { now: c.now, range: c.range }), { tz: c.tz }) },
  { href: "/profile", ranged: true, build: (c) => profileView(readProfile(c.db, { now: c.now, range: c.range })) },
  { href: "/performance", ranged: true, build: (c) => performanceView(readPerformance(c.db, { now: c.now, range: c.range }), { served: c.served, tz: c.tz }) },
  { href: "/codex", ranged: true, build: (c) => agentView(readAgent(c.db, "codex", { now: c.now, range: c.range, home: c.home }), { tz: c.tz, served: c.served }) },
  { href: "/hermes", ranged: true, build: (c) => agentView(readAgent(c.db, "hermes", { now: c.now, range: c.range, home: c.home }), { tz: c.tz, served: c.served }) },
  { href: "/sources", ranged: false, build: (c) => sourcesView(readSources(c.db, { now: c.now, configured: c.configured }), { tz: c.tz }) },
];

/** The view at `href` as a page of its own, or null if no static view has that route. */
export function renderStaticRoute(href: string, ctx: ViewContext): string | null {
  const v = STATIC_VIEWS.find((s) => s.href === href);
  if (v === undefined) return null;
  const view = v.build(ctx);
  if (!v.ranged) return viewPage(view);
  const pills = rangePills(ctx.range, "link", (r) => `${href}?range=${r}${view.pillQuery ?? ""}`);
  return viewPage({ ...view, body: pills + view.body });
}

/**
 * The whole static report: every view above, read and rendered in one file --
 * a ranged view once per range. The report has no query string, so it takes
 * no range: each ranged view opens on the default.
 */
export function buildReport(ctx: Omit<ViewContext, "range" | "project" | "served">): string {
  // No filter and no route links: the report shows every project, as text.
  ctx = { db: ctx.db, now: ctx.now, configured: ctx.configured, tz: ctx.tz ?? localZone(), home: ctx.home };
  const views = STATIC_VIEWS.map((v) => {
    if (!v.ranged) return v.build({ ...ctx, range: DEFAULT_RANGE });
    const built = Object.fromEntries(RANGES.map((r) => [r, v.build({ ...ctx, range: r })])) as Record<Range, View>;
    const shown = built[DEFAULT_RANGE];
    const sections = Object.fromEntries(RANGES.map((r) => [r, built[r].sections ?? [built[r].body]])) as Record<Range, string[]>;
    return { ...shown, body: rangeBlocks(sections) };
  });
  return renderReport(views, { generatedAt: ctx.now, tz: ctx.tz });
}
