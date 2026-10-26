/**
 * The Usage Profile view: the 6-tier ladder, the 3-tier Matrix hygiene
 * score, and the ten discipline cards, in that order, then the total over
 * time (spec §5).
 *
 * Every number here already arrived scored from `capture/rollup.sh` (via
 * lib/read/profile.ts) -- this file only labels, formats and lays it out.
 * tests/capture-scripts.test.ts greps every file under `lib/` for spec 4.2-4.4's
 * scoring thresholds (the context, session-length, compaction and routing
 * literals) and fails the build if one appears; the tier boundaries printed
 * here (45, 75, 100, ...) are labels, not that guard's targets.
 *
 * Discipline labels, blurbs and tier copy are held here as labels. Only
 * existing primitives are used: `card`, `areaChart`, and the `.meter`
 * progress-bar markup History's rank ladder and Live's rank card already use
 * -- no new chart type.
 */
import type { DisciplineId, DisciplineRow, DisciplineStatus, ProfileData, ProfileDay } from "../read/profile.ts";
import { DISCIPLINE_ORDER } from "../read/profile.ts";
import { bucketName, buckets, meanOf, rangeLabel } from "../read/range.ts";
import { areaChart } from "./charts.ts";
import { CC_FIGURE, usd } from "./cost.ts";
import { esc, grouped, num } from "./html.ts";
import { card, viewPage, type View } from "./layout.ts";

const COLLECTING_TEXT = "collecting — fewer than 20 requests in the last 30 days";

/** The six ladder tiers, index 0..5. */
const LADDER_TIERS: readonly { label: string; description: string }[] = [
  {
    label: "Noobie",
    description:
      "Just getting started. You're driving Claude Code, but habits like lean context, verification, and routing are still forming.",
  },
  {
    label: "Explorer",
    description:
      "Finding your footing. A few good habits are showing up — keep tightening context and start verifying and routing deliberately.",
  },
  {
    label: "Practitioner",
    description:
      "Solid, consistent usage. You compact, keep context in check, and verify work — with room to systematize and automate more.",
  },
  {
    label: "Operator",
    description:
      "Running Claude Code like a pro. Good hygiene across the board, deliberate model routing, and safe defaults are the norm.",
  },
  {
    label: "Architect",
    description:
      "Engineering your workflow. Automation, reuse, and verification are baked in; you get a lot done per token, safely.",
  },
  {
    label: "Master",
    description:
      "Textbook AI discipline. Lean context, timely compaction, deliberate routing, automation, reuse, and airtight safety — the full picture.",
  },
];

/** The 3-tier Matrix hygiene tiers, index 0..2. */
const MATRIX_TIERS: readonly { name: string; blurb: string }[] = [
  {
    name: "Coppertop",
    blurb:
      "Plugged in and feeding the machine. Marathon sessions, context that balloons to hundreds of thousands of tokens per turn, and /compact barely gets touched.",
  },
  {
    name: "Operator",
    blurb:
      "Awakened. Solid session hygiene — you compact sometimes and keep context in check — with room to tighten up before you bend the rules entirely.",
  },
  {
    name: "The One",
    blurb: "You bend the token economy to your will. Lean context, timely compaction, and high token efficiency — textbook session hygiene.",
  },
];

/** The discipline labels and blurbs, by id. */
const DISCIPLINE_META: Record<DisciplineId, { label: string; blurb: string }> = {
  "prompt-hygiene": {
    label: "Prompt hygiene",
    blurb: "Structured, reasoned prompts and reusable commands over one-shot asks (a proxy — raw prompt text isn't recorded).",
  },
  "context-hygiene": {
    label: "Context hygiene",
    blurb: "Keeping the context re-read each turn lean — lower context/turn is better.",
  },
  "session-hygiene": {
    label: "Session hygiene",
    blurb: "Focused sessions and timely compaction instead of one endless marathon thread.",
  },
  "model-routing": {
    label: "Model routing discipline",
    blurb: "Routing cheaper models for routine work instead of one top tier for everything.",
  },
  "cost-discipline": {
    label: "Cost discipline",
    blurb: "Efficient token use — not letting cache re-reads balloon relative to real work.",
  },
  verification: {
    label: "Verification discipline",
    blurb: "Reading and checking code, and keeping tool errors low, rather than acting blind.",
  },
  automation: {
    label: "Automation discipline",
    blurb: "Offloading repeatable work to headless runs, agents, and MCP tools.",
  },
  reuse: {
    label: "Reuse & systematization",
    blurb: "Reusing commands, MCP servers, and saved analyses instead of reinventing each time.",
  },
  security: {
    label: "Security & privacy discipline",
    blurb: "Keeping risky capabilities off by default and sending writes through the approval gate.",
  },
  "output-quality": {
    label: "Output quality discipline",
    blurb: "High request success and low tool-error rates — clean runs instead of retries.",
  },
};

