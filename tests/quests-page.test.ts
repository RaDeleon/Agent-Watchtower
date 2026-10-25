import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECENT_UNLOCKS, readQuests } from "@/lib/read/quests";
import {
  ACHIEVEMENTS_PENDING, NO_CLOSED_WEEKS, NO_QUESTS_THIS_WEEK, NO_QUESTS_YET, NO_READING, QUESTS_PENDING, UNDER_20_SO_FAR,
} from "@/lib/render/empty";
import { page, TOOLS } from "@/lib/render/layout";
import { questsView } from "@/lib/render/quests";
import { REPORT_ROWS } from "@/lib/render/sessions";

// Stage 8, the Quests page (spec 5). The reader parses and labels what the
// rollup stored, so these tests write the three tables straight into a
// cc_init_db database: no rollup runs, and no rollup plant can red them.

const LIB = path.resolve(__dirname, "..", "capture", "lib.sh");
const NOW = 1791720000; // 2026-10-11T12:00:00Z

/** A fresh v10 database in its own directory (the .schema-vN marker is per directory). */
function freshDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-quests-")), "fixture.sqlite");
  execFileSync("bash", ["-c", '. "$CC_LIB" && cc_init_db'], { env: { ...process.env, THEONE_DB_PATH: db, CC_LIB: LIB } });
  return db;
}
const sql = (db: string, s: string) => execFileSync("sqlite3", ["-bail", db, s], { encoding: "utf8" });

const QUESTS = `INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status) VALUES
  ('2026-09-21', '2026-09-27', 1, 'verification',    12, 'at-least', 0.041, 0.061, 0, 0.07, 140, 'done'),
  ('2026-09-21', '2026-09-27', 2, 'cost-discipline',  0, 'at-most',  249,   224,   0, 230,  140, 'missed'),
  ('2026-09-21', '2026-09-27', 3, 'reuse',           20, 'at-least', 2,     3,     0, 3,    140, 'done'),
  ('2026-09-28', '2026-10-04', 1, 'verification',    10, 'at-least', 0.07,  0.09,  0, NULL, 12,  'no data'),
  ('2026-09-28', '2026-10-04', 2, 'cost-discipline',  0, 'at-most',  230,   207,   0, NULL, 12,  'no data'),
  ('2026-10-05', '2026-10-11', 1, 'cost-discipline',  0, 'at-most',  249,   224,   0, 224,  90,  'open'),
  ('2026-10-05', '2026-10-11', 2, 'model-routing',   28, 'at-least', 0.5,   0.35,  1, 0.41, 90,  'open'),
  ('2026-10-05', '2026-10-11', 3, 'context-hygiene', 31, 'at-most',  200000, 180000, 0, NULL, 90, 'open');`;
const TIERS = `INSERT INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at) VALUES
  ('seasoned', 'claude', 1, 50, 72, '2026-09-01', 1, 0), ('seasoned', 'claude', 2, 70, 72, '2026-09-27', 2, 0),
  ('seasoned', 'claude', 3, 90, 72, NULL, 0, 0),         ('seasoned', 'claude', 4, 99, 72, NULL, 0, 0),
  ('seasoned', 'codex', 1, 50, NULL, NULL, 0, 0),        ('seasoned', 'codex', 2, 70, NULL, NULL, 0, 0),
  ('seasoned', 'codex', 3, 90, NULL, NULL, 0, 0),        ('seasoned', 'codex', 4, 99, NULL, NULL, 0, 0),
  ('regular', 'claude', 1, 10, 640, '2026-08-02', 1, 0), ('regular', 'claude', 2, 100, 640, '2026-09-27', 2, 0),
  ('regular', 'claude', 3, 1000, 640, NULL, 0, 0),       ('regular', 'claude', 4, 5000, 640, NULL, 0, 0),
  ('wordsmith', 'claude', 1, 1000000, 4200000, '2026-08-20', 1, 0), ('wordsmith', 'claude', 2, 10000000, 4200000, NULL, 0, 0),
  ('wordsmith', 'claude', 3, 100000000, 4200000, NULL, 0, 0),      ('wordsmith', 'claude', 4, 1000000000, 4200000, NULL, 0, 0),
  ('perfect-week', 'claude', 1, 1, 1, '2026-09-27', 1, 0), ('perfect-week', 'claude', 2, 5, 1, NULL, 0, 0),
  ('perfect-week', 'claude', 3, 20, 1, NULL, 0, 0),       ('perfect-week', 'claude', 4, 52, 1, NULL, 0, 0);`;

