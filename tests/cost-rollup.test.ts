import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll, rows, ROLLUP } from "./helpers/fixture-db";
import { snapshotDays } from "@/lib/read/history";

// The rollup buckets by LOCAL day under TZ=UTC; snapshotDays' sqlite3 child
// inherits this, so both agree on which day a snapshot's session belongs to.
process.env.TZ = "UTC";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "capture", "lib.sh");
const MAKE = path.join(ROOT, "tests", "fixtures", "make-fixture.sh");

interface Metric {
  request_id: string;
  model: string;
  priced: number | null;
  price_note: string | null;
  cost_table_usd: number | null;
  cost_write_5m_usd: number | null;
  cost_write_1h_usd: number | null;
}
const metrics = (db: string): Metric[] =>
  rows<Metric>(db, "SELECT * FROM claude_request_metrics ORDER BY request_id;");

describe("cost at API prices", () => {
  it("prices every model id from its own row (price-rows)", () => {
    const db = buildAndRoll("price-rows");
    // Every request: in 1000, out 2000, cache-read 3000, cw5m 400, cw1h 600.
    // cost = (1000*in + 2000*out + 3000*cr + 400*w5 + 600*w1) / 1e6.
    const table: Record<string, number> = {
      // 10000 + 100000 + 750 + 5000 + 12000 = 127750
      "claude-fable-5-1": 0.12775,
      // 10000 + 100000 + 3000 + 5000 + 12000 = 130000
      "claude-fable-5": 0.13,
      // 4000 + 40000 + 600 + 2000 + 4800 = 51400
      "claude-opus-5-5": 0.0514,
      // 5000 + 50000 + 1500 + 2500 + 6000 = 65000
      "claude-opus-5": 0.065,
      "claude-opus-4-8": 0.065,
      "claude-opus-4-7": 0.065,
      // 2000 + 20000 + 600 + 1000 + 2400 = 26000
      "claude-sonnet-5-5": 0.026,
      "claude-sonnet-5": 0.026,
      // 3000 + 30000 + 900 + 1500 + 3600 = 39000
      "claude-sonnet-4-6": 0.039,
      // 1000 + 10000 + 300 + 500 + 1200 = 13000
      "claude-haiku-4-5": 0.013,
      "claude-haiku-4-5-20251001": 0.013,
    };
    const got = metrics(db);
    expect(got.length).toBe(11);
    for (const m of got) {
      expect(m.priced, m.model).toBe(1);
      expect(m.price_note, m.model).toBeNull();
      expect(Math.abs((m.cost_table_usd as number) - table[m.model]), m.model).toBeLessThan(1e-12);
    }
    const opus = got.find((m) => m.model === "claude-opus-5")!;
    expect(Math.abs((opus.cost_write_5m_usd as number) - 0.0025)).toBeLessThan(1e-12); // 400*6.25/1e6
    expect(Math.abs((opus.cost_write_1h_usd as number) - 0.006)).toBeLessThan(1e-12); // 600*10/1e6

    const prices = rows<{ n: number; v: number; s: number }>(
      db,
      `SELECT COUNT(*) AS n,
              SUM(verified_on = '2026-09-28') AS v,
              SUM(source = 'https://platform.claude.com/docs/en/about-claude/pricing') AS s
       FROM claude_prices;`,
    )[0];
    expect(prices).toEqual({ n: 11, v: 11, s: 11 });
  });

  it("gives each unpriced shape its own note and counts (price-notes)", () => {
    const db = buildAndRoll("price-notes");
    const by = Object.fromEntries(metrics(db).map((m) => [m.request_id, m]));
    expect([by.n_syn.priced, by.n_syn.price_note, by.n_syn.cost_table_usd]).toEqual([null, "synthetic", null]);
    expect([by.n_unk.priced, by.n_unk.price_note, by.n_unk.cost_table_usd]).toEqual([0, "unknown-model", null]);
    expect([by.n_fast.priced, by.n_fast.price_note, by.n_fast.cost_table_usd]).toEqual([0, "fast", null]);
    expect([by.n_nosplit.priced, by.n_nosplit.price_note, by.n_nosplit.cost_table_usd]).toEqual([0, "no-split", null]);
    expect([by.n_absent.priced, by.n_absent.price_note]).toEqual([1, "speed-absent"]);
    expect([by.n_ok.priced, by.n_ok.price_note]).toEqual([1, null]);
    // (1000*1 + 1000*5) / 1e6
    expect(Math.abs((by.n_ok.cost_table_usd as number) - 0.006)).toBeLessThan(1e-12);

    const day = rows<{ priced_requests: number; unpriced_requests: number; cost_table_usd: number }>(
      db,
      "SELECT priced_requests, unpriced_requests, cost_table_usd FROM claude_daily_rollups WHERE day = '2026-09-10';",
    )[0];
    expect(day.priced_requests).toBe(2);
    expect(day.unpriced_requests).toBe(3); // n_syn is in neither count
    expect(Math.abs(day.cost_table_usd - 0.061)).toBeLessThan(1e-12); // 0.055 + 0.006

    // M2 (fix round): one cache-write side recorded (5m NULL, 1h 600) is priced,
    // the NULL side as 0 -- not no-split, which is both sides NULL.
    // (1000*5 + 1000*25 + 600*10) / 1e6 = 36000 / 1e6; its 1h write 600*10 / 1e6.
    const one = by.n_oneside;
    expect([one.priced, one.price_note, one.cost_write_5m_usd]).toEqual([1, null, 0]);
    expect(Math.abs((one.cost_table_usd as number) - 0.036)).toBeLessThan(1e-12);
    expect(Math.abs((one.cost_write_1h_usd as number) - 0.006)).toBeLessThan(1e-12);
    const aug = rows<{ priced_requests: number; unpriced_requests: number; cost_table_usd: number }>(
      db,
      "SELECT priced_requests, unpriced_requests, cost_table_usd FROM claude_daily_rollups WHERE day = '2026-08-10';",
    )[0];
    expect([aug.priced_requests, aug.unpriced_requests]).toEqual([1, 0]);
    expect(Math.abs(aug.cost_table_usd - 0.036)).toBeLessThan(1e-12);
  });

  it("prices a request with no speed as standard and says so (speed-absent)", () => {
    const db = buildAndRoll("price-notes");
    const m = metrics(db).find((r) => r.request_id === "n_absent")!;
    expect(m.priced).toBe(1);
    expect(m.price_note).toBe("speed-absent");
    // (1000*5 + 2000*25) / 1e6
    expect(Math.abs((m.cost_table_usd as number) - 0.055)).toBeLessThan(1e-12);
  });

  it("selects the price row by effective_from, on the request's day (price-change)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-price-change-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", [MAKE, "price-change", db], { encoding: "utf8" });
    const marker = "-- 4B: end of the price table";
    const src = readFileSync(ROLLUP, "utf8");
    expect(src.split(marker).length, "marker must appear exactly once").toBe(2);
    const spliced = src.replace(
      marker,
      `INSERT INTO _prices VALUES ('claude-opus-5','standard','2026-03-01',1,1,1,1,1,'2026-09-28','fixture');\n${marker}`,
    );
    const copy = path.join(dir, "rollup-copy.sh");
    writeFileSync(copy, spliced);
    execFileSync("bash", [copy, "--quiet"], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC" },
      encoding: "utf8",
    });
    const byDay = Object.fromEntries(
      rows<{ day: string; priced: number; price_note: string | null; cost_table_usd: number | null }>(
        db,
        "SELECT day, priced, price_note, cost_table_usd FROM claude_request_metrics;",
      ).map((r) => [r.day, r]),
    );
    // M1 (Stage 4B fix round): opus-5 HAS price rows, just none on or before
    // 2025-12-31 -- not an unknown model. A model with no row at all (price-notes'
    // claude-mystery-9) stays unknown-model.
    expect([byDay["2025-12-31"].priced, byDay["2025-12-31"].price_note, byDay["2025-12-31"].cost_table_usd]).toEqual([0, "no-price-yet", null]);
    expect(Math.abs((byDay["2026-02-28"].cost_table_usd as number) - 0.005)).toBeLessThan(1e-12); // 1000*5/1e6
    expect(Math.abs((byDay["2026-03-01"].cost_table_usd as number) - 0.001)).toBeLessThan(1e-12); // 1000*1/1e6
  });

  // I2 (Stage 4B fix round). The 17-column identity holds under ANY split of a
  // day's cost across its keys, so it cannot see cost filed under the wrong
  // project: a _cost_p grouped by day alone (SQLite then picks one bare
  // project_key per day) keeps every per-day sum. priced-mixed puts the same
  // four requests in each of four cwds -- two repos, a non-repo directory
  // ((unfiled)) and an excluded path ((excluded)) -- so each key's own row is
  // pinned. Per cwd on 2026-09-10, at spec 4.1's rates:
  //   PM_O opus-5:   (1000*5 + 2000*25 + 3000*0.50 + 400*6.25 + 600*10) / 1e6 = 65000 / 1e6 = 0.065
  //   PM_S sonnet-5: (500*2 + 700*10 + 900*0.20 + 100*2.50 + 200*4) / 1e6     =  9230 / 1e6 = 0.00923
  //   PM_A opus-5, no speed, no cache write: (1000*5 + 2000*25) / 1e6         = 55000 / 1e6 = 0.055 (speed-absent: priced)
  //   PM_U claude-mystery-9: unknown-model, not priced
  //   => 0.065 + 0.00923 + 0.055 = 0.12923, with 3 priced and 1 not.
  // On 2025-06-15 each key holds one fx-model request (M_P1..M_EX), which has
  // no price row: $0 at API prices, 0 priced, 1 not.
  it("files each request's cost under the project its own cwd resolves to (priced-mixed)", () => {
    const db = buildAndRoll("priced-mixed", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    const got = rows<{ day: string; project_key: string; cost_table_usd: number; priced_requests: number; unpriced_requests: number }>(
      db,
      `SELECT day, project_key, cost_table_usd, priced_requests, unpriced_requests
       FROM claude_project_rollups ORDER BY day, project_key;`,
    ).map((r) => ({ ...r, project_key: r.project_key.startsWith("/") ? path.basename(r.project_key) : r.project_key }));
    const KEYS = ["(excluded)", "(unfiled)", "proj-one", "proj-two"];
    expect(got.map((r) => [r.day, r.project_key, r.priced_requests, r.unpriced_requests])).toEqual([
      ...KEYS.map((k) => ["2025-06-15", k, 0, 1]),
      ...KEYS.map((k) => ["2026-09-10", k, 3, 1]),
    ]);
    for (const r of got) {
      const want = r.day === "2026-09-10" ? 0.12923 : 0;
      expect(Math.abs(r.cost_table_usd - want), `${r.day} ${r.project_key}`).toBeLessThan(1e-12);
    }
  });

  // I1 + M4 (Stage 4B fix round). A status-line cost of exactly 0 is not a
  // reading: 786 live sessions carry MAX(total_cost_usd) = 0, and counting them
  // printed "$0.00" as Claude Code's figure beside a real cost at API prices.
  // "Has a Claude Code cost reading" is defined twice -- rollup.sh's
  // _sx.has_cost (sessions_with_cost, read by History and Projects) and
  // lib/read/history.ts's snapshotDays (Live's today and the Skills series) --
  // so the two sets are compared here, on a $0-only session and a
  // $0-then-positive one, and cannot drift apart unseen.
  it("counts only a positive status-line cost as a reading, in the rollup and in snapshotDays alike (zero-cost)", () => {
    const db = buildAndRoll("zero-cost");
    const daily = rows<{ day: string; sessions_count: number; sessions_with_cost: number; cost_usd: number }>(
      db,
      "SELECT day, sessions_count, sessions_with_cost, cost_usd FROM claude_daily_rollups ORDER BY day;",
    );
    expect(daily).toEqual([
      { day: "2026-09-10", sessions_count: 1, sessions_with_cost: 0, cost_usd: 0 }, // S_Z0: its one reading is 0
      { day: "2026-09-11", sessions_count: 1, sessions_with_cost: 1, cost_usd: 1.25 }, // S_ZP: 0, then 1.25
    ]);
    const proj = rows<{ project_key: string; day: string; sessions_with_cost: number; cost_usd: number }>(
      db,
      "SELECT project_key, day, sessions_with_cost, cost_usd FROM claude_project_rollups ORDER BY day;",
    ).map((r) => ({ ...r, project_key: path.basename(r.project_key) }));
    expect(proj).toEqual([
      { project_key: "zero-proj", day: "2026-09-10", sessions_with_cost: 0, cost_usd: 0 },
      { project_key: "pos-proj", day: "2026-09-11", sessions_with_cost: 1, cost_usd: 1.25 },
    ]);
    // M4: the rollup's days with a reading are exactly snapshotDays' days.
    const rolled = new Set(daily.filter((d) => d.sessions_with_cost > 0).map((d) => d.day));
    expect(snapshotDays(db, "total_cost_usd", "2026-09-01", "2026-09-30")).toEqual(rolled);
    expect(rolled).toEqual(new Set(["2026-09-11"]));
  });

  it("keeps every rate and the pricing URL out of lib/", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else {
          const text = readFileSync(p, "utf8");
          for (const needle of ["6.25", "3.75", "12.5", "about-claude/pricing", "developers.openai.com/api/docs/pricing", "0.175", "0.075"]) {
            if (text.includes(needle)) hits.push(`${path.relative(ROOT, p)}: ${needle}`);
          }
        }
      }
    };
    walk(path.join(ROOT, "lib"));
    expect(hits).toEqual([]);
  });
});
