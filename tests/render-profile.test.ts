import { describe, expect, it } from "vitest";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { hitCount } from "./helpers/marks.ts";
import type { ProfileData } from "@/lib/read/profile.ts";
import { DISCIPLINE_ORDER, readProfile } from "@/lib/read/profile.ts";
import { needsDataText, profileView, renderProfilePage } from "@/lib/render/profile.ts";
import { LAYOUT_CSS } from "@/lib/render/layout.ts";
import { cssRules } from "./helpers/css.ts";

process.env.TZ = "UTC";

const noon = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

/**
 * One fixture DB per scenario for this whole file, built on first use: every
 * test here only READS it (readProfile + render), so sharing is safe, and a
 * test that needs two scenarios no longer pays two builds -- which under
 * full-suite contention pushed one past vitest's 5 s timeout.
 */
const built = new Map<string, string>();
function fixture(scenario: string): string {
  let db = built.get(scenario);
  if (db === undefined) {
    db = buildAndRoll(scenario);
    built.set(scenario, db);
  }
  return db;
}

const DISCIPLINE_LABELS: Record<string, string> = {
  "prompt-hygiene": "Prompt hygiene",
  "context-hygiene": "Context hygiene",
  "session-hygiene": "Session hygiene",
  "model-routing": "Model routing discipline",
  "cost-discipline": "Cost discipline",
  verification: "Verification discipline",
  automation: "Automation discipline",
  reuse: "Reuse &amp; systematization",
  security: "Security &amp; privacy discipline",
  "output-quality": "Output quality discipline",
};

/** One card's HTML, from its `<h2>` to its closing `</section>`. */
function cardOf(html: string, label: string): string {
  const at = html.indexOf(`<h2>${label}</h2>`);
  expect(at, label).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
}

/** The number of top-level child elements of every `<div class="kv">` in `html`. */
function kvChildCounts(html: string): number[] {
  const counts: number[] = [];
  let from = html.indexOf('<div class="kv">');
  while (from !== -1) {
    const tag = /<(\/?)([a-z0-9]+)[^>]*>/g;
    tag.lastIndex = from;
    let depth = 0;
    let children = 0;
    for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
      if (m[1] === "") {
        if (depth === 1) children++;
        depth++;
      } else if (--depth === 0) break;
    }
    counts.push(children);
    from = html.indexOf('<div class="kv">', from + 1);
  }
  return counts;
}

describe("needsDataText", () => {
  it("points tool-derived disciplines at tool coverage", () => {
    for (const id of ["prompt-hygiene", "verification", "reuse"] as const) {
      expect(needsDataText(id, null)).toBe("no tool data yet");
      expect(needsDataText(id, "2026-08-12")).toBe("tool data starts 2026-08-12");
    }
  });
  it("names its own missing input for the non-tool disciplines", () => {
    expect(needsDataText("context-hygiene", null)).toBe("no session data recorded in this window");
    expect(needsDataText("security", "2026-08-12")).toBe("no prompts recorded with a permission mode in this window");
    expect(needsDataText("cost-discipline", null)).toBe("not enough usage data in this window yet");
  });
});

describe("profileView: the ladder card", () => {
  it("shows the tier label and description, total/600, points to next, and a hidden WoW with no prior week", () => {
    const db = fixture("profile-basic");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));
    expect(html).toContain("<h2>Usage ladder</h2>");
    expect(html).toContain("Operator"); // total 362 -> tier index 3
    expect(html).toContain(
      "Running Claude Code like a pro. Good hygiene across the board, deliberate model routing, and safe defaults are the norm.",
    );
    expect(html).toContain("362 / 600");
    expect(html).toContain("<b>38</b>"); // 400 - 362
    // measured = 10 of 10: the "N of 10 measured" note must not appear.
    expect(html).not.toContain("<span>measured</span>");
    // no prior week at all -> week over week is a dash, not a fabricated 0.
    const ladder = html.slice(html.indexOf("<h2>Usage ladder"), html.indexOf("<h2>Matrix score"));
    expect(ladder).toContain('<b class="absent">—</b>');
  });

  it("dates the scores: 'as of <day> · rolling 30 days', on a scored and on a collecting card (final review M3)", () => {
    const basic = readProfile(fixture("profile-basic"), { now: noon("2026-09-12") });
    // 09-12 is an idle day, but it has a row: the scores are as of 09-12.
    expect(cardOf(renderProfilePage(basic), "Usage ladder")).toContain("as of 2026-09-12 · rolling 30 days");
    // A gated (collecting) latest day is dated too.
    const gated: ProfileData = { ...basic, latest: { ...basic.latest!, day: "2026-09-03", total: null }, disciplines: [] };
    const collecting = cardOf(renderProfilePage(gated), "Usage ladder");
    expect(collecting).toContain("collecting");
    expect(collecting).toContain("as of 2026-09-03 · rolling 30 days");
  });

  it("shows a signed week-over-week delta and 'N of 10 measured' when N < 10", () => {
    const db = fixture("profile-ladder");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-08") }));
    expect(html).toContain("Explorer"); // total 100 -> tier index 1
    expect(html).toContain("100 / 600");
    expect(html).toContain("<b>+1</b>"); // total_wow = 100 - 99
    expect(html).toContain("<span>measured</span><b>5 of 10</b>");
  });

  it("shows 'top tier' with no points to next at 600 (Master)", () => {
    const db = fixture("profile-ladder-top");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));
    expect(html).toContain("Master");
    expect(html).toContain("600 / 600");
    expect(html).toContain("<b>top tier</b>");
    expect(html).not.toContain("<span>measured</span>"); // all ten measured
  });

  it("renders the collecting text on a gated latest day, and no discipline cards", () => {
    const db = fixture("profile-gate");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));
    expect(html).toContain("collecting — fewer than 20 requests in the last 30 days");
    for (const label of Object.values(DISCIPLINE_LABELS)) expect(html).not.toContain(`<h2>${label}</h2>`);
  });
});