const STATUS_LABEL: Record<DisciplineStatus, string> = {
  "needs-data": "needs data",
  "needs-work": "needs work",
  ok: "ok",
  strong: "strong",
};

/**
 * A status is a WORD first (Review Focus: never colour alone); the class only
 * tints it. Colour-only classes, all four: `.muted` is a TYPOGRAPHY class
 * (11 px secondary text), and on "ok" it made one status smaller and dimmer
 * than the other three.
 */
const STATUS_CLASS: Record<DisciplineStatus, string> = {
  "needs-data": "absent",
  "needs-work": "warn",
  ok: "status-ok",
  strong: "health-ok",
};

/** A discipline's display name, or its id when it has none (the Attributes card's evidence). */
export const disciplineLabel = (id: string): string => DISCIPLINE_META[id as DisciplineId]?.label ?? id;

/** Disciplines whose every part needs main-thread tool/slash data (spec 4.4's †). */
const TOOL_DERIVED: ReadonlySet<DisciplineId> = new Set(["prompt-hygiene", "verification", "reuse"]);

/** Whether the scored window is covered by hook events (spec 4B §4.5), and when they start. */
export interface EventCoverage {
  covered: boolean;
  /** The local day of the first hook event; null with none at all. */
  start: string | null;
}

/** "hook data starts 2026-07-04", or "no hook data yet" with no hook event at all. */
function hookDataText(start: string | null): string {
  return start === null ? "no hook data yet" : `hook data starts ${start}`;
}

/**
 * Why a needs-data discipline has nothing: tool-derived disciplines point at
 * tool coverage (spec 3.3) -- unless the window IS covered and simply holds no
 * tool call (evidence `tool_calls` is a measured 0, not NULL), which is not a
 * coverage problem at all; security, in a window that begins before the hook
 * data does, points at when it starts (spec 4B §4.5); the rest name their own
 * missing input. Exported so the mapping is directly testable without a full
 * page render.
 */
export function needsDataText(
  id: DisciplineId,
  coverageStart: string | null,
  evidence: Record<string, number | string | null> = {},
  event?: EventCoverage,
): string {
  if (TOOL_DERIVED.has(id)) {
    if (evidence.tool_calls === 0) return "no tool calls in this window";
    return coverageStart === null ? "no tool data yet" : `tool data starts ${coverageStart}`;
  }
  if (id === "context-hygiene") return "no session data recorded in this window";
  if (id === "security") {
    if (event !== undefined && !event.covered) return hookDataText(event.start);
    return "no prompts recorded with a permission mode in this window";
  }
  return "not enough usage data in this window yet";
}

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const dash = `<b class="absent">—</b>`;

/**
 * A kv value with a muted note, as ONE element: `.kv` spaces its children
 * apart, so a bare `<b>` + `<span>` pair made three children and floated the
 * value mid-row with its note pushed right.
 */
function kvValue(value: string, note: string | null): string {
  return `<span>${value}${note === null ? "" : ` <span class="muted">· ${esc(note)}</span>`}</span>`;
}

/** One Matrix factor: its 0-100 score and, when there is one, the raw input behind it. */
function factorRow(label: string, factor: number | null, input: string | null): string {
  return kv(label, factor === null ? dash : kvValue(`<b>${factor}/100</b>`, input));
}

/** "+24" / "-6" / "0": grouped's own minus sign covers the negative case. */
function signed(n: number): string {
  return n > 0 ? `+${grouped(n)}` : grouped(n);
}

function pctFmt(v: number | string | null): string {
  return typeof v === "number" ? `${Math.round(v * 100)}%` : "not measured";
}

function meter(value: number, max: number): string {
  const pct = max > 0 ? (100 * Math.max(0, value)) / max : 0;
  return `<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${num(value, 0)}"><i style="width:${num(pct, 1)}%"></i></div>`;
}

/** Which day the cards score, and over what: every card is that day's rolling 30-day window. */
function asOf(day: string): string {
  return `<p class="muted label">as of ${esc(day)} · rolling 30 days</p>`;
}

