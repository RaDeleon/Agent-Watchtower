import { describe, expect, it } from "vitest";
import type { OverviewData, ToolSummary } from "@/lib/read/overview";
import { AGENT_LABEL } from "@/lib/read/level";
import { API_PRICES, HERMES_FIGURE, apiCostBold, hermesCostBold } from "@/lib/render/cost";
import { firstSyncFailed, MEMORY_CAPTION, NOT_SYNCED, NO_OPENVIKING, unreachableAt } from "@/lib/render/empty";
import { duration, esc, minute } from "@/lib/render/html";
import { overviewView } from "@/lib/render/overview";

const NOW = 1790600300;
const lv = (level: number, top = false) => ({
  state: "level" as const,
  level: { source: "claude" as const, activeS: 3600, xp: 100, level, tier: "Builder", xpIntoLevel: 1, xpToNext: top ? null : 5, sToNext: top ? null : 7, stars: 0 },
});
const tool = (source: ToolSummary["source"], over: Partial<ToolSummary> = {}): ToolSummary => ({
  source, label: AGENT_LABEL[source], status: source === "claude" ? { state: "core" } : { state: "synced", lookedAt: "/x", lastOkAt: NOW, degraded: false, lastError: null },
  level: lv(40), activeS: 7200, sessions: { total: 3, driven: source === "claude" ? null : 2, automated: source === "claude" ? null : 1 },
  requests: 10, tokens: { in: 1000, out: 500 }, apiCost: { usd: 1.5, priced: 10, unpriced: 0 }, hermesCost: null, ...over,
});
const data = (over: Partial<OverviewData> = {}): OverviewData => ({
  range: "30d", today: "2026-10-03", generatedAt: NOW, rollupPending: false,
  tools: [tool("claude"), tool("codex"), tool("hermes", { apiCost: null, hermesCost: { usd: 0.5, priced: 1, unpriced: 0 } })],
  daily: [{ day: "2026-10-03", claudeS: 3600, codexS: null, hermesS: null }],
  totalLevel: 120, maxCape: { at: 99, reached: 1, of: 3 },
  apiCost: { usd: 3, priced: 20, unpriced: 0 }, hermesCost: { usd: 0.5, priced: 1, unpriced: 0 },
  openviking: { state: "absent" }, ...over,
});
const html = (d: OverviewData) => overviewView(d, { tz: "UTC" }).body;

describe("overviewView", () => {
  it("renders one card per tool, titled with AGENT_LABEL", () => {
    const h = html(data());
    for (const l of Object.values(AGENT_LABEL)) expect(h).toContain(`<h2>${l}</h2>`);
  });

  it("the cost card shows at API prices, and Hermes's figure is a separate key-value", () => {
    const h = html(data());
    const at = h.indexOf("<h2>Cost</h2>");
    const card = h.slice(at, h.indexOf("</section>", at));
    expect(card).toContain(`${API_PRICES} · Claude Code + Codex`);
    expect(card).toContain(apiCostBold({ usd: 3, priced: 20, unpriced: 0 }));
    expect(card).toContain(`<span>${esc(HERMES_FIGURE)}</span>${hermesCostBold({ usd: 0.5, priced: 1, unpriced: 0 })}`);
    expect(card).not.toContain("$3.50");
  });

  it("not-synced Hermes renders NOT_SYNCED verbatim, with no level and no zero", () => {
    const h = html(data({ tools: [tool("claude"), tool("hermes", { status: { state: "not-synced", lookedAt: "/h" }, activeS: null, requests: null, tokens: null, sessions: null, apiCost: null, level: { state: "pending" } })] }));
    const at = h.indexOf("<h2>Hermes</h2>");
    const card = h.slice(at, h.indexOf("</section>", at));
    expect(card).toContain(esc(NOT_SYNCED));
    expect(card).not.toMatch(/Lv|\$0|0h/);
  });

  it("a Hermes whose first sync failed shows the error, never NOT_SYNCED", () => {
    const h = html(data({ tools: [tool("claude"), tool("hermes", { status: { state: "failed", lookedAt: "/h", lastError: "boom <1>" }, activeS: null, requests: null, tokens: null, sessions: null, apiCost: null, level: { state: "pending" } })] }));
    const at = h.indexOf("<h2>Hermes</h2>");
    const card = h.slice(at, h.indexOf("</section>", at));
    expect(card).toContain(esc(firstSyncFailed("boom <1>")));
    expect(card).not.toContain(esc(NOT_SYNCED));
    expect(card).not.toMatch(/Lv|\$0|0h/);
  });

  it("OpenViking: unreachable with ages, absent, and always the memory caption", () => {
    const seen = html(data({ openviking: { state: "seen", checkedAt: 1790600200, reachable: false,
      recall: { at: 1790600000, count: 3, latencyMs: 42, tokens: 512 }, capture: { at: 1790600100, turns: 4, committed: true } } }));
    expect(seen).toContain(esc(unreachableAt(minute(1790600200, "UTC"))));
    expect(seen).toContain(`${duration(NOW - 1790600000)} ago`);
    expect(seen).toContain(`${duration(NOW - 1790600100)} ago`);
    expect(seen).toContain(esc(MEMORY_CAPTION));
    const absent = html(data());
    expect(absent).toContain(NO_OPENVIKING);
    expect(absent).toContain(esc(MEMORY_CAPTION));
  });

  it("Total level shows the number and Max Cape; null shows a dash in the absent style", () => {
    const h = html(data());
    expect(h).toContain('<div class="big">120</div>');
    expect(h).toContain("1 of 3 tools at 99+");
    expect(html(data({ totalLevel: null }))).toContain('<div class="big absent">—</div>');
  });
  it("Max Cape is pending without a cap", () => {
    const h = html(data({ maxCape: null }));
    expect(h).toContain("Max Cape");
    expect(h).toContain("pending");
  });
  // Stage 6 (R11): each level card links to its tool's Character section.
  it("links each level card to Character: the route served, the anchor in the report", () => {
    expect(overviewView(data(), { tz: "UTC", served: true }).body).toContain(`href="/character#character-claude"`);
    expect(html(data())).toContain(`href="#character-claude"`);
    expect(html(data())).not.toContain(`href="/character`);
  });
});