function seeded(): string {
  const db = freshDb();
  sql(db, `${QUESTS} ${TIERS} INSERT INTO character_points (qp, ap, updated_at) VALUES (2, 7, 0);`);
  return db;
}
const served = (db: string) => questsView(readQuests(db, { now: NOW }), { served: true, tz: "UTC" }).body;

describe("readQuests", () => {
  it("is pending before the v10 rollup: no table, or no points row", () => {
    const db = freshDb();
    expect(readQuests(db, { now: NOW }).pending).toBe(true); // tables, but the rollup has not run
    sql(db, "DROP TABLE claude_quests;");
    expect(readQuests(db, { now: NOW }).pending).toBe(true);
    const html = served(db);
    expect(html).toContain(QUESTS_PENDING);
    expect(html).toContain(ACHIEVEMENTS_PENDING);
  });

  it("splits the open week from the closed ones, newest first, with each week's Quest Points", () => {
    const d = readQuests(seeded(), { now: NOW });
    expect(d.thisWeek?.week).toBe("2026-10-05");
    expect(d.thisWeek?.weekEnd).toBe("2026-10-11");
    expect(d.thisWeek?.quests.map((q) => q.discipline)).toEqual(["cost-discipline", "model-routing", "context-hygiene"]);
    expect(d.log.map((w) => [w.week, w.qp])).toEqual([["2026-09-28", 0], ["2026-09-21", 2]]);
    expect([d.qp, d.ap]).toEqual([2, 7]);
  });

  it("orders achievements by the catalogue, then Claude, Codex, Hermes", () => {
    const d = readQuests(seeded(), { now: NOW });
    expect(d.achievements.map((a) => `${a.key} ${a.source}`)).toEqual([
      "seasoned claude", "seasoned codex", "regular claude", "wordsmith claude", "perfect-week claude",
    ]);
    expect(d.achievements[1].value).toBeNull();
  });

  it("lists recent unlocks newest first, ties to the higher tier, then the catalogue", () => {
    const d = readQuests(seeded(), { now: NOW });
    expect(d.recent.map((u) => `${u.day} ${u.key} ${u.tier}`)).toEqual([
      "2026-09-27 seasoned 2", "2026-09-27 regular 2", "2026-09-27 perfect-week 1", "2026-09-01 seasoned 1",
      "2026-08-20 wordsmith 1", "2026-08-02 regular 1",
    ]);
    const db = seeded();
    sql(db, `INSERT INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at)
      SELECT 'explorer', 'claude', t, t, 9, '2026-07-0' || t, t, 0 FROM (SELECT 1 AS t UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)
      UNION ALL SELECT 'skill-collector', 'claude', t, t, 9, '2026-06-0' || t, t, 0 FROM (SELECT 1 AS t UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4);`);
    expect(readQuests(db, { now: NOW }).recent).toHaveLength(RECENT_UNLOCKS);
  });
});