describe("profileView: the Matrix card", () => {
  it("shows the tier name, score, points to next, factors with inputs, and week over week", () => {
    const db = fixture("profile-basic");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));
    const matrix = html.slice(html.indexOf("<h2>Matrix score"), html.indexOf("<h2>", html.indexOf("<h2>Matrix score") + 1));
    expect(matrix).toContain("Operator"); // matrix_tier 1
    expect(matrix).toContain("67 / 100");
    expect(matrix).toContain("<b>8</b>"); // 75 - 67
    // matrix_7d = 67 and no prior week: the 7-day score, and no fabricated delta.
    expect(matrix).toContain('<b>67</b> <span class="muted">· no prior week to compare</span>');
    expect(matrix).not.toMatch(/[+−-]?\d+ vs prior week/);
    expect(matrix).toContain("82/100");
    expect(matrix).toContain("112,500 median tokens/turn");
    expect(matrix).toContain("90/100");
    expect(matrix).toContain("0 of 0 long sessions reset");
    expect(matrix).toContain("100/100");
    expect(matrix).toContain("10.0 median requests/session");
    expect(matrix).toContain("0/100");
    expect(matrix).toContain("1310.0x cache:fresh");
  });

  it("labels its week over week as a 7-day figure beside the 30-day score (final review M4)", () => {
    // profile-wow on 2026-09-20: matrix_7d = 95, matrix_wow = 95 - 70 = +25.
    const db = fixture("profile-wow");
    const matrix = cardOf(renderProfilePage(readProfile(db, { now: noon("2026-09-20") })), "Matrix score");
    expect(matrix).toContain("<span>7-day score</span>");
    expect(matrix).toContain('<b>95</b> <span class="muted">· +25 vs prior week</span>');
    expect(matrix).not.toContain("<span>week over week</span>");
  });

  it("lays out every row as a label and ONE value, factor inputs included (final review M5)", () => {
    const db = fixture("profile-basic");
    const matrix = cardOf(renderProfilePage(readProfile(db, { now: noon("2026-09-10") })), "Matrix score");
    const counts = kvChildCounts(matrix);
    expect(counts.length).toBe(7); // score, points to next, 7-day score, four factors
    expect(counts).toEqual(counts.map(() => 2));
  });

  it("shows The One at the top", () => {
    const db = fixture("profile-ladder-top");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));
    expect(html).toContain("The One");
  });

  // profile-ladder's session_id is empty (Task 3's fixture), so there is no
  // session to group context/session-length over: matrixScore is NULL on an
  // otherwise UNGATED day (window_requests = 20, total = 99). That is a
  // narrower fact than the 20-request gate, and must say so rather than
  // "collecting", which would be false -- there plainly were 20+ requests.
  it("says 'no session data' rather than 'collecting' when the day is ungated but has no session to score", () => {
    const db = fixture("profile-ladder");
    const data = readProfile(db, { now: noon("2026-09-01") });
    expect(data.latest?.total).toBe(99);
    expect(data.latest?.matrixScore).toBeNull();
    const html = renderProfilePage(data);
    const matrix = html.slice(html.indexOf("<h2>Matrix score"), html.indexOf("<h2>", html.indexOf("<h2>Matrix score") + 1));
    expect(matrix).toContain("no session data to score this window");
    expect(matrix).not.toContain("collecting");
  });

  // Coppertop (matrix < 45): no fixture happens to land there with a defined
  // score, so this exercises the pure render function directly on a
  // hand-built ProfileData, the same way the chart primitives are tested.
  it("shows Coppertop at the bottom of the Matrix tiers", () => {
    const day = {
      day: "2026-09-10", windowRequests: 20, toolCovered: true,
      total: 300, measured: 10, tierIndex: 3, tierPointsToNext: 100, totalWow: null,
      matrixScore: 20, matrixTier: 0, matrixPointsToNext: 25,
      factors: { context: 20, compaction: 20, sessionLength: 20, efficiency: 20 },
      inputs: { medianCtx: 300000, medianRequests: 200, longSessions: 2, longWithReset: 0, cacheFreshRatio: 40 },
      matrix7d: null,
      matrixWow: null,
    };
    const data: ProfileData = {
      latest: day, disciplines: [], history: [], coverageStart: null, eventCovered: true, eventStart: null, range: "30d",
    };
    const html = renderProfilePage(data);
    expect(html).toContain("Coppertop");
    expect(html).toContain("Plugged in and feeding the machine.");
  });
});

