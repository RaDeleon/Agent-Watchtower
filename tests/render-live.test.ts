import { describe, expect, it } from "vitest";
import { limitState, progressRing } from "@/lib/render/charts";
import { clock, compact, dateIn, duration, esc, grouped, stamp, zoneNote } from "@/lib/render/html";
import { renderLivePage, renderLivePanel } from "@/lib/render/live";
import type { Level } from "@/lib/read/level";
import type { LiveData } from "@/lib/read/live";

const LV77: Level = { source: "claude", activeS: 1051920, xp: 1523464, level: 77, tier: "Advanced",
  xpIntoLevel: 47883, xpToNext: 105736, sToNext: 73009, stars: 0 };

const data = (over: Partial<LiveData> = {}): LiveData => ({
  generatedAt: 1750000400,
  rateLimits: { fiveHour: { pct: 108, ts: 1750000060 }, sevenDay: { pct: null, ts: null } },
  session: {
    sessionId: "S_LIVE", startedAt: 1750000000, elapsedSeconds: 400,
    costUsd: 3, contextPct: 42.5, active: true, repo: "fx",
  },
  sessionUsage: { requests: 12, tokensOut: 24000, tokensIn: 300, latestTs: 1750000390 },
  today: {
    day: "2025-06-15", activeHours: 1.25, sessions: 1, hygiene: 81.3, costUsd: 4.5,
    apiCost: { usd: 3.75, priced: 12, unpriced: 0 }, wait: { n: 3, median: 5400, p90: 9000 },
  },
  burnRate: {
    tokensPerMin: 400, windowSeconds: 300, requests: 2, tokensOut: 2000, source: "transcript",
    buckets: [0, 0, 0, 0, 0, 1200, 0, 0, 800, 0],
  },
  events: [{ ts: 1750000200, name: "Stop", repo: "fx", count: 1, since: 1750000200 }],
  freshness: { lastIngest: 1750000100, lastRollup: 1750000150 },
  week: [
    { day: "2025-06-09", activeHours: 0.5 }, { day: "2025-06-10", activeHours: null },
    { day: "2025-06-11", activeHours: 1 }, { day: "2025-06-12", activeHours: 0 },
    { day: "2025-06-13", activeHours: 2 }, { day: "2025-06-14", activeHours: null },
    { day: "2025-06-15", activeHours: 1.25 },
  ],
  level: { state: "level", level: LV77 },
  streak: 3,
  ...over,
});

describe("progressRing", () => {
  it("is deterministic — same input, same string", () => {
    const opts = { pct: 42.5, label: "5-hour limit", sublabel: "14:27:40Z" };
    expect(progressRing(opts)).toBe(progressRing(opts));
  });

  // Killing mutation: render a null as "0.0%" or COALESCE it upstream. A 0%
  // gauge reads as good news, which is the opposite of "no measurement".
  it("renders a null reading as 'no reading', with no percentage anywhere", () => {
    const svg = progressRing({ pct: null, label: "7-day limit" });
    expect(svg).toContain("no reading");
    expect(svg).toContain("ring-unknown");
    expect(svg).not.toMatch(/\d+\.\d%/);
  });

  // Killing mutation: clamp to 100. The arc cannot show more than a full
  // sweep, but the printed number must stay true and the state must say `over`.
  it("prints a reading above 100% truthfully while the arc saturates", () => {
    const svg = progressRing({ pct: 108, label: "5-hour limit" });
    expect(svg).toContain("108.0%");
    expect(svg).toContain("ring-over");
    const full = progressRing({ pct: 100, label: "5-hour limit" });
    const dash = (s: string) => /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(s)?.[0];
    expect(dash(svg)).toBe(dash(full));
  });

  it("bands a reading by severity", () => {
    expect(progressRing({ pct: 12, label: "x" })).toContain("ring-low");
    expect(progressRing({ pct: 65, label: "x" })).toContain("ring-mid");
    expect(progressRing({ pct: 92, label: "x" })).toContain("ring-high");
  });
});

