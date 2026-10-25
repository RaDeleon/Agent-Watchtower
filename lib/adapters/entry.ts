import { sqlStr } from "../core/sql.ts";

/**
 * Which entry points count as a person driving the tool (spec decision 7).
 * Lists come from lib/config.ts; nothing here knows a tool's defaults.
 */
export interface EntryLists { driven: readonly string[]; automated: readonly string[] }

/** 1 driven, 0 automated, null unclassified. A spawned subagent is always automated (R2). */
export function classifyEntry(entry: string | null | undefined, lists: EntryLists): 0 | 1 | null {
  if (entry === null || entry === undefined) return null;
  if (entry.startsWith("subagent:")) return 0;
  if (lists.driven.includes(entry)) return 1;
  if (lists.automated.includes(entry)) return 0;
  return null;
}

const inList = (xs: readonly string[]) => (xs.length === 0 ? "(NULL)" : `(${xs.map(sqlStr).join(", ")})`);

/**
 * classifyEntry for EVERY stored session of a source, as one UPDATE (R18), so a
 * config change reaches sessions in files the cursor skips. It must agree with
 * classifyEntry exactly; tests/adapter-entry.test.ts runs both over one table.
 */
export function reclassifySql(source: string, lists: EntryLists): string {
  return `UPDATE wt_sessions SET driven = CASE
      WHEN entry IS NULL               THEN NULL
      WHEN entry LIKE 'subagent:%'     THEN 0
      WHEN entry IN ${inList(lists.driven)}    THEN 1
      WHEN entry IN ${inList(lists.automated)} THEN 0
      ELSE NULL END
    WHERE first_source = ${sqlStr(source)};`;
}
