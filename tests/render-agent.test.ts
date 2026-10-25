import { describe, expect, it } from "vitest";
import type { AgentData, AgentSessionRow } from "@/lib/read/agent";
import { HERMES_FIGURE, HERMES_UNPRICED } from "@/lib/render/cost";
import { agentView } from "@/lib/render/agent";
import { REPORT_ROWS } from "@/lib/render/sessions";
import { AGENT_SESSION_CAP } from "@/lib/read/agent";
import { firstSyncFailed, lookedFor, NOT_SYNCED } from "@/lib/render/empty";
import { esc } from "@/lib/render/html";

const NOW = Math.floor(Date.parse("2026-10-03T12:00:00Z") / 1000);
const LEVEL = { state: "level" as const, level: {
  source: "codex" as const, activeS: 330, xp: 477, level: 5, tier: "Noobie", xpIntoLevel: 89, xpToNext: 35, sToNext: 24, stars: 0 } };
const TOTALS: NonNullable<AgentData["totals"]> = {
  activeS: 330, sessions: { driven: 3, automated: 2, unclassified: 1 }, requests: 9,
  tokens: { in: 100, out: 50, cacheRead: 10, cacheWrite: 0 }, apiCost: { usd: 0.5, priced: 7, unpriced: 2 }, hermesCost: null,
};
const synced = { state: "synced" as const, lookedAt: "/home/x/.codex/sessions", lastOkAt: NOW, degraded: false, lastError: null };

