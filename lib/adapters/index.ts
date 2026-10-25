import { entryLists, type WatchtowerConfig } from "../config.ts";
import type { WatchtowerAdapter } from "../core/adapters.ts";
import { createClaudeAdapter } from "./claude/index.ts";
import { createCodexAdapter } from "./codex/index.ts";
import { createHermesAdapter } from "./hermes/index.ts";
import { createOpenVikingAdapter } from "./openviking/index.ts";
import { createAtlasAdapter } from "./atlas/index.ts";

/**
 * Every enabled source's adapter, in a fixed order. `home` is injected so tests
 * never read the real ~/.codex or ~/.hermes. Absent sources are not filtered
 * here: runSync probes each, and "not detected" is a state, not an error.
 */
export function adaptersFor(cfg: WatchtowerConfig, opts: { home?: string } = {}): WatchtowerAdapter[] {
  const db = cfg.database.path;
  const on = (id: string): boolean => cfg.sources[id] !== undefined && cfg.sources[id].enabled !== false;
  const out: WatchtowerAdapter[] = [];
  if (on("claude")) out.push(createClaudeAdapter({ db }));
  if (on("codex")) out.push(createCodexAdapter({ db, home: opts.home, lists: entryLists("codex", cfg.sources.codex) }));
  if (on("hermes")) out.push(createHermesAdapter({ db, home: opts.home, lists: entryLists("hermes", cfg.sources.hermes) }));
  if (on("openviking")) out.push(createOpenVikingAdapter({ db, home: opts.home, baseUrl: cfg.sources.openviking.baseUrl ?? "http://127.0.0.1:1933" }));
  if (on("atlas")) out.push(createAtlasAdapter({ db, roots: cfg.sources.atlas.projectRoots ?? [] }));
  return out;
}
