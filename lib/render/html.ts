/**
 * Shared helpers for the render layer.
 *
 * Every function here is pure and locale-independent: same input, same string,
 * byte for byte. That is what makes the renderers snapshot-testable, so none of
 * them may reach for `Date.now()`, `Math.random()` or `toLocaleString()`. The
 * time helpers take their zone as an argument; `localZone()` is the default,
 * resolved once where `serve` and `report` start.
 */

/** Escape text for HTML. Repo names, event names and session ids all come from disk. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A fixed-decimal number. Explicitly not locale-aware. */
export function num(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

/** 1,234,567 — grouped with a plain comma, independent of locale. */
export function grouped(n: number): string {
  const [whole, frac] = Math.abs(n).toFixed(0).split(".");
  const withSeps = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${withSeps}${frac ? `.${frac}` : ""}`;
}

/** 1.2k / 3.4M / 6.1B, for figures where the exact digit count is noise. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

/** 3h 07m / 7m 12s / 41s. Whole units only; no rounding up into a lie. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * A measured span in milliseconds: "850 ms", "5.3 s", then {@link duration}'s
 * "2m 05s" past a minute. For response times and turn waits, which the
 * rollup stores in ms; a caller says "no reading" for a null itself.
 */
export function millis(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return duration(ms / 1000);
}

/**
 * The zone this process formats in when a renderer is not told one: what
 * `TZ` says, else the machine's. It is also the zone the readers' `sqlite3`
 * child buckets `'localtime'` days in, so a time printed with it falls on the
 * day it is bucketed under. Resolved once where `serve` and `report` start
 * and passed down, so the renderers stay pure functions of their input.
 */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * Epoch seconds -> wall-clock parts in `tz`. A fixed locale (`en-CA`, 24-hour)
 * and an explicit zone: the same input and zone give the same string on any
 * machine, which is what keeps the renderers snapshot-testable.
 */
function wall(ts: number, tz: string): { date: string; time: string; zone: string } {
  let f = FORMATS.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
    });
    FORMATS.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts * 1000))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, zone: p.timeZoneName ?? tz };
}

/** Epoch seconds -> "HH:MM:SS", local to `tz`. The page names the zone once, in its footer. */
export function clock(ts: number, tz: string = localZone()): string {
  return wall(ts, tz).time;
}

/** Epoch seconds -> "YYYY-MM-DD", the local date in `tz`. */
export function dateIn(ts: number, tz: string = localZone()): string {
  return wall(ts, tz).date;
}

/** Epoch seconds -> "YYYY-MM-DD HH:MM:SS PDT": local to `tz`, with the zone's abbreviation where `Z` used to be. */
export function stamp(ts: number, tz: string = localZone()): string {
  const w = wall(ts, tz);
  return `${w.date} ${w.time} ${w.zone}`;
}

/**
 * Epoch seconds -> "YYYY-MM-DD HH:MM" local to `tz`, with no zone: for a table
 * cell, where the zone is named once in the page's footer and a suffix on
 * every row pushed the table past its card.
 */
export function minute(ts: number, tz: string = localZone()): string {
  const w = wall(ts, tz);
  return `${w.date} ${w.time.slice(0, 5)}`;
}

/** "America/Los_Angeles (PDT)": the zone a page's times are in, for its footer. */
export function zoneNote(tz: string, ts: number): string {
  const z = wall(ts, tz).zone;
  return z === tz ? tz : `${tz} (${z})`;
}