/** A day is gated (or unmeasured entirely) when there is no total to show. */
function isGated(d: ProfileData): boolean {
  return d.latest === null || d.latest.total === null;
}

function ladderCard(d: ProfileData): string {
  const latest = d.latest;
  if (latest === null) {
    return card({ title: "Usage ladder", hero: true, body: `<div class="big absent">—</div><div class="muted label">no usage recorded yet</div>` });
  }
  if (latest.total === null) {
    return card({ title: "Usage ladder", hero: true, body: `<div class="state absent">${esc(COLLECTING_TEXT)}</div>` + asOf(latest.day) });
  }
  const tier = LADDER_TIERS[latest.tierIndex ?? 0];
  const into = latest.total - (latest.tierIndex ?? 0) * 100;
  const span = latest.tierPointsToNext === null ? into : into + latest.tierPointsToNext;
  const barPct = span > 0 ? (100 * into) / span : 0;
  const measured = latest.measured;
  return card({
    title: "Usage ladder",
    hero: true,
    body:
      `<div class="big rank-name">${esc(tier.label)}</div>` +
      `<p class="muted">${esc(tier.description)}</p>` +
      meter(barPct, 100) +
      `<div class="block">` +
      kv("total", `<b>${grouped(latest.total)} / 600</b>`) +
      (latest.tierPointsToNext === null
        ? kv("points to next tier", `<b>top tier</b>`)
        : kv("points to next tier", `<b>${grouped(latest.tierPointsToNext)}</b>`)) +
      kv("week over week", latest.totalWow === null ? dash : `<b>${signed(latest.totalWow)}</b>`) +
      (measured !== null && measured < 10 ? kv("measured", `<b>${measured} of 10</b>`) : "") +
      `</div>` +
      asOf(latest.day),
  });
}

function matrixCard(d: ProfileData): string {
  const latest = d.latest;
  if (latest === null) {
    return card({ title: "Matrix score", body: `<div class="state absent">no usage recorded yet</div>` });
  }
  // The 20-request gate (latest.total) is the one gate; a NULL matrixScore on
  // an UNGATED day is a narrower, different fact -- no session grouping at
  // all to measure context/session length against (spec 4.3) -- and must not
  // be reported as "collecting" when there plainly were 20+ requests.
  if (latest.total === null) {
    return card({ title: "Matrix score", body: `<div class="state absent">${esc(COLLECTING_TEXT)}</div>` });
  }
  if (latest.matrixScore === null) {
    return card({ title: "Matrix score", body: `<div class="state absent">no session data to score this window</div>` });
  }
  const tier = MATRIX_TIERS[latest.matrixTier ?? 0];
  const f = latest.factors;
  const i = latest.inputs;
  const factorRows = [
    factorRow("context", f.context, i.medianCtx === null ? null : `${grouped(Math.round(i.medianCtx))} median tokens/turn`),
    factorRow(
      "compaction",
      f.compaction,
      i.longSessions === null ? null : `${i.longWithReset ?? 0} of ${i.longSessions} long sessions reset`,
    ),
    factorRow("session length", f.sessionLength, i.medianRequests === null ? null : `${num(i.medianRequests, 1)} median requests/session`),
    factorRow("efficiency", f.efficiency, i.cacheFreshRatio === null ? null : `${num(i.cacheFreshRatio, 1)}x cache:fresh`),
  ].join("");
  // The week over week is a 7-day-vs-7-day delta, so it
  // is shown beside the 7-day score it is a delta OF -- never beside the
  // 30-day score above, where "-6" read as "was 71".
  const sevenDay =
    latest.matrix7d === null
      ? dash
      : kvValue(
          `<b>${latest.matrix7d}</b>`,
          latest.matrixWow === null ? "no prior week to compare" : `${signed(latest.matrixWow)} vs prior week`,
        );
  return card({
    title: "Matrix score",
    body:
      `<div class="big rank-name">${esc(tier.name)}</div>` +
      `<p class="muted">${esc(tier.blurb)}</p>` +
      meter(latest.matrixScore, 100) +
      `<div class="block">` +
      kv("score", `<b>${latest.matrixScore} / 100</b>`) +
      (latest.matrixPointsToNext === null
        ? kv("points to next tier", `<b>top tier</b>`)
        : kv("points to next tier", `<b>${grouped(latest.matrixPointsToNext)}</b>`)) +
      kv("7-day score", sevenDay) +
      `</div>` +
      `<div class="block">${factorRows}</div>`,
  });
}