describe("questsView", () => {
  it("shows this week's targets with last week's baseline, and a hold at full marks", () => {
    const html = served(seeded());
    expect(html).toContain("<h2>This week · 2026-10-05 – 2026-10-11</h2>");
    expect(html).toContain("≤ 224 (last week 249)");
    expect(html).toContain("hold ≥ 35.0%");
    expect(html).toContain("≤ 180k (last week 200k)");
    expect(html).toContain("<b>41.0%</b>");
  });

  it("shows a missing value as no reading, and an open week under the gate as such, never 0", () => {
    const db = seeded();
    const html = served(db);
    expect(html).toContain(NO_READING);
    sql(db, "UPDATE claude_quests SET requests = 12, value = NULL WHERE status = 'open';");
    const quiet = served(db);
    expect(quiet.split(UNDER_20_SO_FAR)).toHaveLength(4);
    expect(quiet).not.toMatch(/this week<\/span><b>0(\.0)?%?<\/b>/);
  });

  it("logs a week with no reading as no data, never missed", () => {
    const html = served(seeded());
    const log = html.slice(html.indexOf("<h2>Quest log</h2>"));
    const row = log.slice(log.indexOf("2026-09-28"), log.indexOf("</tr>", log.indexOf("2026-09-28")));
    expect(row).toContain("no data");
    expect(row).not.toContain("missed");
  });

  it("shows the stored targets and thresholds: change one and the page follows", () => {
    const db = seeded();
    sql(db, `UPDATE claude_quests SET target = 0.4 WHERE discipline = 'model-routing';
             UPDATE achievement_tiers SET threshold = 95 WHERE achievement = 'seasoned' AND tier = 3;`);
    const html = served(db);
    expect(html).toContain("hold ≥ 40.0%");
    expect(html).toContain("Lv 72 / Lv 95 to gold");
  });

  it("dates an unlocked tier, mutes a locked one, and counts toward the next", () => {
    const html = served(seeded());
    expect(html).toContain("<b>2026-09-27</b>");
    expect(html).toContain("Lv 72 / Lv 90 to gold");
    expect(html).toContain(`<span class="absent">Lv 99</span>`);
    expect(html).toContain("4.2M / 10.0M to silver");
  });

  it("says why there are no quests: none yet, or none this week", () => {
    const db = freshDb();
    sql(db, "INSERT INTO character_points (qp, ap, updated_at) VALUES (0, 0, 0);");
    const none = served(db);
    expect(none).toContain(NO_QUESTS_YET);
    expect(none).toContain(NO_CLOSED_WEEKS);
    const closed = seeded();
    sql(closed, "DELETE FROM claude_quests WHERE status = 'open';");
    const html = served(closed);
    expect(html).toContain(NO_QUESTS_THIS_WEEK);
    expect(html).toContain("<h2>This week</h2>");
  });

  it("cuts the quest log to REPORT_ROWS in the report, and says so", () => {
    const db = freshDb();
    const values = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => {
      const monday = new Date(Date.UTC(2025, 0, 6) + i * 7 * 86400000).toISOString().slice(0, 10);
      const sunday = new Date(Date.UTC(2025, 0, 12) + i * 7 * 86400000).toISOString().slice(0, 10);
      return `('${monday}', '${sunday}', 1, 'reuse', 0, 'at-least', 2, 3, 0, 3, 40, 'done')`;
    }).join(",");
    sql(db, `INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
             VALUES ${values}; INSERT INTO character_points (qp, ap, updated_at) VALUES (${REPORT_ROWS + 5}, 0, 0);`);
    const d = readQuests(db, { now: NOW });
    const report = questsView(d, { served: false, tz: "UTC" }).body;
    const log = (html: string) => html.slice(html.indexOf("<h2>Quest log</h2>"));
    expect(log(report).split("<tr>")).toHaveLength(REPORT_ROWS + 2);
    expect(report).toContain(`This report lists the ${REPORT_ROWS} newest of ${REPORT_ROWS + 5} weeks`);
    expect(log(served(db)).split("<tr>")).toHaveLength(REPORT_ROWS + 7);
  });

  it("sits in the tool row after Character, and is current on its own page", () => {
    expect(TOOLS.map((t) => t.label)).toEqual(["Overview", "Character", "Quests", "Claude Code", "Codex", "Hermes"]);
    expect(page({ title: "x", active: "/quests", body: "" }))
      .toContain(`<span class="pill on t-quests" aria-current="true">Quests</span>`);
  });

  // Spec 6.1: every step, full-marks value and tier threshold lives in rollup.sh.
  it("holds no rule of the rollup's: no number but the formatting ones", () => {
    for (const f of ["lib/read/quests.ts", "lib/render/quests.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const nums = [...new Set(src.match(/(?<![\w.])\d+(\.\d+)?(?![\w.])/g) ?? [])].sort();
      expect({ f, nums: nums.filter((n) => !["0", "1", "10", "20", "100", "1000"].includes(n)) }).toEqual({ f, nums: [] });
    }
  });
});