describe("profileView: the ten discipline cards", () => {
  it("appear in DisciplineId order, with a 0-60 bar, a status word, evidence and the Watchtower badge on automation/security only", () => {
    const db = fixture("profile-basic");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));

    const order = DISCIPLINE_ORDER.map((id) => DISCIPLINE_LABELS[id]);
    const positions = order.map((label) => html.indexOf(`<h2>${label}</h2>`));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Status is a WORD, not only a colour.
    for (const word of ["strong", "ok", "needs work"]) expect(html).toContain(`>${word}<`);

    // Exactly automation and security carry the badge.
    expect((html.match(/<span class="chip">Watchtower definition<\/span>/g) ?? []).length).toBe(2);
    const automation = html.slice(html.indexOf("<h2>Automation discipline"), html.indexOf("<h2>Reuse"));
    const security = html.slice(html.indexOf("<h2>Security"), html.indexOf("<h2>Output quality"));
    expect(automation).toContain("Watchtower definition");
    expect(security).toContain("Watchtower definition");
    const verification = html.slice(html.indexOf("<h2>Verification"), html.indexOf("<h2>Automation"));
    expect(verification).not.toContain("Watchtower definition");

    // A 0-60 bar: verification scores 44 (mean of H(0.4,0.1,0.5)=75 and L(0.15,0.05,0.4)=71 -> round(146/2/100*60)).
    expect(verification).toContain('aria-valuemax="60"');

    // Evidence, TheOne's wording, exact numbers from the fixture's hand arithmetic.
    expect(verification).toContain("20 tool calls");
    expect(verification).toContain("40% of tool calls inspect code (Read/Grep/Glob)");
    expect(verification).toContain("15% tool-error rate");
  });

  it("names what is missing on a needs-data card: tool-derived, session-derived and event-derived", () => {
    const db = fixture("profile-ladder");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-01") }));
    const cardBody = (label: string) => {
      const at = html.indexOf(`<h2>${label}</h2>`);
      return html.slice(at, html.indexOf("</section>", at));
    };
    expect(cardBody("Prompt hygiene")).toContain("needs data");
    expect(cardBody("Prompt hygiene")).toContain("no tool data yet");
    expect(cardBody("Verification discipline")).toContain("no tool data yet");
    expect(cardBody("Reuse &amp; systematization")).toContain("no tool data yet");
    expect(cardBody("Context hygiene")).toContain("no session data recorded in this window");
    expect(cardBody("Security &amp; privacy discipline")).toContain("no prompts recorded with a permission mode in this window");
  });
});

