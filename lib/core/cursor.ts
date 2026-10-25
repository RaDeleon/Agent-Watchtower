import { statSync } from "node:fs";
import { querySql, sqlNum, sqlStr } from "./sql.ts";

/**
 * A file's size and mtime, as wt_file_cursor stores them. ADVISORY: a match
 * lets sync skip the file, and correctness never depends on it.
 */
export interface FileStamp { size: number; mtimeNs: string }

export function stampOf(p: string): FileStamp {
  const st = statSync(p, { bigint: true });
  return { size: Number(st.size), mtimeNs: st.mtimeNs.toString() };
}

export function unchanged(prev: FileStamp | undefined, now: FileStamp): boolean {
  return prev !== undefined && prev.size === now.size && prev.mtimeNs === now.mtimeNs;
}

export function readFileCursor(db: string, source: string): Map<string, FileStamp> {
  const rows = querySql<{ path: string; size: number; mtime_ns: string }>(db,
    `SELECT path, size, mtime_ns FROM wt_file_cursor WHERE source = ${sqlStr(source)};`);
  return new Map(rows.map((r) => [r.path, { size: r.size, mtimeNs: String(r.mtime_ns) }]));
}

export function fileCursorSql(source: string, path: string, s: FileStamp): string {
  return `INSERT INTO wt_file_cursor (source, path, size, mtime_ns)
    VALUES (${sqlStr(source)}, ${sqlStr(path)}, ${sqlNum(s.size)}, ${sqlStr(s.mtimeNs)})
    ON CONFLICT(source, path) DO UPDATE SET
      size = excluded.size, mtime_ns = excluded.mtime_ns;`;
}