/** Sentences behind a score. A null value reads "not measured", never 0. */
function evidenceLines(id: DisciplineId, e: Record<string, number | string | null>, event?: EventCoverage): string[] {
  const n = (k: string): number | null => (typeof e[k] === "number" ? (e[k] as number) : null);
  const s = (k: string): string | null => (typeof e[k] === "string" ? (e[k] as string) : null);
  switch (id) {
    case "prompt-hygiene": {
      const k = n("slash_kinds");
      return [k === null ? "distinct slash commands: not measured" : `${k} distinct slash ${k === 1 ? "command" : "commands"} in use`];
    }
    case "context-hygiene": {
      const ctx = n("median_ctx");
      const factor = n("factor");
      return [
        ctx === null ? "median context: not measured" : `${grouped(Math.round(ctx))} tokens/turn, median`,
        factor === null ? "context leanness: not measured" : `context leanness scores ${factor}/100`,
      ];
    }
    case "session-hygiene": {
      const sess = n("f_session_length");
      const comp = n("f_compaction");
      const longS = n("long_sessions");
      const longR = n("long_with_reset");
      const compactions = n("compactions");
      return [
        sess === null ? "session focus: not measured" : `session focus ${sess}/100`,
        comp === null
          ? "compaction discipline: not measured"
          : `compaction discipline ${comp}/100${longS === null ? "" : ` (${longR ?? 0} of ${longS} long sessions reset)`}`,
        compactions === null
          ? `compactions: not measured${event !== undefined && !event.covered ? ` · ${hookDataText(event.start)}` : ""}`
          : `${compactions} measured ${compactions === 1 ? "compaction" : "compactions"}`,
      ];
    }
    case "model-routing": {
      const models = n("models");
      const top = s("top_model");
      const topPct = n("top_pct");
      return [
        models === null ? "models in the mix: not measured" : `${models} ${models === 1 ? "model" : "models"} in the mix`,
        topPct === null ? "top model share: not measured" : `${top ?? "the top model"} is ${topPct}% of requests`,
      ];
    }
    case "cost-discipline": {
      const factor = n("factor");
      const cost = n("cost_per_session");
      return [
        factor === null ? "token efficiency: not measured" : `token efficiency ${factor}/100 (cache vs. fresh work)`,
        cost === null ? "cost/session: not measured" : `~${usd(cost)}/session · ${CC_FIGURE}`,
      ];
    }
    case "verification": {
      const calls = n("tool_calls");
      const insp = n("inspect_share");
      const err = n("tool_error_rate");
      return [
        calls === null ? "tool calls: not measured" : `${grouped(calls)} tool ${calls === 1 ? "call" : "calls"}`,
        insp === null ? "inspection share: not measured" : `${pctFmt(insp)} of tool calls inspect code (Read/Grep/Glob)`,
        err === null ? "tool-error rate: not measured" : `${pctFmt(err)} tool-error rate`,
      ];
    }
    case "automation": {
      const headless = n("headless_sessions");
      const sub = n("subagent_launches");
      const mcp = n("mcp_calls");
      return [
        headless === null ? "headless sessions: not measured" : `${headless} headless ${headless === 1 ? "session" : "sessions"}`,
        sub === null ? "subagent launches: not measured" : `${sub} subagent ${sub === 1 ? "launch" : "launches"}`,
        mcp === null ? "MCP tool calls: not measured" : `${grouped(mcp)} MCP tool ${mcp === 1 ? "call" : "calls"}`,
      ];
    }
    case "reuse": {
      const repeat = n("slash_max_repeat");
      const top = s("top_command");
      const servers = n("mcp_servers");
      return [
        repeat === null ? "most-used command: not measured" : `most-used command run ${repeat}×${top === null ? "" : ` (${top})`}`,
        servers === null ? "MCP servers: not measured" : `${servers} MCP ${servers === 1 ? "server" : "servers"} wired up`,
      ];
    }
    case "security": {
      const withMode = n("prompts_with_mode");
      const bypass = n("bypass_prompts");
      const share = n("bypass_share");
      return [
        withMode === null
          ? "prompts with a permission mode: not measured"
          : `${withMode} ${withMode === 1 ? "prompt" : "prompts"} carried a permission mode`,
        share === null
          ? "bypass share: not measured"
          : `${pctFmt(share)} ran in bypassPermissions (${bypass ?? 0} of ${withMode ?? 0})`,
      ];
    }
    case "output-quality": {
      const reqs = n("requests");
      const errs = n("api_errors");
      const success = n("success");
      const toolErr = n("tool_error_rate");
      return [
        success === null
          ? "request success rate: not measured"
          : `${pctFmt(success)} request success rate${reqs === null ? "" : ` (${grouped(reqs)} requests, ${errs ?? 0} errors)`}`,
        toolErr === null ? "tool-error rate: not measured" : `${pctFmt(toolErr)} tool-error rate`,
      ];
    }
  }
}