function data(over: Partial<AgentData> = {}): AgentData {
  return {
    source: "codex", label: "Codex", range: "all", today: "2026-10-03", generatedAt: NOW,
    status: synced, rollupPending: false, level: LEVEL, totals: TOTALS, days: [], models: [], projects: [],
    sessionRows: [], capped: false, unclassified: [], configKey: "sources.codex.driven", ...over,
  };
}
const body = (d: AgentData) => agentView(d, { tz: "UTC" }).body;
const sess = (over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({
  id: "abcdef123456", entry: "cli", driven: 1, startedAt: NOW - 100, endedAt: null, requests: 1, tokens: 10,
  apiCost: null, hermesCost: { usd: 0.2, priced: 1, unpriced: 0 }, ...over,
});

describe("agentView", () => {
  it("not installed is one card that says where it looked, with no level", () => {
    const v = agentView(data({ status: { state: "not-installed", lookedAt: "/home/x/.codex/sessions" }, level: { state: "pending" }, totals: null }), { tz: "UTC" });
    const html = v.body;
    expect(v.sections).toHaveLength(1);
    expect(html).toContain(esc(lookedFor("Codex", "/home/x/.codex/sessions")));
    expect(html).not.toContain("Lv");
  });

  it("not synced says so, and shows no zero hours, no $0.00 and no level", () => {
    const html = body(data({ status: { state: "not-synced", lookedAt: "/h/.codex/sessions" }, totals: null }));
    expect(html).toContain(esc(NOT_SYNCED));
    for (const bad of ["0h", "$0.00", "Lv"]) expect(html).not.toContain(bad);
  });

  it("a first sync that failed shows its error, not the not-synced prompt", () => {
    const html = body(data({ status: { state: "failed", lookedAt: "/h/.codex/sessions", lastError: "state.db <unreadable>" }, totals: null, level: { state: "pending" } }));
    expect(html).toContain(esc("state.db <unreadable>"));
    expect(html).toContain(esc(firstSyncFailed("")).trim().slice(0, 20));
    expect(html).not.toContain(esc(NOT_SYNCED));
    for (const bad of ["0h", "$0.00", "Lv"]) expect(html).not.toContain(bad);
  });

  it("synced but degraded says data as of", () => {
    const html = body(data({ status: { ...synced, degraded: true, lastError: "busy" } }));
    expect(html).toContain("data as of");
  });

  it("rollup pending says so for the figures and the level", () => {
    const html = body(data({ rollupPending: true, totals: null, level: { state: "pending" } }));
    expect(html).toContain("rollup pending");
    expect(html).toContain("level pending");
  });

  it("automated only: requests but no driven session", () => {
    const html = body(data({ totals: { ...TOTALS, activeS: null, requests: 3, sessions: { driven: 0, automated: 1, unclassified: 0 } }, level: { state: "none", activeS: 0 } }));
    expect(html).toContain("automated only");
  });

  it("no requests in range", () => {
    const html = body(data({ totals: { ...TOTALS, requests: 0, activeS: null } }));
    expect(html).toContain("no requests");
  });

  it("Codex models are at API prices, and an unpriced-only model says not priced", () => {
    const html = body(data({ models: [
      { model: "gpt-5.5", requests: 2, tokens: 100, apiCost: { usd: 0.01, priced: 2, unpriced: 0 }, hermesCost: null },
      { model: "gpt-9-imaginary", requests: 1, tokens: 5, apiCost: { usd: 0, priced: 0, unpriced: 1 }, hermesCost: null },
    ] }));
    expect(html).toContain("at API prices");
    expect(html).toContain("not priced");
    expect(html).not.toContain("$0.00");
  });

  it("Hermes uses its own figure, one sessions card per entry point", () => {
    const html = body(data({
      source: "hermes", label: "Hermes", configKey: "sources.hermes.driven", totals: { ...TOTALS, apiCost: null, hermesCost: { usd: 0.5, priced: 1, unpriced: 1 } },
      sessionRows: [sess(), sess({ id: "zzzzzzzz9999", entry: "telegram", hermesCost: { usd: 0, priced: 0, unpriced: 1 } })],
    }));
    expect(html).toContain(esc(HERMES_FIGURE));
    expect(html).toContain(esc(HERMES_UNPRICED));
    expect(html).toContain("Sessions · cli");
    expect(html).toContain("Sessions · telegram");
    expect(html).not.toContain("at API prices");
  });

  it("the Codex unclassified card names the entry point and the config key", () => {
    const html = body(data({ unclassified: [{ entry: "mystery-client", sessions: 1 }] }));
    expect(html).toContain("mystery-client");
    expect(html).toContain("sources.codex.driven");
  });

  it("routes to its own href", () => {
    expect(agentView(data(), { tz: "UTC" }).href).toBe("/codex");
  });

  // Final-review I1: the report is a file, so it lists REPORT_ROWS sessions like
  // the Sessions page does; the served page lists them all (up to the cap).
  it("the report cuts the sessions table to REPORT_ROWS with a note; serve lists them all", () => {
    const many = Array.from({ length: REPORT_ROWS + 15 }, (_, i) => sess({ id: `s${String(i).padStart(7, "0")}`, startedAt: NOW - i * 60 }));
    const d = data({ sessionRows: many });
    const rows = (h: string) => (h.match(/class="sid"/g) ?? []).length;
    const report = agentView(d, { tz: "UTC" }).body;
    expect(rows(report)).toBe(REPORT_ROWS);
    expect(report).toContain(`This report lists the ${REPORT_ROWS} most recent of ${REPORT_ROWS + 15} sessions in this range; serve the dashboard for up to ${AGENT_SESSION_CAP}.`);
    const served = agentView(d, { tz: "UTC", served: true }).body;
    expect(rows(served)).toBe(REPORT_ROWS + 15);
    expect(served).not.toContain("This report lists");
  });

  it("a capped report says more than the cap", () => {
    const many = Array.from({ length: REPORT_ROWS + 1 }, (_, i) => sess({ id: `s${String(i).padStart(7, "0")}`, startedAt: NOW - i }));
    const html = agentView(data({ sessionRows: many, capped: true }), { tz: "UTC" }).body;
    expect(html).toContain(`of more than ${AGENT_SESSION_CAP} sessions`);
  });

  it("a Hermes report cuts each entry-point table to REPORT_ROWS", () => {
    const many = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => sess({ id: `h${String(i).padStart(7, "0")}`, entry: "cli", startedAt: NOW - i }));
    const html = agentView(data({ source: "hermes", label: "Hermes", sessionRows: many }), { tz: "UTC" }).body;
    expect((html.match(/class="sid"/g) ?? []).length).toBe(REPORT_ROWS);
    expect(html).toContain("This report lists the");
  });
});
