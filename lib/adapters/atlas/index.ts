import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { detectSource, findAtlasDbs } from "../../core/discovery.ts";
import { linkExactSql, resolveCanonicalIds } from "../../core/identity.ts";
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";
import { execSqlBatch, querySql } from "../../core/sql.ts";

export const ATLAS_SOURCE = "atlas";

interface AtlasRow { id: string; native_session_id: string; updated_at: string; checkpoints: number; files: number }

/**
 * Atlas, the light touch (spec §3.4): for each agent_session whose
 * native_session_id is a Claude session, an exact link to Claude's canonical
 * session and two counts. token_totals is never selected: Atlas's tokens
 * disagree with claude_requests by up to 2.03x. Atlas contributes no tokens and
 * no hours.
 */
export function createAtlasAdapter(opts: { db: string; roots: string[]; maxDepth?: number }): WatchtowerAdapter {
  const depth = opts.maxDepth ?? 3;
  return {
    id: ATLAS_SOURCE,
    type: "provenance",
    label: "Atlas",
    version: 1,
    capabilities: ["checkpoints"],
    authority: [{ kind: "checkpoint", scope: "own", metrics: ["atlas_checkpoints", "atlas_files_touched"] }],

    async detect(): Promise<DetectionResult> {
      return detectSource("atlas", { projectRoots: opts.roots, maxDepth: depth });
    },

    async health(): Promise<AdapterHealth> {
      const n = findAtlasDbs(opts.roots, depth).length;
      return n > 0 ? { state: "ok", detail: `${n} Atlas databases` } : { state: "unavailable" };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      for (const file of findAtlasDbs(opts.roots, depth)) {
        const rows = querySql<AtlasRow>(file, `SELECT s.id, s.native_session_id, s.updated_at,
            (SELECT COUNT(*) FROM checkpoint c WHERE c.session_id = s.id) AS checkpoints,
            (SELECT COUNT(*) FROM file_touch f WHERE f.session_id = s.id AND f.deleted = 0) AS files
          FROM agent_session s ORDER BY s.id;`, { readonly: true });
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const claude = resolveCanonicalIds(opts.db, "claude", chunk.map((r) => r.native_session_id), "same_session");
          const linked = chunk.filter((r) => claude.has(r.native_session_id));
          if (linked.length === 0) continue;
          // Identity first: the link must exist before the record resolves through it.
          execSqlBatch(opts.db, linked.map((r) => linkExactSql({
            source: ATLAS_SOURCE, sourceLocalId: r.id, linkKind: "same_session",
            canonicalId: claude.get(r.native_session_id) as string,
            evidence: `agent_session.native_session_id=${r.native_session_id}`,
          })));
          for (const r of linked) {
            const ms = Date.parse(r.updated_at);
            if (!Number.isFinite(ms)) continue;
            yield {
              source: ATLAS_SOURCE, sourceRecordId: r.id, kind: "checkpoint",
              timestamp: epochToRfc3339(Math.floor(ms / 1000)), sessionId: r.id,
              metrics: { atlas_checkpoints: r.checkpoints, atlas_files_touched: r.files },
              authority: "authoritative", schemaVersion: 1,
            };
          }
        }
      }
    },
  };
}
