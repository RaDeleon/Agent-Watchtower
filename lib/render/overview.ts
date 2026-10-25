/**
 * The Overview view (spec §5). Two cost bases, kept apart: "at API prices"
 * (Claude Code + Codex) and Hermes's figure beside it. OpenViking is memory:
 * shown, never counted in a total.
 */
import { AGENT_LABEL } from "../read/level.ts";
import type { OverviewData, OverviewDay, ToolSummary } from "../read/overview.ts";
import { buckets, bucketName, rangeLabel } from "../read/range.ts";
import { characterHref } from "./character.ts";
import { stackedBar } from "./charts.ts";
import { API_PRICES, apiCostBold, HERMES_FIGURE, hermesCostBold } from "./cost.ts";
import {
  AUTOMATED_ONLY, dataAsOf, firstSyncFailed, MEMORY_CAPTION, NO_DRIVEN_HOURS, NO_OPENVIKING, NO_REQUESTS, NOT_SYNCED,
  ROLLUP_PENDING, unreachableAt,
} from "./empty.ts";
import { compact, duration, esc, grouped, localZone, minute, num, stamp, zoneNote } from "./html.ts";
import { card, type View } from "./layout.ts";
import { levelBlock } from "./level.ts";

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;

function hoursFigure(t: ToolSummary): string {
  if (t.activeS !== null) return `<b>${num(t.activeS / 3600, 1)}h</b>`;
  if (t.requests !== null && t.requests > 0 && (t.sessions?.driven ?? 0) === 0) return absent(AUTOMATED_ONLY);
  return absent(NO_DRIVEN_HOURS);
}

function toolCard(t: ToolSummary, tz: string, served: boolean): string {
  if (t.status.state === "failed") {
    return card({ title: t.label, body: `<div class="state absent">${esc(firstSyncFailed(t.status.lastError))}</div>` });
  }
  if (t.status.state === "not-synced") {
    return card({ title: t.label, body: `<div class="state absent">${esc(NOT_SYNCED)}</div>` });
  }
  const more = `<p class="note"><a href="${esc(characterHref(t.source, served))}">Skills, pace and level-ups →</a></p>`;
  const pending = t.requests === null && t.status.state === "synced";
  const asOf = t.status.state === "synced" && t.status.degraded
    ? `<p class="note">${esc(dataAsOf(stamp(t.status.lastOkAt, tz)))}</p>` : "";
  if (pending) {
    return card({ title: t.label, body: levelBlock(t.level, t.source) + more + `<div class="state absent">${esc(ROLLUP_PENDING)}</div>` + asOf });
  }
  const sessions = t.sessions === null ? absent("—")
    : t.sessions.driven === null ? `<b>${grouped(t.sessions.total)}</b>`
    : `<b>${grouped(t.sessions.driven)} driven · ${grouped(t.sessions.automated ?? 0)} automated</b>`;
  const cost = t.source === "hermes" ? kv(HERMES_FIGURE, hermesCostBold(t.hermesCost)) : kv(API_PRICES, apiCostBold(t.apiCost));
  const facts = [
    kv("active hours", hoursFigure(t)),
    kv("sessions", sessions),
    kv("requests", t.requests === null || t.requests === 0 ? absent(NO_REQUESTS) : `<b>${grouped(t.requests)}</b>`),
    kv("tokens in + out", t.tokens === null ? absent("—") : `<b>${compact(t.tokens.in + t.tokens.out)}</b>`),
    cost,
  ].join("");
  return card({ title: t.label, body: levelBlock(t.level, t.source) + more + `<div class="block">${facts}</div>` + asOf });
}

function totalsCard(d: OverviewData): string {
  const total = d.totalLevel === null ? `<div class="big absent">—</div>` : `<div class="big">${d.totalLevel}</div>`;
  return card({
    title: "Total level",
    body: total + `<div class="muted label">summed over the tools with a level</div>` +
      `<div class="block">${kv("Max Cape", d.maxCape === null ? `<b class="absent">pending</b>` : `<b>${d.maxCape.reached} of ${d.maxCape.of} tools at ${d.maxCape.at}+</b>`)}</div>`,
  });
}

