import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";

export const OPENVIKING_SOURCE = "openviking";

/**
 * OpenViking, the light touch (spec §3.4): one unauthenticated GET /health per
 * sync, plus the plugin's own last-recall and last-capture files. Never reads
 * the CLI's config (it holds an API key), and copies no memory content, no URL
 * and no session id -- only counts, latency and a reachable flag.
 */
export function createOpenVikingAdapter(opts: {
  db: string; home?: string; baseUrl: string;
  now?: () => number; fetchImpl?: typeof fetch;
}): WatchtowerAdapter {
  const home = opts.home ?? os.homedir();
  const state = path.join(home, ".openviking", "state");
  const now = opts.now ?? Date.now;
  const get = opts.fetchImpl ?? fetch;

  const readJson = (name: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(path.join(state, name), "utf8")) as Record<string, unknown>; }
    catch { return null; }
  };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const pick = (o: Record<string, unknown>, map: Record<string, string>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [metric, field] of Object.entries(map)) {
      const v = field === "committed" ? (typeof o.committed === "boolean" ? (o.committed ? 1 : 0) : undefined) : num(o[field]);
      if (v !== undefined) out[metric] = v;
    }
    return out;
  };
  const reading = (id: string, sec: number, probe: string, metrics: Record<string, number>): WatchtowerRecord => ({
    source: OPENVIKING_SOURCE, sourceRecordId: id, kind: "health",
    timestamp: epochToRfc3339(sec), dimensions: { probe }, metrics,
    authority: "authoritative", schemaVersion: 1,
  });

  return {
    id: OPENVIKING_SOURCE,
    type: "memory",
    label: "OpenViking",
    version: 1,
    capabilities: ["memory", "health"],
    authority: [{
      kind: "health", scope: "own",
      metrics: ["reachable", "recall_count", "recall_latency_ms", "recall_tokens", "capture_turns", "capture_committed"],
    }],

    async detect(): Promise<DetectionResult> {
      return existsSync(state) ? { detected: true, detail: state } : { detected: false, detail: `no ${state}` };
    },

    async health(): Promise<AdapterHealth> {
      return (await this.detect()).detected ? { state: "ok" } : { state: "unavailable" };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      const syncSec = Math.floor(now() / 1000);
      let reachable = 0;
      try {
        const r = await get(new URL("/health", opts.baseUrl), { signal: AbortSignal.timeout(2000) });
        reachable = r.ok ? 1 : 0;
      } catch {
        reachable = 0;
      }
      // One row, overwritten by every sync: a probe per sync was ~105k rows a year
      // under background sync, and the Overview reads only the latest.
      yield reading("reachable:latest", syncSec, "health", { reachable });

      const recall = readJson("last-recall.json");
      const rts = num(recall?.ts);
      if (recall !== null && rts !== undefined) {
        const sec = Math.floor(rts / 1000);
        yield reading(`recall:${sec}`, sec, "recall",
          pick(recall, { recall_count: "count", recall_latency_ms: "latency_ms", recall_tokens: "tokens_used" }));
      }
      const capture = readJson("last-capture.json");
      const cts = num(capture?.ts);
      if (capture !== null && cts !== undefined) {
        const sec = Math.floor(cts / 1000);
        yield reading(`capture:${sec}`, sec, "capture",
          pick(capture, { capture_turns: "turns_captured", capture_committed: "committed" }));
      }
    },
  };
}