function disciplineCard(row: DisciplineRow, coverageStart: string | null, event: EventCoverage): string {
  const meta = DISCIPLINE_META[row.id];
  const lines = evidenceLines(row.id, row.evidence, event);
  const needsData = row.status === "needs-data";
  const missing = needsData ? `<p class="muted label">${esc(needsDataText(row.id, coverageStart, row.evidence, event))}</p>` : "";
  // The 0-60 number beside the word, so the ten visibly sum to the total. A
  // needs-data score is stored as 0 (it counts 0 toward the total) but
  // nothing measured it: a dash, never a fabricated 0.
  const outOf = `<span class="muted">· ${needsData ? "—" : row.score} / 60</span>`;
  return card({
    title: meta.label,
    body:
      meter(row.score, 60) +
      `<div class="split"><span><span class="${STATUS_CLASS[row.status]}">${esc(STATUS_LABEL[row.status])}</span> ${outOf}</span></div>` +
      `<p class="muted label">${esc(meta.blurb)}</p>` +
      `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` +
      missing,
  });
}

function disciplineSections(d: ProfileData): string[] {
  if (isGated(d)) {
    return [
      card({
        title: "Disciplines",
        wide: true,
        body: `<div class="state absent">${esc(d.latest === null ? "no usage recorded yet" : COLLECTING_TEXT)}</div>`,
      }),
    ];
  }
  const byId = new Map(d.disciplines.map((r) => [r.id, r]));
  const cards = DISCIPLINE_ORDER.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [disciplineCard(row, d.coverageStart, { covered: d.eventCovered, start: d.eventStart })];
  });
  const rows: string[] = [];
  for (let i = 0; i < cards.length; i += 2) {
    rows.push(`<div class="g g-2">`, cards[i], cards[i + 1] ?? "", `</div>`);
  }
  return rows;
}

/**
 * Past 90 days, one point per ISO week (the mean of that week's scored days),
 * the same rule History's hygiene chart uses -- otherwise `all` grows the
 * report by a day's worth of marks every day forever (Stage 3D fix wave, I4).
 */
function historyCard(d: ProfileData): string {
  const byDay = new Map(d.history.map((h) => [h.day, h.total]));
  const b = buckets(d.history.map((h) => h.day));
  const points = !b.weekly
    ? d.history.map((h) => ({ label: h.day, value: h.total }))
    : b.buckets.map((k) => {
        const m = meanOf(k.days.map((day) => byDay.get(day)));
        return m === null
          ? { label: k.label, value: null }
          : {
              label: k.label,
              value: m.mean,
              title: `${bucketName(k)}: ${num(m.mean, 0)} mean over ${m.of} scored ${m.of === 1 ? "day" : "days"}`,
            };
      });
  return card({
    title: "Total over time",
    wide: true,
    body: areaChart({
      points,
      label: b.weekly
        ? `weekly total, the mean of each week's scored days, out of 600 · ${rangeLabel(d.range)}`
        : `daily total, out of 600 · ${rangeLabel(d.range)}`,
      yMax: 600,
      emptyText: `no scored days ${d.range === "all" ? "at all" : `in the ${rangeLabel(d.range)}`}`,
    }),
  });
}

export function profileSections(d: ProfileData): string[] {
  return [`<div class="g g-2">`, ladderCard(d), matrixCard(d), `</div>`, ...disciplineSections(d), historyCard(d)];
}

export function profileView(d: ProfileData): View {
  const sections = profileSections(d);
  return {
    href: "/profile",
    title: "Usage Profile",
    body: sections.join(""),
    sections,
    footer:
      `days are local, as the rollup buckets them · scores follow a ten-discipline, 600-point model and a 3-tier Matrix ` +
      `hygiene score · a score with no measurement behind it never fabricates one`,
  };
}

export function renderProfilePage(d: ProfileData): string {
  return viewPage(profileView(d));
}