function costCard(d: OverviewData): string {
  const hermes = d.tools.some((t) => t.source === "hermes")
    ? kv(HERMES_FIGURE, hermesCostBold(d.hermesCost)) : "";
  return card({
    title: "Cost",
    body: kv(`${API_PRICES} · Claude Code + Codex`, apiCostBold(d.apiCost)) + hermes +
      `<p class="note">Hermes's figure is Hermes's own record of what it spent. It is shown beside the API-price figure, never added into it.</p>`,
  });
}

function dailyCard(d: OverviewData): string {
  const shown = d.tools.map((t) => t.source);
  const series = shown.map((s) => AGENT_LABEL[s]);
  const pick = (x: OverviewDay, s: string): number =>
    (s === "claude" ? x.claudeS : s === "codex" ? x.codexS : x.hermesS) ?? 0;
  const byDay = new Map(d.daily.map((x) => [x.day, x]));
  const { buckets: bs } = buckets(d.daily.map((x) => x.day));
  const columns = bs.map((b) => {
    const parts = shown.map((s) => b.days.reduce((a, day) => a + pick(byDay.get(day) as OverviewDay, s), 0) / 3600);
    return { label: b.label, parts, title: `${bucketName(b)}: ${parts.map((p, i) => `${series[i]} ${num(p, 1)}h`).join(" · ")}` };
  });
  return card({
    title: `Active hours by tool · ${rangeLabel(d.range)}`, wide: true,
    body: stackedBar({ columns, series, label: "active hours by tool", format: (v) => `${num(v, 1)}h`, emptyText: "no active hours in this range" }),
  });
}

function openVikingCard(d: OverviewData, tz: string): string {
  const o = d.openviking;
  const caption = `<div class="muted label">${esc(MEMORY_CAPTION)}</div>`;
  if (o.state === "absent") return card({ title: "OpenViking", body: caption + `<div class="state absent">${esc(NO_OPENVIKING)}</div>` });
  const head = o.reachable
    ? `<div class="state">Reachable at last sync (${esc(minute(o.checkedAt, tz))})</div>`
    : `<div class="state absent">${esc(unreachableAt(minute(o.checkedAt, tz)))}</div>`;
  const ago = (at: number) => `${duration(d.generatedAt - at)} ago`;
  const recall = o.recall === null ? kv("last recall", absent("none recorded"))
    : kv("last recall", `<b>${o.recall.count === null ? "—" : grouped(o.recall.count)} items · ${o.recall.latencyMs === null ? "—" : `${grouped(o.recall.latencyMs)} ms`} · ${o.recall.tokens === null ? "—" : compact(o.recall.tokens)} tokens, ${esc(ago(o.recall.at))}</b>`);
  const capture = o.capture === null ? kv("last capture", absent("none recorded"))
    : kv("last capture", `<b>${o.capture.turns === null ? "—" : grouped(o.capture.turns)} turns${o.capture.committed === true ? ", committed" : ""}, ${esc(ago(o.capture.at))}</b>`);
  return card({ title: "OpenViking", body: caption + head + `<div class="block">${recall}${capture}</div>` });
}

export function overviewSections(d: OverviewData, tz: string, served: boolean): string[] {
  return [
    `<div class="g g-2">`, ...d.tools.map((t) => toolCard(t, tz, served)), `</div>`,
    `<div class="g g-2">`, totalsCard(d), costCard(d), `</div>`,
    dailyCard(d),
    openVikingCard(d, tz),
  ];
}

export function overviewView(d: OverviewData, opts: { tz?: string; served?: boolean } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = overviewSections(d, tz, opts.served === true);
  return {
    href: "/overview",
    title: "Overview",
    body: sections.join(""),
    sections,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · days are local, ${zoneNote(tz, d.generatedAt)} · ` +
      `from claude_daily_rollups, agent_daily_rollups, agent_progress and wt_* · hours count driven sessions only`,
  };
}