describe("profileView: discipline card details (final review I2, M2, M6, M7)", () => {
  // I2: a NULL evidence value reads "not measured", never 0 -- the page's
  // footer promise. First the real needs-data cards, then every discipline's
  // evidence with every value NULL.
  it("never renders a missing evidence value as 0", () => {
    const db = fixture("profile-ladder");
    const data = readProfile(db, { now: noon("2026-09-01") });
    const html = renderProfilePage(data);
    const prompt = cardOf(html, "Prompt hygiene");
    expect(prompt).toContain("<li>distinct slash commands: not measured</li>");
    const verification = cardOf(html, "Verification discipline");
    expect(verification).toContain("<li>tool calls: not measured</li>");
    expect(verification).toContain("<li>inspection share: not measured</li>");
    expect(verification).toContain("<li>tool-error rate: not measured</li>");
    const reuse = cardOf(html, "Reuse &amp; systematization");
    expect(reuse).toContain("<li>most-used command: not measured</li>");
    expect(reuse).toContain("<li>MCP servers: not measured</li>");
    for (const card of [prompt, verification, reuse]) expect(card).not.toMatch(/<li>0\b/);

    // Every discipline, every evidence key present but NULL: no evidence line
    // may carry a digit at all.
    const measured = readProfile(fixture("profile-basic"), { now: noon("2026-09-10") });
    const allNull: ProfileData = {
      ...measured,
      disciplines: measured.disciplines.map((d) => ({
        ...d,
        score: 0,
        status: "needs-data" as const,
        evidence: Object.fromEntries(Object.keys(d.evidence).map((k) => [k, null])),
      })),
    };
    expect(allNull.disciplines).toHaveLength(10);
    const page = renderProfilePage(allNull);
    for (const id of DISCIPLINE_ORDER) {
      const lines = [...cardOf(page, DISCIPLINE_LABELS[id]).matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
      expect(lines.length, id).toBeGreaterThan(0);
      for (const line of lines) expect(`${id}: ${line}`).not.toMatch(/\d/);
    }
  });

  it("styles 'ok' by colour alone, never with the .muted typography class (final review M2)", () => {
    const db = fixture("profile-basic");
    const html = renderProfilePage(readProfile(db, { now: noon("2026-09-10") }));
    // verification scores 44: ok.
    expect(cardOf(html, "Verification discipline")).toContain('<span class="status-ok">ok</span>');
    for (const m of html.matchAll(/<span class="([^"]*)">(ok|strong|needs work|needs data)<\/span>/g)) {
      expect(`${m[2]}: ${m[1]}`).not.toMatch(/\b(muted|label)\b/);
    }
    const rule = cssRules(LAYOUT_CSS).rules.find((r) => r.selector.split(",").map((x) => x.trim()).includes(".status-ok"));
    expect(rule).toBeTruthy();
    const props = rule!.body.split(";").map((d) => d.split(":")[0].trim()).filter((p) => p !== "");
    expect(props).toEqual(["color"]);
  });

  it("shows the 0-60 score beside the status word, and a dash, never 0, on a needs-data card (final review M6)", () => {
    const basic = renderProfilePage(readProfile(fixture("profile-basic"), { now: noon("2026-09-10") }));
    // A MEASURED 0 is a real 0 (cost-discipline: efficiency factor 0).
    expect(cardOf(basic, "Verification discipline")).toContain('>ok</span> <span class="muted">· 44 / 60</span>');
    expect(cardOf(basic, "Cost discipline")).toContain('>needs work</span> <span class="muted">· 0 / 60</span>');
    const ladder = renderProfilePage(readProfile(fixture("profile-ladder"), { now: noon("2026-09-01") }));
    const prompt = cardOf(ladder, "Prompt hygiene");
    expect(prompt).toContain('>needs data</span> <span class="muted">· — / 60</span>');
    expect(prompt).not.toContain("0 / 60");
  });

  it("says 'no tool calls in this window' on a covered window with zero calls (final review M7)", () => {
    const zero = { tool_calls: 0, inspect_share: null, tool_error_rate: null };
    expect(needsDataText("verification", "2026-07-01", zero)).toBe("no tool calls in this window");
    // Not covered at all (tool_calls NULL): still the coverage message.
    expect(needsDataText("verification", "2026-09-01", { tool_calls: null })).toBe("tool data starts 2026-09-01");
    // And the card passes its evidence through.
    const db = fixture("profile-zero-tools");
    const verification = cardOf(renderProfilePage(readProfile(db, { now: noon("2026-09-10") })), "Verification discipline");
    expect(verification).toContain("no tool calls in this window");
    expect(verification).not.toContain("tool data starts");
  });
});

describe("profileView: the history chart", () => {
  it("breaks the line on a gated or missing day, not on an idle-but-ungated one (Review Focus 4)", () => {
    const db = fixture("profile-basic");
    const view = profileView(readProfile(db, { now: noon("2026-09-12"), range: "7d" }));
    const history = view.body.slice(view.body.indexOf("<h2>Total over time"));
    // 7d range 09-06..09-12: four days before the tracker's first row (null),
    // three ungated days (09-10 the burst, 09-11/09-12 idle but scored) --
    // one hover column per plotted point, none for the four gaps.
    expect(hitCount(history)).toBe(3);
  });

  it("renders the empty state when every day in range is gated", () => {
    const db = fixture("profile-gate");
    const view = profileView(readProfile(db, { now: noon("2026-09-15"), range: "7d" }));
    const history = view.body.slice(view.body.indexOf("<h2>Total over time"));
    expect(history).toContain("chart-empty");
    expect(history).toContain("no scored days");
  });
});