describe("formatting helpers", () => {
  it("escapes text that came off disk", () => {
    expect(esc(`<script>"x" & 'y'</script>`))
      .toBe("&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
  });

  it("formats without locale", () => {
    expect(grouped(1234567)).toBe("1,234,567");
    expect(compact(4391.4)).toBe("4.4k");
    expect(compact(2_600_000)).toBe("2.6M");
    expect(compact(6_074_674_103)).toBe("6.1B");
    expect(duration(400)).toBe("6m 40s");
    expect(duration(11_220)).toBe("3h 07m");
    // I6: local time, in a zone the caller names -- pinned here, so the
    // machine's own zone cannot move the result.
    expect(clock(1750000400, "UTC")).toBe("15:13:20");
    expect(clock(1750000400, "America/Los_Angeles")).toBe("08:13:20");
    expect(stamp(1750000400, "America/Los_Angeles")).toBe("2025-06-15 08:13:20 PDT");
    expect(stamp(1767225600, "America/Los_Angeles")).toBe("2025-12-31 16:00:00 PST"); // 2026-01-01T00:00Z
    expect(dateIn(1767225600, "America/Los_Angeles")).toBe("2025-12-31");
    expect(stamp(1750000400, "UTC")).toBe("2025-06-15 15:13:20 UTC");
    expect(zoneNote("America/Los_Angeles", 1750000400)).toBe("America/Los_Angeles (PDT)");
  });
});

describe("renderLivePanel", () => {
  it("shows the session, today and the burn rate", () => {
    const html = renderLivePanel(data());
    expect(html).toContain("108.0%");
    expect(html).toContain("no reading");
    expect(html).toContain("$3.00");
    expect(html).toContain("6m 40s");
    // The value and its unit are separate elements, so assert them separately.
    expect(html).toContain(">400<span class=\"unit\"> tok/min</span>");
    expect(html).toContain("S_LIVE");
  });

  // Stage 4B spec §5: today's cost both ways, and today's median turn wait.
  it("shows today's cost at API prices beside Claude Code's figure, and the median measured wait", () => {
    const today = renderLivePanel(data()).slice(renderLivePanel(data()).indexOf('data-live="today"'));
    expect(today).toContain("<span>spend · Claude Code&#39;s figure</span><b>$4.50</b>");
    expect(today).toContain("<span>spend · at API prices</span><b>$3.75</b>");
    expect(today).toContain("<span>turn wait · median of 3</span><b>5.4 s</b>");
    const quiet = renderLivePanel(data({ today: { ...data().today, wait: { n: 0, median: null, p90: null } } }));
    expect(quiet).toContain('<span>turn wait · no measured turn</span><b class="absent">no reading</b>');
  });

  // Idle is a state, not a rate. "0 tok/min" would claim a measurement.
  it("renders an idle burn rate as idle, not as 0", () => {
    const html = renderLivePanel(
      data({ burnRate: { tokensPerMin: null, windowSeconds: 300, requests: 0, tokensOut: 0, source: "transcript", buckets: [] } }),
    );
    expect(html).toContain("idle");
    expect(html).not.toContain("0 tok/min");
  });

  it("renders a null hygiene as absent rather than as a zero score", () => {
    const html = renderLivePanel(data({ today: { day: "2025-06-15", activeHours: 0, sessions: 0, hygiene: null, costUsd: 0, apiCost: { usd: 0, priced: 0, unpriced: 0 }, wait: { n: 0, median: null, p90: null } } }));
    expect(html).toContain("hygiene (no sessions)");
    expect(html).not.toContain(">0.0<");
  });

  it("renders an empty database without a broken panel", () => {
    const html = renderLivePanel(
      data({
        session: null, sessionUsage: null, events: [],
        rateLimits: { fiveHour: { pct: null, ts: null }, sevenDay: { pct: null, ts: null } },
        today: { day: "2025-06-15", activeHours: 0, sessions: 0, hygiene: null, costUsd: 0, apiCost: { usd: 0, priced: 0, unpriced: 0 }, wait: { n: 0, median: null, p90: null } },
        burnRate: { tokensPerMin: null, windowSeconds: 300, requests: 0, tokensOut: 0, source: "database", buckets: [] },
        freshness: { lastIngest: null, lastRollup: null },
      }),
    );
    expect(html).toContain("no session seen");
    expect(html).toContain("no events recorded");
  });

  // Killing mutation: render the database fallback's empty window as "idle"
  // during an active session. ingest runs at SessionEnd, so an empty window in
  // claude_requests only means nothing has been ingested yet.
  it("renders an empty stored window as pending, not idle, while the session runs", () => {
    const burnRate = { tokensPerMin: null, windowSeconds: 300, requests: 0, tokensOut: 0, source: "database" as const, buckets: [] };
    const html = renderLivePanel(data({ burnRate, sessionUsage: null }));
    expect(html).toContain("usage pending");
    expect(html).not.toContain(">idle<");
    // Once the session has ended, an empty window really is idle.
    const ended = renderLivePanel(data({ burnRate, sessionUsage: null, session: { ...data().session!, active: false } }));
    expect(ended).toContain(">idle<");
  });

  it("renders no rollup row with no session running as absent, not 0h", () => {
    const html = renderLivePanel(data({ session: null, today: { day: "2025-06-15", activeHours: null, sessions: null, hygiene: null, costUsd: null, apiCost: null, wait: { n: 0, median: null, p90: null } } }));
    expect(html).toContain("not rolled up");
    expect(html).not.toContain("usage pending");
    expect(html).not.toMatch(/0\.00<span class="unit">h/);
  });

  it("marks a stale gauge reading rather than showing it as current", () => {
    const old = data({ rateLimits: { fiveHour: { pct: 30, ts: 1750000400 - 4000 }, sevenDay: { pct: null, ts: null } } });
    expect(renderLivePanel(old)).toContain("stale");
    expect(renderLivePanel(data())).not.toContain("stale");
  });
});

describe("burn-rate provenance", () => {
  // "idle" from the database and "idle" from the transcript mean different
  // things: the first may only mean nothing has been ingested yet. The page
  // has to say which, or it reports a gap in the pipeline as a quiet hour.
  it("names the source of the figure", () => {
    expect(renderLivePanel(data())).toContain("live");
    const stored = renderLivePanel(
      data({
        burnRate: { tokensPerMin: null, windowSeconds: 300, requests: 0, tokensOut: 0, source: "database", buckets: [] },
        session: { ...data().session!, active: false },
      }),
    );
    expect(stored).toContain("as last ingested");
  });

  it("states how current the stored tables are", () => {
    const html = renderLivePage(data(), { pollSeconds: 5, tz: "America/Los_Angeles" });
    expect(html).toContain("tokens ingested");
    // Dated, not just timed: a four-day-old rollup must not read as today's.
    // I6: in local time, the zone named once in the footer.
    expect(html).toContain("tokens ingested 2025-06-15 08:08:20 PDT");
    expect(html).toContain("rollup 2025-06-15 08:09:10 PDT");
    expect(html).toContain("times are local, America/Los_Angeles (PDT)");
    expect(html).not.toMatch(/\d\d:\d\d:\d\dZ|times UTC/);
    expect(html).toContain("rollup");
    expect(renderLivePage(data({ freshness: { lastIngest: null, lastRollup: null } }))).toContain("never");
  });
});

describe("renderLivePage", () => {
  it("includes the poller only when a poll interval is given", () => {
    expect(renderLivePage(data(), { pollSeconds: 5 })).toContain("/api/live");
    // `report` writes a file: a page that polls a server that is not there
    // would sit there failing silently.
    expect(renderLivePage(data())).not.toContain("/api/live");
  });

  it("is one self-contained document with no external references", () => {
    const html = renderLivePage(data(), { pollSeconds: 5 });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
  });
});

// Review Focus 5: a theme can make status colours close (Raptors' --ok is
// silver). Every limit-ring state therefore prints a word, never colour alone.
describe("limit rings", () => {
  it("bands ok < 70 <= warn < 90 <= over", () => {
    expect(limitState(69.9)).toEqual({ state: "ok", word: "ok" });
    expect(limitState(70)).toEqual({ state: "warn", word: "high" });
    expect(limitState(89.9)).toEqual({ state: "warn", word: "high" });
    expect(limitState(90)).toEqual({ state: "over", word: "near limit" });
    expect(limitState(100)).toEqual({ state: "over", word: "over limit" });
  });

  for (const [pct, cls, word] of [[12, "ring-ok", "ok"], [75, "ring-warn", "high"], [92, "ring-over", "near limit"], [108, "ring-over", "over limit"]] as const) {
    it(`prints "${word}" under ${pct}% as well as colouring it ${cls}`, () => {
      const svg = progressRing({ pct, label: "5-hour limit", tone: "limit" });
      expect(svg).toContain(`ring ${cls}`);
      expect(svg).toContain(`<text class="ring-state"`);
      expect(svg).toContain(`>${word}</text>`);
    });
  }

  it("keeps a null reading as 'no reading', with no state word", () => {
    const svg = progressRing({ pct: null, label: "7-day limit", tone: "limit" });
    expect(svg).toContain("no reading");
    expect(svg).toContain("ring-unknown");
    expect(svg).not.toContain("ring-state");
  });

  it("puts the word on the Live page", () => {
    expect(renderLivePanel(data())).toContain(">over limit</text>");
  });
});

describe("the restyled Live panel", () => {
  const html = renderLivePanel(data());

  it("is one poll region per card", () => {
    for (const k of ["limits", "session", "today", "week", "level", "events"]) {
      expect(html.match(new RegExp(`data-live="${k}"`, "g"))).toHaveLength(1);
    }
  });

  it("makes the current session the one hero card", () => {
    expect(html.match(/class="c hero"/g)).toHaveLength(1);
    expect(html).toContain('<section class="c hero"><h2>Current session</h2>');
  });

  // Guard 5's server half: only a finite headline gets data-count.
  it("marks only finite headline numbers for count-up", () => {
    expect(html).toContain('data-count="3.00">$3.00<');
    expect(html).toContain('data-count="24.0">24.0k<');
    expect(html).toContain('data-count="400">400<');
    expect(html).toContain('data-count="1.25">1.25<');
    const none = renderLivePanel(data({
      session: { ...data().session!, costUsd: null, contextPct: null },
      sessionUsage: null,
      burnRate: { tokensPerMin: null, windowSeconds: 300, requests: 0, tokensOut: 0, source: "transcript", buckets: [] },
      today: { day: "2025-06-15", activeHours: null, sessions: null, hygiene: null, costUsd: null, apiCost: null, wait: { n: 0, median: null, p90: null } },
    }));
    expect(none).not.toContain("data-count");
    for (const h of [html, none]) expect(h).not.toMatch(/data-count="(|null|NaN|undefined|Infinity)"/);
  });

  it("draws the week with today highlighted and a missing day as a 'no data' gap", () => {
    expect(html.match(/class="bar bar-today"/g)).toHaveLength(1);
    expect(html).toContain("<title>2025-06-15 · 1.3h active</title>");
    expect(html.match(/class="bar-absent"/g)).toHaveLength(2);
    expect(html).toContain("<title>2025-06-10 · no data</title>");
    // A genuine zero day is a bar of zero height, not a gap.
    expect(html).toContain("<title>2025-06-12 · 0.0h active</title>");
    expect(html).toContain("3-day streak");
  });

  it("shows the level with a meter to the next level", () => {
    expect(html).toContain(">Lv 77<");
    expect(html).toContain('<i style="width:31.2%"></i>');
    expect(html).toContain("20.3h to Lv 78");
    expect(renderLivePanel(data({ level: { state: "pending" } }))).toContain("level pending");
  });

  it("lists events newest first, the newest in the first (highlighted) row", () => {
    const two = renderLivePanel(data({ events: [
      { ts: 1750000300, name: "UserPromptSubmit", repo: "fx", count: 1, since: 1750000300 },
      { ts: 1750000200, name: "Stop", repo: null, count: 1, since: 1750000200 },
    ] }));
    const rows = two.match(/<div class="trow">.*?<\/div>/g)!;
    expect(rows[0]).toContain("UserPromptSubmit");
    expect(rows[1]).toContain("—");
    expect(two).not.toContain("×");
  });

  it("shows a folded run as one row with its count, and its span in the tooltip", () => {
    const html = renderLivePanel(data({ events: [
      { ts: 1750000240, name: "SubagentStop", repo: "fx", count: 12, since: 1750000200 },
    ] }), { tz: "UTC" });
    expect(html).toContain(
      '<div class="trow"><span>15:10:40</span><span class="ev">SubagentStop <b class="times" title="12 in a row, 15:10:00 to 15:10:40">×12</b></span><span>fx</span></div>',
    );
  });

  it("draws the burn sparkline only when something landed in the window", () => {
    expect(html).toContain('class="burn-line"');
    const idle = renderLivePanel(data({ burnRate: { tokensPerMin: null, windowSeconds: 300, requests: 0, tokensOut: 0, source: "transcript", buckets: new Array(10).fill(0) } }));
    expect(idle).not.toContain("burn-line");
  });
});
