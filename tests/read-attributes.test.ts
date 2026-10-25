import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readAttributes } from "@/lib/read/attributes";
import { buildAndRoll } from "./helpers/fixture-db";

describe("readAttributes", () => {
  it("reads six attributes in order with their stored values", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    const a = readAttributes(db, 99);
    expect(a.pending).toBe(false);
    expect(a.attributes.map((x) => x.id)).toEqual(["str", "dex", "con", "int", "wis", "cha"]);
    const cha = a.attributes[5];
    expect([cha.form30, cha.base, cha.now, cha.level]).toEqual([null, null, null, null]);
    expect(a.attributes[2].level!.cap).toBe(99);
  });
  it("follows a stored Form, never computing one", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, "UPDATE character_attributes SET form_30 = 42, form_7 = 7, boost = -7 WHERE attribute = 'con';"]);
    const con = readAttributes(db, 99).attributes[2];
    expect([con.form30, con.form7, con.boost]).toEqual([42, 7, -7]);
  });
  it("empty v11 tables read as pending", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, "DELETE FROM character_attributes;"]);
    expect(readAttributes(db, 99)).toEqual({ pending: true, asOfDay: null, attributes: [], lowest: null });
    execFileSync("sqlite3", [db, "DROP TABLE character_attributes;"]);
    expect(readAttributes(db, null).pending).toBe(true);
  });
  it("the lowest-Form footer names this week's quests from the attribute's own sources", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    // The fixture's STR and DEX read 1 and 0: lift them so INT is the lowest.
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = 5 WHERE attribute IN ('str', 'dex');
      UPDATE character_attributes SET form_30 = 1 WHERE attribute = 'int';
      DELETE FROM claude_quests;
      INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
      VALUES ('2026-09-28', '2026-10-04', 1, 'cost-discipline', 0, 'at-most', 40, 30, 0, NULL, 0, 'open'),
             ('2026-09-28', '2026-10-04', 2, 'verification', 0, 'at-least', 0.1, 0.2, 0, NULL, 0, 'open'),
             ('2026-09-21', '2026-09-27', 1, 'context-hygiene', 0, 'at-most', 1, 1, 0, NULL, 0, 'missed');`]);
    expect(readAttributes(db, 99).lowest).toEqual({ id: "int", quests: [{ discipline: "cost-discipline", name: "Lean cache" }] });
  });
  // The fixture's latest week holds cost-discipline, model-routing and context-hygiene, so INT
  // and WIS have quests to list; each test below sets the Forms it relies on. Only "with no
  // quests" pins the attribute-only shape; the two after it assert identities (R21).
  it("a measured Form of 0 is the lowest, never no reading", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = CASE attribute
      WHEN 'int' THEN 0 WHEN 'str' THEN 1 WHEN 'dex' THEN 5 ELSE form_30 END;`]);
    expect(readAttributes(db, 99).lowest?.id).toBe("int");
  });
  it("two equal lowest Forms go to the lower ord", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    // WIS (ord 5) before CHA (ord 6), though CHA sorts first by name. The rows already arrive
    // ORDER BY ord and the sort is stable, so this pins the tie-break's direction, not its presence.
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = CASE attribute
      WHEN 'wis' THEN 3 WHEN 'cha' THEN 3 WHEN 'str' THEN 5 WHEN 'dex' THEN 5 ELSE form_30 END;`]);
    expect(readAttributes(db, 99).lowest?.id).toBe("wis");
  });
  it("with no quests this week it names the lowest attribute only", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = CASE attribute
      WHEN 'int' THEN 1 WHEN 'str' THEN 5 WHEN 'dex' THEN 5 ELSE form_30 END;
      DELETE FROM claude_quests;`]);
    expect(readAttributes(db, 99).lowest).toEqual({ id: "int", quests: [] });
  });
  it("a missing claude_quests table reads as an empty one", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = CASE attribute
      WHEN 'int' THEN 1 WHEN 'str' THEN 5 WHEN 'dex' THEN 5 ELSE form_30 END;
      DELETE FROM claude_quests;`]);
    const empty = readAttributes(db, 99).lowest;
    execFileSync("sqlite3", [db, "DROP TABLE claude_quests;"]);
    expect(readAttributes(db, 99).lowest).toEqual(empty);
  });
  it("STR lists no quests, even with this week's discipline in its evidence", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = CASE attribute
      WHEN 'str' THEN 1 WHEN 'dex' THEN 5 ELSE form_30 END;`]);
    const plain = readAttributes(db, 99).lowest;
    // A discipline key in STR's evidence: now only the STR rule keeps the list empty.
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET evidence_json = json_set(evidence_json, '$."model-routing"', 0)
      WHERE attribute = 'str';`]);
    expect(readAttributes(db, 99).lowest).toEqual(plain);
  });
});
