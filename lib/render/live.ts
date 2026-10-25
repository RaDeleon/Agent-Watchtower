/**
 * The Live view: limit rings, the current session (the hero), today, this
 * week, rank, and the event ticker.
 *
 * Pure. The page and the JSON poll route render through the same function, so
 * the polled fragment can never drift from the first paint. Every card's body
 * is one `[data-live]` region: the poll swaps a region's contents and leaves
 * the card around it -- and its running border -- alone.
 */
import type { LiveData } from "../read/live.ts";
import { dayBars, progressRing } from "./charts.ts";
import { API_PRICES, CC_FIGURE, apiCostBold, claudeCodeCostBold } from "./cost.ts";
import { clock, compact, duration, esc, grouped, localZone, millis, num, stamp, zoneNote } from "./html.ts";
import { card, page } from "./layout.ts";
import { levelBlock } from "./level.ts";

/**
 * A gauge reading older than this is labelled stale rather than shown as
 * current. Presentation only — it decides a word and a colour, nothing derived.
 * Snapshots are throttled to one per session per 60s, so a quarter of an hour
 * without one means nothing is writing them, not that the limit has not moved.
 */
const STALE_AFTER_SECONDS = 900;

const WEEKDAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * `data-count` for a headline number, only when it is finite. The value is the
 * number exactly as printed (so the count-up lands on the server's text); a
 * null gets no attribute at all and so never counts up from 0.
 */
function count(n: number | null, printed: string): string {
  return n !== null && Number.isFinite(n) ? ` data-count="${esc(printed)}"` : "";
}

/** `compact()`'s digits without its k/M/B suffix: what the count-up animates. */
const digits = (s: string) => s.replace(/[kMB]$/, "");

/** A headline stat: a big number over a muted label. */
function stat(big: string, label: string): string {
  return `<div class="stat">${big}<div class="muted label">${esc(label)}</div></div>`;
}

/** A figure that is genuinely absent renders as an em dash, never as 0. */
function absent(label: string): string {
  return stat(`<div class="big absent">—</div>`, label);
}

/**
 * Usage that exists but has not reached the table being read: the session is
 * running and nothing has rolled it up or ingested it yet. Spec §3C: "usage
 * pending, session in progress" -- never a zero, never "idle".
 */
function pending(label: string): string {
  return `<div class="stat"><div class="state absent pending">usage pending</div><div class="muted label">${esc(label)} · session in progress</div></div>`;
}

/**
 * Name the burn rate's source on the page.
 *
 * `database` only sees what a SessionEnd has already ingested, so during a live
 * session it is minutes behind. Saying which one produced the number is the
 * difference between "you are idle" and "nothing has been ingested yet".
 */
function burnSource(source: "transcript" | "database"): string {
  return source === "transcript" ? " · live" : " · as last ingested";
}

function gaugeSub(ts: number | null, now: number, tz: string): string | undefined {
  if (ts === null) return undefined;
  const age = now - ts;
  return age > STALE_AFTER_SECONDS
    ? `${clock(ts, tz)} · stale (${duration(age)} old)`
    : clock(ts, tz);
}

function limits(d: LiveData, tz: string): string {
  return `<div class="limits">${[
    progressRing({
      pct: d.rateLimits.fiveHour.pct,
      label: "5-hour limit",
      sublabel: gaugeSub(d.rateLimits.fiveHour.ts, d.generatedAt, tz),
      tone: "limit",
    }),
    progressRing({
      pct: d.rateLimits.sevenDay.pct,
      label: "7-day limit",
      sublabel: gaugeSub(d.rateLimits.sevenDay.ts, d.generatedAt, tz),
      tone: "limit",
    }),
  ].join("")}</div>`;
}

/** The burn window as a small area + flowing line. Drawn only when something landed in it. */
function burnSpark(buckets: number[]): string {
  if (buckets.length < 2) return "";
  const max = Math.max(...buckets);
  const scale = max > 0 ? max : 1;
  const x = (i: number) => num((i * 400) / (buckets.length - 1), 1);
  const y = (v: number) => num(44 - (38 * v) / scale, 1);
  const pts = buckets.map((v, i) => `${x(i)} ${y(v)}`);
  return (
    `<svg class="spark-burn" viewBox="0 0 400 48" preserveAspectRatio="none" role="img" aria-label="output tokens per 30 seconds, oldest first">` +
    `<path class="burn-area" d="M${pts.join(" L")} L400 48 L0 48Z"/>` +
    `<path class="burn-line" d="M${pts.join(" L")}"/></svg>`
  );
}

function sessionBody(d: LiveData): string {
  const s = d.session;
  const burn = d.burnRate;
  if (s === null) return `<div class="stats">${absent("no session seen")}</div>`;

  const meta =
    `<div class="sess-meta">${s.active ? `<span class="dot"></span>` : ""}` +
    (s.repo === null ? "" : `<span class="chip">${esc(s.repo)}</span>`) +
    `<span class="sid">${esc(s.sessionId)}</span><span>${s.active ? "running" : "ended"}</span></div>`;

  const cost = s.costUsd === null ? null : num(s.costUsd, 2);
  const out = d.sessionUsage === null ? null : compact(d.sessionUsage.tokensOut);
  const stats = [
    cost === null
      ? absent(`session cost · ${CC_FIGURE} · no reading`)
      : stat(`<div class="big"${count(s.costUsd, cost)}>$${cost}</div>`, `session cost · ${CC_FIGURE}`),
    s.elapsedSeconds === null
      ? absent("elapsed")
      : stat(`<div class="big">${esc(duration(s.elapsedSeconds))}</div>`, s.active ? "elapsed (this launch)" : "since last launch"),
    d.sessionUsage === null || out === null
      ? ""
      : stat(
          `<div class="big"${count(d.sessionUsage.tokensOut, digits(out))}>${out}</div>`,
          `output this session · ${grouped(d.sessionUsage.requests)} req`,
        ),
  ].join("");

  const context =
    s.contextPct === null
      ? `<div class="block"><div class="split muted"><span>Context window</span><b class="absent">—</b></div><div class="muted">context · no reading</div></div>`
      : `<div class="block"><div class="split muted"><span>Context window</span><b>${num(s.contextPct, 1)}<span class="unit">%</span></b></div>` +
        `<div class="meter"><i style="width:${num(Math.min(Math.max(s.contextPct, 0), 100), 1)}%"></i></div></div>`;

  const win = duration(burn.windowSeconds);
  const rate =
    // From the database, "nothing in the window" during a running session
    // only means ingest has not run yet (it runs at SessionEnd).
    burn.tokensPerMin === null && burn.source === "database" && s.active
      ? pending(`burn rate · nothing ingested in ${win}`)
      : burn.tokensPerMin === null
      ? `<div class="stat"><span class="state absent">idle</span><div class="muted label">no requests in ${win}${burnSource(burn.source)}</div></div>`
      : stat(
          `<div class="big"${count(burn.tokensPerMin, digits(compact(burn.tokensPerMin)))}>${compact(burn.tokensPerMin)}<span class="unit"> tok/min</span></div>`,
          `output, last ${win}${burnSource(burn.source)}`,
        ) + burnSpark(burn.buckets);

  return `${meta}<div class="stats">${stats}</div>${context}<div class="block"><div class="muted">Burn rate · last ${win}</div>${rate}</div>`;
}

function todayBody(d: LiveData): string {
  const t = d.today;
  const s = d.session;
  const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
  const dash = `<b class="absent">—</b>`;
  const day = `<div class="muted">${esc(t.day)}</div>`;
  if (t.activeHours === null || t.sessions === null) {
    // No rollup row for today. With a session running, that is usage not yet
    // rolled up; without one, it is simply no reading -- never 0h.
    if (s !== null && s.active) {
      return day + pending("active today") +
        kv("sessions today", `<b class="absent pending">usage pending</b>`) +
        kv("hygiene", `<b class="absent pending">usage pending</b>`);
    }
    return day +
      `<div class="stat"><div class="state absent">—</div><div class="muted label">active today · not rolled up</div></div>` +
      kv("sessions today · not rolled up", dash) +
      kv(`spend · ${CC_FIGURE} · not rolled up`, claudeCodeCostBold(null)) +
      kv(`spend · ${API_PRICES} · not rolled up`, apiCostBold(null)) +
      kv("hygiene · not rolled up", dash);
  }
  const hours = num(t.activeHours, 2);
  return (
    day +
    `<div class="big"${count(t.activeHours, hours)}>${hours}<span class="unit">h active</span></div>` +
    kv("Sessions", `<b>${grouped(t.sessions)}</b>`) +
    // Both cost figures, side by side (spec 4B §5). A day none of whose
    // sessions reported a cost has no reading of Claude Code's figure: the
    // rollup's 0.0 there was never measured (I1).
    kv(`spend · ${CC_FIGURE}`, claudeCodeCostBold(t.costUsd)) +
    kv(`spend · ${API_PRICES}`, apiCostBold(t.apiCost)) +
    (t.hygiene === null ? kv("hygiene (no sessions)", dash) : kv("Hygiene", `<b>${num(t.hygiene, 1)}</b>`)) +
    // Measured turns only: a turn that waited on a person, or ran headless,
    // is not a wait on the model.
    (t.wait.median === null
      ? kv("turn wait · no measured turn", `<b class="absent">no reading</b>`)
      : kv(`turn wait · median of ${grouped(t.wait.n)}`, `<b>${esc(millis(t.wait.median))}</b>`))
  );
}

/** "2025-06-15" -> "Su". UTC arithmetic on a date, so no zone can shift it. */
function weekdayOf(day: string): string {
  const [y, m, dd] = day.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
}

function weekBody(d: LiveData): string {
  const bars = d.week.map((w) => ({
    label: weekdayOf(w.day),
    value: w.activeHours,
    title: w.activeHours === null ? `${w.day} · no data` : `${w.day} · ${num(w.activeHours, 1)}h active`,
  }));
  const streak = d.streak === 0 ? "no current streak" : `${d.streak}-day streak`;
  return (
    dayBars({ bars, label: "active hours, last 7 days · a dashed stub is a day with no data", format: (v) => `${num(v, 1)}h`, highlight: bars.length - 1 }) +
    `<div class="muted">${streak}</div>`
  );
}

function tickerBody(d: LiveData, tz: string): string {
  if (d.events.length === 0) return `<p class="absent">no events recorded</p>`;
  return d.events
    .map((e) => {
      // A run of identical events is one row: "SubagentStop ×12", its span in the tooltip.
      const times = e.count > 1
        ? ` <b class="times" title="${e.count} in a row, ${esc(clock(e.since, tz))} to ${esc(clock(e.ts, tz))}">×${e.count}</b>`
        : "";
      return `<div class="trow"><span>${esc(clock(e.ts, tz))}</span><span class="ev">${esc(e.name)}${times}</span><span>${esc(e.repo ?? "—")}</span></div>`;
    })
    .join("");
}

/** A card whose body is one poll region. */
function region(key: string, title: string, body: string, opts: { hero?: boolean; wide?: boolean } = {}): string {
  return card({ title, body: `<div data-live="${key}">${body}</div>`, ...opts });
}

/** The live panel. Returned both as first paint and as the poll's payload. */
export function renderLivePanel(d: LiveData, opts: { tz?: string } = {}): string {
  const tz = opts.tz ?? localZone();
  return [
    `<div class="g g-top">`,
    region("limits", "Rate limits", limits(d, tz)),
    region("session", "Current session", sessionBody(d), { hero: true }),
    `</div><div class="g g-mid">`,
    region("today", "Today", todayBody(d)),
    region("week", "This week · active hours", weekBody(d)),
    region("level", "Level", levelBlock(d.level, "claude")),
    `</div>`,
    region("events", "Recent events", tickerBody(d, tz), { wide: true }),
  ].join("");
}

/**
 * What the stored tables are as of. Hours, sessions and hygiene only move when
 * a SessionEnd fires the rollup, so a page that showed them without a date
 * would present an eleven-minute-old total as this second's.
 */
function freshnessLine(d: LiveData, tz: string): string {
  // Dated, not just timed: a rollup four days old must not read as today's.
  const at = (ts: number | null) => (ts === null ? "never" : stamp(ts, tz));
  return (
    `generated ${stamp(d.generatedAt, tz)} · times are local, ${zoneNote(tz, d.generatedAt)} · ` +
    `tokens ingested ${at(d.freshness.lastIngest)} · rollup ${at(d.freshness.lastRollup)}` +
    (d.burnRate.source === "transcript" ? " · burn rate read live from the transcript" : "")
  );
}

export function renderLivePage(d: LiveData, opts: { pollSeconds?: number; tz?: string } = {}): string {
  const tz = opts.tz ?? localZone();
  return page({
    title: "Watchtower — Live",
    active: "/",
    body: `<div id="live-root">${renderLivePanel(d, { tz })}</div>`,
    pollSeconds: opts.pollSeconds,
    footer: freshnessLine(d, tz),
  });
}
