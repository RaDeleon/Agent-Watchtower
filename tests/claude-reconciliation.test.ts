import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { SCENARIOS } from "./regression/baseline";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { runSync } from "@/lib/core/sync";
import { slow } from "./helpers/timeout";

describe("Claude projection reconciles with claude_* on every scenario", () => {
  it("projects every request, with the same token totals, on all scenarios", async () => {
    for (const scenario of SCENARIOS) {
      const db = buildAndRoll(scenario);
      await runSync({ db, adapters: [createClaudeAdapter({ db })] });

      // `to` is a SQL keyword -- both halves alias to tokens_out_sum.
      const src = rows<{ n: number; ti: number; tokens_out_sum: number }>(db, `
        SELECT COUNT(*) AS n,
               COALESCE(SUM(tokens_in),0)  AS ti,
               COALESCE(SUM(tokens_out),0) AS tokens_out_sum
          FROM claude_requests WHERE ts IS NOT NULL;`);
      const out = rows<{ n: number; ti: number; tokens_out_sum: number }>(db, `
        SELECT COUNT(*) AS n,
               COALESCE(SUM(tokens_in),0)  AS ti,
               COALESCE(SUM(tokens_out),0) AS tokens_out_sum
          FROM wt_requests WHERE source = 'claude';`);

      expect(`${scenario}: ${JSON.stringify(out[0])}`)
        .toBe(`${scenario}: ${JSON.stringify(src[0])}`);
    }
  }, slow(300_000));

  it("keeps requests that have no session row — the 22.4% case", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const orphans = rows<{ n: number }>(db, `
      SELECT COUNT(*) AS n FROM wt_requests
       WHERE source = 'claude' AND canonical_id IS NULL;`)[0].n;
    expect(orphans).toBeGreaterThan(0);
  });

  it("leaves the claude_* rollups byte-identical — the projection writes nothing back", async () => {
    const db = buildAndRoll("four-projects");
    const before = rows<unknown>(db, "SELECT * FROM claude_daily_rollups ORDER BY day;");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const after = rows<unknown>(db, "SELECT * FROM claude_daily_rollups ORDER BY day;");
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
