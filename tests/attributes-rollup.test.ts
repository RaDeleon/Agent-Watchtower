import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { createHermesAdapter } from "@/lib/adapters/hermes";
import { entryLists } from "@/lib/config";
import { DISCIPLINE_ORDER } from "@/lib/read/profile";
import { roll, seedAgents, type AgentEvent, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

// Stage 10 (spec 4.3-4.8, 6.1). Guards 1-11 each own one test below (R21: their
// literals live there alone); the identities assert no literal.

const ASOF = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };
type Attr = { attribute: string; ord: number; as_of_day: string; form_30: number | null; form_7: number | null;
  boost: number | null; base_level: number | null; now_level: number | null; evidence_json: string };
const sheet = (db: string) => rows<Attr>(db, "SELECT * FROM character_attributes ORDER BY ord;");
const attr = (db: string, a: string) => sheet(db).find((r) => r.attribute === a)!;
const train = (db: string, a: string) => rows<{ day: string; active_ms: number }>(db,
  `SELECT day, active_ms FROM skill_daily WHERE source = 'character' AND kind = 'attribute' AND key = '${a}' ORDER BY day;`);
const scores = (db: string, day: string) => rows<{ discipline: string; score: number; status: string }>(db,
  `SELECT discipline, score, status FROM claude_discipline_scores WHERE day = '${day}';`);
/** The spec's Form from stored scores: measured constituents only (spec 4.3). */
const formOf = (db: string, day: string, of: string[]): number | null => {
  const m = scores(db, day).filter((s) => of.includes(s.discipline) && s.status !== "needs-data");
  return m.length === 0 ? null : Math.round((m.reduce((a, s) => a + s.score, 0) / m.length) * 99 / 60);
};

/** One driven Codex session on `day`: `seconds` of driven time, `tout` output tokens. */
function codexDay(id: string, day: string, seconds: number, tout: number): SeedSession {
  const t0 = Date.parse(`${day}T10:00:00Z`) / 1000;
  const events: Array<[number, AgentEvent]> = [[t0, "session_start"], [t0 + 30, "prompt"]];
  for (let s = 330; s < seconds; s += 300) events.push([t0 + s, "activity"]);
  events.push([t0 + seconds, "stop"]);
  return { source: "codex", id, entry: "Codex Desktop", driven: 1, startedAt: t0, cwd: "/tmp/wt-at",
    events, requests: [{ id: `${id}-r`, ts: t0 + 60, model: "gpt-5.5", tout }] };
}
const codexMs = (db: string) => rows<{ ms: number }>(db,
  "SELECT COALESCE(SUM(active_ms), 0) AS ms FROM skill_daily WHERE source = 'codex' AND kind = 'tool';")[0].ms;
function codexDb(sessions: SeedSession[], env = ASOF): string {
  const db = buildAndRoll("resumed");
  seedAgents(db, sessions);
  roll(db, env);
  return db;
}
const MAKE_HERMES = path.join(__dirname, "fixtures", "make-hermes-db.sh");
async function hermesDb(scenario: string, env: Record<string, string> = {}): Promise<string> {
  const home = mkdtempSync(path.join(tmpdir(), "wt-at-hermes-"));
  execFileSync("bash", [MAKE_HERMES, scenario, path.join(home, ".hermes", "state.db")]);
  const db = buildAndRoll("resumed");
  applyWtSchema(db);
  await runSync({ db, adapters: [createHermesAdapter({ db, home, lists: entryLists("hermes", undefined) })] });
  roll(db, env);
  return db;
}

let ad: string; // attr-days
let legend: string; // Hermes past 200
let boost: string; // guard 4's Codex days, shared with the Now identity
let floor: string; // attr-floor: a drain larger than Base
beforeAll(async () => {
  ad = buildAndRoll("attr-days", ASOF);
  legend = await hermesDb("legend");
  // 10 h with no output on 09-10, then an hour at 120,000 on the as-of day
  // itself, so guard 4's 30-day Form never leans on R4's as-of row.
  boost = codexDb([codexDay("o", "2026-09-10", 36000, 0), codexDay("n", "2026-09-30", 3600, 120000)]);
  floor = buildAndRoll("attr-floor", ASOF);
}, slow(120000));

