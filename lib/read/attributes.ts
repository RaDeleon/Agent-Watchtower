/**
 * The six attributes (Stage 10, spec §5). Reads character_attributes,
 * skill_progress (source 'character') and claude_quests, and computes
 * nothing: every Form, boost and level is stored by rollup.sh. Before the
 * first v11 rollup the data is "pending", never an error or a Lv 1.
 */
import { querySql } from "../core/sql.ts";
import { hasTable, type Level } from "./level.ts";
import { QUESTS } from "./quests.ts";

export type AttributeId = "str" | "dex" | "con" | "int" | "wis" | "cha";
export const ATTRIBUTE_NAMES: Record<AttributeId, { abbr: string; name: string }> = {
  str: { abbr: "STR", name: "Strength" },
  dex: { abbr: "DEX", name: "Dexterity" },
  con: { abbr: "CON", name: "Constitution" },
  int: { abbr: "INT", name: "Intelligence" },
  wis: { abbr: "WIS", name: "Wisdom" },
  cha: { abbr: "CHA", name: "Charisma" },
};

export interface Attribute {
  id: AttributeId;
  ord: number;
  form30: number | null;
  form7: number | null;
  boost: number | null;
  base: number | null;
  now: number | null;
  /** skill_progress (source 'character'); null with no XP. */
  level: Level | null;
  /** Claude attributes: discipline -> 30-day score (null = no reading). STR: per_hour_30, per_hour_7. */
  evidence: Record<string, number | null>;
}

export interface AttributesData {
  /** No character_attributes table, or no rows yet: before the first v11 rollup. */
  pending: boolean;
  asOfDay: string | null;
  /** ord order. */
  attributes: Attribute[];
  /** The lowest measured 30-day Form (ties by ord); null when none is measured. */
  lowest: { id: AttributeId; quests: Array<{ discipline: string; name: string }> } | null;
}

interface AttrRow {
  attribute: string; ord: number; as_of_day: string; form_30: number | null; form_7: number | null;
  boost: number | null; base_level: number | null; now_level: number | null; evidence_json: string;
}
interface ProgRow {
  key: string; active_s: number; xp: number; level: number; tier: string;
  xp_into_level: number; xp_to_next: number | null; s_to_next: number | null; stars: number;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const PENDING: AttributesData = { pending: true, asOfDay: null, attributes: [], lowest: null };

export function readAttributes(db: string, cap: number | null): AttributesData {
  if (!hasTable(db, "character_attributes")) return PENDING;
  const rows = read<AttrRow>(db, `SELECT attribute, ord, as_of_day, form_30, form_7, boost, base_level, now_level,
      evidence_json FROM character_attributes ORDER BY ord;`);
  if (rows.length === 0) return PENDING;
  const prog = new Map(read<ProgRow>(db, `SELECT key, active_s, xp, level, tier, xp_into_level, xp_to_next,
      s_to_next, stars FROM skill_progress WHERE source = 'character' AND kind = 'attribute';`).map((r) => [r.key, r]));
  const attributes = rows.map((r): Attribute => {
    const p = prog.get(r.attribute);
    return {
      id: r.attribute as AttributeId, ord: r.ord,
      form30: r.form_30, form7: r.form_7, boost: r.boost, base: r.base_level, now: r.now_level,
      level: p === undefined ? null : {
        source: "character", activeS: p.active_s, xp: p.xp, level: p.level, tier: p.tier,
        xpIntoLevel: p.xp_into_level, xpToNext: p.xp_to_next, sToNext: p.s_to_next, stars: p.stars, cap,
      },
      evidence: JSON.parse(r.evidence_json) as Record<string, number | null>,
    };
  });
  const measured = attributes.filter((a) => a.form30 !== null)
    .sort((a, b) => a.form30! - b.form30! || a.ord - b.ord);
  let lowest: AttributesData["lowest"] = null;
  if (measured.length > 0) {
    const a = measured[0];
    const quests = hasTable(db, "claude_quests") && a.id !== "str"
      ? read<{ discipline: string }>(db, `SELECT discipline FROM claude_quests
          WHERE week = (SELECT MAX(week) FROM claude_quests) ORDER BY slot;`)
        .filter((q) => q.discipline in a.evidence && QUESTS[q.discipline] !== undefined)
        .map((q) => ({ discipline: q.discipline, name: QUESTS[q.discipline].name }))
      : [];
    lowest = { id: a.id, quests };
  }
  return { pending: false, asOfDay: rows[0].as_of_day, attributes, lowest };
}
