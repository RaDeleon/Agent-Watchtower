import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectionResult } from "./adapters.ts";

export interface DetectOptions {
  /** Probed instead of os.homedir(). Tests depend on this being load-bearing. */
  home?: string;
  /** Roots to search for per-repository state. Empty means "search nowhere". */
  projectRoots?: string[];
  /** Bounded: Atlas state is per-repo, so this never walks the whole home dir. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 3;

/** Where Watchtower looks for a tool: one definition for discovery and for the pages. */
export function lookedAt(id: "codex" | "hermes", home: string = os.homedir()): string {
  return id === "codex"
    ? path.join(home, ".codex", "sessions")
    : path.join(home, ".hermes", "state.db");
}

/**
 * Probe for a source. NEVER throws -- a missing source is a state, not an error.
 *
 * Discovery runs over every known source in turn, so one unreadable directory
 * (a permission-denied mount, a dangling symlink) must not take the rest of the
 * sweep with it. Every failure becomes `{ detected: false, detail }`.
 */
export async function detectSource(
  id: string, opts: DetectOptions = {},
): Promise<DetectionResult> {
  const home = opts.home ?? os.homedir();
  try {
    switch (id) {
      case "claude": {
        const p = path.join(home, ".claude");
        return existsSync(p) ? { detected: true, detail: p } : { detected: false };
      }
      case "codex": {
        const p = lookedAt("codex", home);
        // An empty sessions directory is the installed-but-unused case: the
        // adapter would have nothing to read, so report it as not detected
        // rather than registering a source that can never produce a record.
        if (!existsSync(p) || readdirSync(p).length === 0) return { detected: false };
        return { detected: true, detail: p };
      }
      case "hermes": {
        const p = lookedAt("hermes", home);
        return existsSync(p) ? { detected: true, detail: p } : { detected: false };
      }
      case "atlas": {
        // BOUNDED ON PURPOSE. Atlas keeps its state per repository, in
        // <repo>/.atlas/sessions.db. Finding every repo would mean walking the
        // whole home directory, which is both slow and a surprising thing for a
        // passive observer to do, so the search covers only the roots the user
        // configured and stops at a fixed depth below each one.
        const depth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
        for (const root of opts.projectRoots ?? []) {
          const hit = findAtlas(root, depth);
          if (hit) return { detected: true, detail: hit };
        }
        return { detected: false };
      }
      default:
        return { detected: false, detail: `unknown source: ${id}` };
    }
  } catch (e) {
    return { detected: false, detail: String(e) };
  }
}

function findAtlas(root: string, depth: number): string | null {
  if (depth < 0 || !existsSync(root)) return null;
  const direct = path.join(root, ".atlas", "sessions.db");
  if (existsSync(direct)) return direct;
  if (depth === 0) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const child = path.join(root, e);
    // Not followed through symlinks: a symlink back up the tree would otherwise
    // be walked repeatedly, and the depth bound is the only thing stopping it.
    try { if (!statSync(child).isDirectory()) continue; } catch { continue; }
    const hit = findAtlas(child, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Every <dir>/.atlas/sessions.db under the roots, to a fixed depth, sorted.
 * Bounded and dot-dir-skipping exactly as findAtlas is: a passive observer
 * never walks the whole home directory.
 */
export function findAtlasDbs(roots: readonly string[], depth: number = DEFAULT_MAX_DEPTH): string[] {
  const out = new Set<string>();
  const walk = (dir: string, d: number): void => {
    if (d < 0 || !existsSync(dir)) return;
    const direct = path.join(dir, ".atlas", "sessions.db");
    if (existsSync(direct)) out.add(direct);
    if (d === 0) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const child = path.join(dir, e);
      try { if (!statSync(child).isDirectory()) continue; } catch { continue; }
      walk(child, d - 1);
    }
  };
  for (const r of roots) walk(r, depth);
  return [...out].sort();
}