describe("Stage 10: Form and training", () => {
  // Guard 1. WIS on 09-30: verification and security are needs-data, model-routing is measured.
  // CHA's one constituent is needs-data on every day, so it has no Form at all, never 0.
  it("needs-data is left out of Form", () => {
    const wis = scores(ad, "2026-09-30").filter((s) => ["verification", "model-routing", "security"].includes(s.discipline));
    expect(wis.filter((s) => s.status === "needs-data").length).toBe(2);
    expect(attr(ad, "wis").form_30).toBe(formOf(ad, "2026-09-30", ["verification", "model-routing", "security"]));
    expect(attr(ad, "wis").form_30).not.toBeNull();
    expect(attr(ad, "cha").form_30).toBeNull();
  });

  // Guard 2. INT trains on 09-01 and 09-15, each at its own day's Form.
  it("each day trains at that day's Form", () => {
    const of = ["context-hygiene", "cost-discipline"];
    const days = train(ad, "int");
    expect(days.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-15"]);
    expect(formOf(ad, "2026-09-01", of)).not.toBe(formOf(ad, "2026-09-15", of));
    for (const d of days) {
      const ms = rows<{ ms: number }>(ad, `SELECT active_ms AS ms FROM claude_daily_rollups WHERE day = '${d.day}';`)[0].ms;
      expect(d.active_ms).toBe(Math.floor((ms * formOf(ad, d.day, of)!) / 99));
    }
  });

  // Guard 3. 59 minutes is no reading; an hour at 96,000 output tokens is 79.
  it("Strength needs an active hour", () => {
    const short = codexDb([codexDay("s", "2026-09-30", 3540, 96000)]);
    expect(codexMs(short)).toBe(3540000);
    expect([attr(short, "str").form_30, attr(short, "str").form_7]).toEqual([null, null]);
    expect(train(short, "str")).toEqual([]);
    const hour = codexDb([codexDay("h", "2026-09-30", 3600, 96000)]);
    expect(codexMs(hour)).toBe(3600000);
    expect([attr(hour, "str").form_30, attr(hour, "str").form_7]).toEqual([79, 79]);
  });

  // R5 as amended: STR's hours are driven-only, so its output is too. An
  // automated session's 60,000 tokens beside a driven hour of 60,000 still reach
  // agent_daily_rollups, and leave Strength where the driven hour alone puts it.
  it("Strength counts driven output only", () => {
    const driven = codexDay("d", "2026-09-30", 3600, 60000);
    const automated: SeedSession = { ...codexDay("a", "2026-09-30", 3600, 60000), entry: "codex_exec", driven: 0 };
    const alone = codexDb([driven]);
    const both = codexDb([driven, automated]);
    const str = (db: string) => {
      const s = attr(db, "str");
      return [s.form_30, JSON.parse(s.evidence_json).per_hour_30];
    };
    const out = (db: string) => rows<{ t: number }>(db,
      "SELECT SUM(tokens_out) AS t FROM agent_daily_rollups WHERE source = 'codex';")[0].t;
    expect(str(alone)).not.toContain(null);
    expect(codexMs(both)).toBe(codexMs(alone));
    expect(out(both)).toBe(out(alone) + 60000);
    expect(str(both)).toEqual(str(alone));
  }, slow(30000));

  // Review Focus 3 (R4): nothing on the as-of day itself.
  it("a quiet as-of day still has a 30-day Strength Form", () => {
    const db = codexDb([codexDay("q", "2026-09-20", 3600, 96000)]);
    expect(attr(db, "str").form_30).not.toBeNull();
  });
});

describe("Stage 10: boost and Now", () => {
  // Guard 4. 10 h with no output on 09-10, then an hour at 120,000 on 09-30:
  // 30 days read 9, the last 7 read 99, a raw boost of 18.
  it("the boost is clamped to ten", () => {
    expect(codexMs(boost)).toBe(39600000);
    const s = attr(boost, "str");
    expect([s.form_30, s.form_7, s.boost]).toEqual([9, 99, 10]);
  });

  // Guard 5. attr-days' 7-day window of 09-30 is gated.
  it("no 7-day reading means no boost", () => {
    expect(rows(ad, "SELECT * FROM claude_discipline_scores_7d;")).toEqual([]);
    const con = attr(ad, "con");
    expect(con.form_30).not.toBeNull();
    expect(con.base_level).not.toBeNull();
    expect([con.form_7, con.boost, con.now_level]).toEqual([null, null, con.base_level]);
  });
});

describe("Stage 10: past 99", () => {
  // Guard 8. 101,339,999 s: 1,439,999 s past Lv 200's 99,900,000 is 1.6 stars, floored.
  // No tier here: Eternal is guard 7's literal (R21).
  it("stars start past 200", () => {
    expect(rows(legend, `SELECT level, xp_to_next, s_to_next, stars FROM agent_progress WHERE source = 'hermes';`))
      .toEqual([{ level: 200, xp_to_next: null, s_to_next: null, stars: 1 }]);
  });

  // Guard 7.
  it("tiers past Master", () => {
    const at = rows<{ level: number; tier: string; tier_changed: number }>(legend, `SELECT level, tier, tier_changed
      FROM skill_level_ups WHERE source = 'hermes' AND kind = 'tool' AND level IN (98, 99, 119, 120, 149, 150, 169, 170, 199, 200)
      ORDER BY level;`);
    expect(at.map((r) => [r.level, r.tier, r.tier_changed])).toEqual([
      [98, "Pro", 0], [99, "Master", 1], [119, "Master", 0], [120, "Grandmaster", 1], [149, "Grandmaster", 0],
      [150, "Legend", 1], [169, "Legend", 0], [170, "Mythic", 1], [199, "Mythic", 0], [200, "Eternal", 1],
    ]);
  });

  // Guard 10. Each cap opens on the day a stat first reaches the cap below; the
  // Hermes tool, project and model reach each level together, and the tool wins.
  it("a cap opens on the day a stat reaches it", () => {
    const caps = rows<{ cap: number; reached_level: number | null; opened_day: string | null; source: string | null; kind: string | null; key: string | null }>(
      legend, "SELECT * FROM level_caps ORDER BY cap;");
    expect(caps.map((c) => [c.cap, c.reached_level, c.source, c.kind, c.key])).toEqual([
      [99, null, null, null, null], [120, 99, "hermes", "tool", "hermes"], [150, 120, "hermes", "tool", "hermes"],
      [170, 150, "hermes", "tool", "hermes"], [200, 170, "hermes", "tool", "hermes"],
    ]);
    expect(caps[0].opened_day).toBeNull();
  });

  // Guard 9. The 11,699,999 s veteran (Lv 101) with pace: its 99 ETA is NULL, not negative.
  it("the 99 ETA stops at 99", async () => {
    const last = new Date((1700000000 + 11699999) * 1000).toISOString().slice(0, 10);
    const db = await hermesDb("veteran", { WATCHTOWER_ROLLUP_TODAY: last });
    const [p] = rows<{ eta_next_days: number | null; eta_99_days: number | null; eta_cap_days: number | null }>(db,
      "SELECT eta_next_days, eta_99_days, eta_cap_days FROM skill_pace WHERE source = 'hermes';");
    expect(p.eta_next_days).not.toBeNull();
    expect(p.eta_99_days).toBeNull();
    expect(p.eta_cap_days! >= p.eta_next_days!).toBe(true);
  }, slow(60000));

  // Guard 11 (R7).
  it("attributes have no pace", () => {
    for (const db of [ad, legend]) {
      const pace = rows<{ source: string; xp_28d: number }>(db, "SELECT source, xp_28d FROM skill_pace;");
      expect(pace.map((p) => p.source)).not.toContain("character");
      const tools = pace.filter((p) => p.source !== "all").reduce((a, p) => a + p.xp_28d, 0);
      expect(pace.find((p) => p.source === "all")!.xp_28d).toBe(tools);
    }
  });
});

describe("Stage 10: identities", () => {
  it("each attribute's lifetime seconds are its training rows", () => {
    for (const db of [ad, legend]) {
      const prog = rows<{ key: string; active_s: number }>(db,
        "SELECT key, active_s FROM skill_progress WHERE source = 'character' AND kind = 'attribute';");
      for (const p of prog) {
        expect(p.active_s).toBe(Math.floor(train(db, p.key).reduce((a, d) => a + d.active_ms, 0) / 1000));
      }
    }
  });

  // A day with no tool hours has no h row: its hours are 0, so any training on it fails.
  it("no day trains more than its hours, and none trains nothing", () => {
    for (const db of [ad, legend]) {
      const bad = rows(db, `SELECT a.key, a.day FROM skill_daily a
        LEFT JOIN (SELECT day, SUM(active_ms) AS all_ms, SUM(CASE WHEN source = 'claude' THEN active_ms ELSE 0 END) AS claude_ms
                   FROM skill_daily WHERE kind = 'tool' GROUP BY day) h ON h.day = a.day
        WHERE a.source = 'character' AND a.kind = 'attribute'
          AND (a.active_ms <= 0
               OR a.active_ms > COALESCE(CASE WHEN a.key = 'str' THEN h.all_ms ELSE h.claude_ms END, 0));`);
      expect(bad).toEqual([]);
    }
  });

  // Non-vacuity: the four sheets hold a boost that moves Now (guard 4's) and a
  // drain past Base that the rollup itself floors at 1 (attr-floor).
  it("Now is Base plus the boost, never below 1", () => {
    const all = [ad, legend, boost, floor].flatMap((db) => sheet(db));
    for (const a of all) {
      expect(a.now_level).toBe(a.base_level === null ? null : Math.max(1, a.base_level + (a.boost ?? 0)));
    }
    expect(all.some((a) => a.base_level !== null && a.boost !== null && a.boost > 0)).toBe(true);
    expect(all.some((a) => a.base_level !== null && a.boost !== null && a.base_level + a.boost < 1 && a.now_level === 1))
      .toBe(true);
  });

  it("each opened cap is dated by the first level-up at its level", () => {
    const caps = rows<{ reached_level: number; opened_day: string }>(legend,
      "SELECT reached_level, opened_day FROM level_caps WHERE opened_day IS NOT NULL;");
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.opened_day).toBe(rows<{ d: string }>(legend,
        `SELECT MIN(day) AS d FROM skill_level_ups WHERE level = ${c.reached_level};`)[0].d);
    }
  });

  it("every discipline maps to exactly one attribute", () => {
    const keys = sheet(ad).filter((a) => a.attribute !== "str").flatMap((a) => Object.keys(JSON.parse(a.evidence_json)));
    expect([...keys].sort()).toEqual([...DISCIPLINE_ORDER].sort());
    expect(Object.keys(JSON.parse(attr(ad, "str").evidence_json)).sort()).toEqual(["per_hour_30", "per_hour_7"]);
  });

  it("always writes six attributes in order and the 99 cap", () => {
    for (const db of [ad, legend]) {
      expect(sheet(db).map((a) => [a.attribute, a.ord])).toEqual([
        ["str", 1], ["dex", 2], ["con", 3], ["int", 4], ["wis", 5], ["cha", 6],
      ]);
      expect(rows(db, "SELECT cap FROM level_caps WHERE cap = 99;")).toEqual([{ cap: 99 }]);
    }
  });

  // The precondition reads the stored scores, not CHA's Form: that literal is
  // guard 1's (R21), so dropping the needs-data filter reds only guard 1.
  it("an attribute with no measured Form has no XP and no level, never Lv 1", () => {
    // prompt-hygiene is needs-data on every scored day: no tool calls.
    expect(rows(ad, "SELECT DISTINCT status FROM claude_discipline_scores WHERE discipline = 'prompt-hygiene';"))
      .toEqual([{ status: "needs-data" }]);
    const cha = attr(ad, "cha");
    expect([cha.base_level, cha.now_level]).toEqual([null, null]);
    expect(train(ad, "cha")).toEqual([]);
  });
});
