/**
 * The Sources view: per telemetry source, what it is and what the last sync
 * recorded -- detected/enabled, adapter version, last ingest, cursor, records
 * written, metrics rejected, malformed records, health, last error.
 *
 * Source-neutral: everything here is `wt_*`. Pure: `serve` and `report` both
 * render through here.
 *
 * Absent is never zero. A source with no ingest row has never been synced; its
 * counters print as "never run", not as a row of zeroes that reads as a clean
 * run.
 */
import type { SourceRow, SourcesData } from "../read/sources.ts";
import { dateIn, duration, esc, grouped, localZone, stamp, zoneNote } from "./html.ts";
import { card, viewPage, type View } from "./layout.ts";

const absent = (text: string, title?: string) =>
  `<span class="absent"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

function ago(ts: number | null, now: number, none: string, tz: string): string {
  if (ts === null) return absent(none);
  const age = now - ts;
  // A clock skewed ahead of the database is a fact to show, not to hide as "0s ago".
  const rel = age < 0 ? `${duration(-age)} in the future` : `${duration(age)} ago`;
  return `${esc(stamp(ts, tz))}<br><span class="absent">${esc(rel)}</span>`;
}

function enabledCell(s: SourceRow): string {
  if (s.enabled === null) return absent("not in config", "config does not name this source, so sync does not run it");
  return s.enabled ? "enabled" : `<span class="stale">disabled</span>`;
}

function detectedCell(s: SourceRow, tz: string): string {
  if (!s.registered) return absent("not detected", "no sync has registered it: a sync registers a source only on a run that detected it");
  return s.firstSeen === null ? "detected" : `detected<br><span class="absent">since ${esc(dateIn(s.firstSeen, tz))}</span>`;
}

function healthCell(s: SourceRow): string {
  if (s.ingest === null) return absent("never run");
  const h = s.ingest.health;
  const cls = h === "ok" ? "health-ok" : h === "degraded" ? "health-degraded" : "absent";
  return `<span class="${cls}">${esc(h)}</span>`;
}

/** A counter that is only meaningful once a run exists. Non-zero trouble is highlighted. */
function counter(s: SourceRow, n: (i: NonNullable<SourceRow["ingest"]>) => number, trouble: boolean): string {
  if (s.ingest === null) return absent("—", "never run");
  const v = n(s.ingest);
  return trouble && v > 0 ? `<span class="warn">${grouped(v)}</span>` : grouped(v);
}

function cursorCell(s: SourceRow): string {
  if (s.ingest === null) return absent("—", "never run");
  return s.ingest.cursor === null
    ? absent("none", "no cursor: sync compares record fingerprints, because Claude rows change in place")
    : `<code>${esc(s.ingest.cursor)}</code>`;
}

function overviewRow(s: SourceRow, now: number, tz: string): string {
  const name = s.label !== null && s.label !== s.source
    ? `${esc(s.label)}<br><span class="absent">${esc(s.source)}</span>`
    : esc(s.source);
  return (
    `<tr><td>${name}</td>` +
    `<td>${s.type === null ? absent("—") : esc(s.type)}</td>` +
    `<td>${detectedCell(s, tz)}</td><td>${enabledCell(s)}</td>` +
    `<td class="num">${s.adapterVersion === null ? absent("—") : `v${s.adapterVersion}`}</td>` +
    `<td>${ago(s.ingest?.lastRunAt ?? null, now, "never", tz)}</td>` +
    `<td>${healthCell(s)}</td>` +
    `<td class="num">${counter(s, (i) => i.recordsWritten, false)}</td>` +
    `<td class="num">${counter(s, (i) => i.metricsRejected, true)}</td>` +
    `<td class="num">${counter(s, (i) => i.malformed, true)}</td>` +
    `<td>${cursorCell(s)}</td></tr>`
  );
}

function authorityText(s: SourceRow): string {
  if (!s.registered) return absent("—");
  if (s.authority === null) return `<span class="warn">unparseable JSON in wt_sources.authority</span>`;
  if (s.authority.length === 0) return absent("owns no metrics");
  return s.authority.map((a) => `${esc(a.kind)}: ${esc(a.metrics.join(", "))}`).join("<br>");
}

function detailSection(s: SourceRow, now: number, tz: string): string {
  const i = s.ingest;
  const h = s.held;
  const kv: [string, string][] = [
    ["type", s.type === null ? absent("unregistered") :
      `${esc(s.type)} · ${s.inActivityTotals ? "counts toward cross-tool activity and spend" : "never counted in activity or spend totals"}`],
    ["capabilities", s.capabilities.length === 0 ? absent("—") : esc(s.capabilities.join(", "))],
    ["owns metrics", authorityText(s)],
    ["last run", ago(i?.lastRunAt ?? null, now, "never", tz)],
    ["last clean run", ago(i?.lastOkAt ?? null, now, i === null ? "never" : "none: every run so far had a malformed record", tz)],
    ["last error", i === null || i.lastError === null ? absent("none recorded") : `<code>${esc(i.lastError)}</code>`],
    ["held now", s.registered || i !== null
      ? `${grouped(h.requests)} requests · ${grouped(h.events)} events · ${grouped(h.tools)} tool calls · ` +
        `${grouped(h.usage)} usage rows · ${grouped(h.sessions)} sessions first seen here · ${grouped(h.fingerprints)} fingerprints`
      : absent("nothing")],
  ];
  return card({
    title: `${s.label ?? s.source} · ${s.source}`,
    body: `<dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`,
  });
}

export function renderSourcesBody(d: SourcesData, opts: { tz?: string } = {}): string {
  const now = d.generatedAt;
  const tz = opts.tz ?? localZone();
  const unsynced = d.synced ? "" :
    `<p class="note"><span class="stale">This database has no wt_* tables:</span> <code>watchtower sync</code> has never run against it. ` +
    `Nothing below has been recorded yet. The other views read claude_* directly and are unaffected.</p>`;
  const table = d.sources.length === 0
    ? `<div class="chart-empty"><div class="empty-msg">no sources configured or registered</div></div>`
    : `<table class="sources"><thead><tr><th>source</th><th>type</th><th>detected</th><th>config</th>` +
      `<th class="num">adapter</th><th>last ingest</th><th>health</th><th class="num">records written</th>` +
      `<th class="num">metrics rejected</th><th class="num">malformed</th><th>cursor</th></tr></thead>` +
      `<tbody>${d.sources.map((s) => overviewRow(s, now, tz)).join("")}</tbody></table>`;
  const overview = card({
    title: "Sources",
    wide: true,
    body:
      unsynced + (d.sources.length === 0 ? table : `<div class="scroll">${table}</div>`) +
      `<p class="note">Records written is a lifetime count of new or changed records, not what is held: an unchanged record is skipped, ` +
      `and a record that changes three times counts three times. Metrics rejected are values a source sent for a metric another source owns; ` +
      `they are counted here and never written. Malformed records are counted and skipped, and the rest of the run still lands. ` +
      `Detected means a sync registered the source; this page runs no probe of its own.</p>`,
  });
  const details = d.sources.map((s) => detailSection(s, now, tz)).join("");
  return overview + (details === "" ? "" : `<div class="g g-2">${details}</div>`);
}

export function sourcesView(d: SourcesData, opts: { tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  return {
    href: "/sources",
    title: "Sources",
    body: renderSourcesBody(d, { tz }),
    footer: `generated ${stamp(d.generatedAt, tz)} · times are local, ${zoneNote(tz, d.generatedAt)} · read from wt_* as the last watchtower sync left it; the dashboard never runs sync`,
  };
}

export function renderSourcesPage(d: SourcesData, opts: { tz?: string } = {}): string {
  return viewPage(sourcesView(d, opts));
}
