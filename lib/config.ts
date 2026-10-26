import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WatchtowerConfig {
  schemaVersion: number;
  database: { path: string };
  capture: { installDir: string };
  coach: { mode: "cli" | "api"; apiKey: string | null };
  /** Display-only grouping: label -> repo display names. Never enters the SQL. */
  projectGroups: Record<string, string[]>;
  /** Path prefixes and globs whose work is keyed (excluded) rather than shown. */
  excludePaths: string[];
  /**
   * Telemetry sources. ABSENT MEANS CLAUDE ONLY, ENABLED -- so every config
   * written before Stage 3 keeps working untouched.
   */
  sources: Record<string, SourceConfig>;
  dashboard: DashboardConfig;
}

export interface SourceConfig {
  enabled: boolean;
  type: string;
  /** Atlas only: scan these roots for .atlas/sessions.db. Bounded, never $HOME. */
  projectRoots?: string[];
  autoDiscover?: boolean;
  baseUrl?: string;
  /** Name of the env var holding the key -- never the key itself. */
  apiKeyEnv?: string;
  /** Codex and Hermes: entry points that count as driven or automated (decision 7). */
  driven?: string[];
  automated?: string[];
}

export interface DashboardConfig {
  port: number;
  host: string;
  pollSeconds: number;
  /** Background sync while the dashboard is open (R13). 0 is off. */
  syncSeconds: number;
}

// Measured on the live machine 2026-10-03; spec §3.2/§3.3 and plan R4.
export const CODEX_DRIVEN = ["Codex Desktop", "codex_work_desktop", "codex-tui", "codex_vscode",
  "codex-chrome-extension-sidepanel", "codex_cli_rs"] as const;
// Measured on the live machine 2026-10-03; spec §3.2/§3.3 and plan R4.
export const CODEX_AUTOMATED = ["codex_exec", "buzz-acp", "codex_sdk_ts"] as const;
// Measured on the live machine 2026-10-03; spec §3.2/§3.3 and plan R4.
export const HERMES_DRIVEN = ["cli", "tui", "telegram"] as const;
// Measured on the live machine 2026-10-03; spec §3.2/§3.3 and plan R4.
export const HERMES_AUTOMATED = ["api_server"] as const;
/** The shortest background-sync interval config may ask for, in seconds (R11). */
export const MIN_SYNC_SECONDS = 60;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Loopback check, shared with the server.
 *
 * Config validation alone would leave the bind address trusting its caller;
 * `startDashboard` re-checks with this same set, so there is exactly one
 * definition of what counts as loopback.
 */
/** The shortest Live poll interval config may ask for, in seconds. */
export const MIN_POLL_SECONDS = 1;

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Default database path.
 *
 * `capture/lib.sh`'s cc_db_path MUST resolve identically. It is the writer and
 * this is the reader; every write on the hook path swallows its own error, so a
 * split between them surfaces as an empty dashboard, not as a failure.
 */
export function defaultDbPath(): string {
  return path.join(os.homedir(), ".watchtower", "watchtower.sqlite");
}

function syncSecondsOf(v: unknown, raw: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || (v !== 0 && v < MIN_SYNC_SECONDS)) {
    throw new Error(`Invalid ${where}: expected 0 (off) or an integer number of seconds >= ${MIN_SYNC_SECONDS}, got ${JSON.stringify(raw)}`);
  }
  return v;
}

/** A source's driven/automated lists, falling back to the shipped defaults. */
export function entryLists(id: "codex" | "hermes", sc: SourceConfig | undefined): { driven: string[]; automated: string[] } {
  const d = id === "codex" ? CODEX_DRIVEN : HERMES_DRIVEN;
  const a = id === "codex" ? CODEX_AUTOMATED : HERMES_AUTOMATED;
  return { driven: sc?.driven ?? [...d], automated: sc?.automated ?? [...a] };
}

function defaults(): WatchtowerConfig {
  return {
    schemaVersion: 11,
    database: { path: defaultDbPath() },
    capture: { installDir: path.join(os.homedir(), ".claude") },
    coach: { mode: "cli", apiKey: null },
    projectGroups: {},
    // Every source is on by default; one that is absent is reported as "not
    // detected" by sync, not an error. Turn one off by naming it with enabled:false.
    sources: {
      claude: { enabled: true, type: "claude" },
      codex: { enabled: true, type: "codex", driven: [...CODEX_DRIVEN], automated: [...CODEX_AUTOMATED] },
      hermes: { enabled: true, type: "hermes", driven: [...HERMES_DRIVEN], automated: [...HERMES_AUTOMATED] },
      openviking: { enabled: true, type: "openviking", baseUrl: "http://127.0.0.1:1933" },
      atlas: { enabled: true, type: "atlas", projectRoots: [expandHome("~/Developer")] },
    },
    dashboard: { port: 4317, host: "127.0.0.1", pollSeconds: 5, syncSeconds: 300 },
    // Measured 2026-09-10: together 1,836 of 2,485 sessions (74%) but only
    // ~0.37 of ~197 active hours (0.19%) -- almost pure session-count noise
    // carrying no real time. The last three are PATTERNS, not observed paths:
    // Claude Code mints a new scratchpad per session.
    excludePaths: [
      expandHome("~/Library/Application Support/CodexBar/ClaudeProbe"),
      expandHome("~/.meridian"),
      expandHome("~/Library/Application Support/Claude/scratch-workspaces"),
      "/private/tmp/claude-*",
      "/private/var/folders/*/T/cc-headless-*",
    ],
  };
}

const CONFIG_FILE = "watchtower.config.json";

/** This checkout: the directory holding `lib/`, `bin/` and `capture/`. */
const CHECKOUT_DIR = path.resolve(import.meta.dirname, "..");

/**
 * The config file `loadConfig` reads when no `configPath` is given: the current
 * directory's `watchtower.config.json`, else the checkout's, else none. Only one
 * file is ever read; the two are never merged.
 *
 * The checkout is the fallback because `watchtower setup` writes its config
 * there, and the linked CLI normally runs from some other directory.
 */
export function configFileFor(cwd: string, checkoutDir: string): string | null {
  for (const dir of [cwd, checkoutDir]) {
    const p = path.join(dir, CONFIG_FILE);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve configuration. Precedence, lowest to highest:
 *   built-in defaults  <  config file  <  environment variables
 *
 * The config file is `opts.configPath` when given. Otherwise it is
 * `configFileFor(cwd, checkoutDir)`: `<cwd>/watchtower.config.json`, else
 * `<checkout>/watchtower.config.json`, else none (defaults and environment only).
 *
 * Config errors are LOUD (they throw) — unlike the capture scripts, which must
 * fail silently so they never break Claude Code.
 */
export function loadConfig(
  opts: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    /** Where to look first for the config file. Defaults to `process.cwd()`. */
    cwd?: string;
    /** The checkout whose config file is the fallback. Defaults to this one. */
    checkoutDir?: string;
  } = {}
): WatchtowerConfig {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath
    ?? configFileFor(opts.cwd ?? process.cwd(), opts.checkoutDir ?? CHECKOUT_DIR);
  const cfg = defaults();

  if (configPath !== null && existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`Invalid JSON in ${path.basename(configPath)} at ${configPath}: ${String(e)}`);
    }
    const f = parsed as Partial<WatchtowerConfig>;
    if (typeof f.schemaVersion === "number") cfg.schemaVersion = f.schemaVersion;
    if (f.database?.path) cfg.database.path = expandHome(f.database.path);
    if (f.capture?.installDir) cfg.capture.installDir = expandHome(f.capture.installDir);
    if (f.coach?.mode) {
      if (f.coach.mode !== "cli" && f.coach.mode !== "api") {
        throw new Error(
          `Invalid coach.mode in ${path.basename(configPath)} at ${configPath}: ` +
            `expected "cli" or "api", got ${JSON.stringify(f.coach.mode)}`,
        );
      }
      cfg.coach.mode = f.coach.mode;
    }
    if (f.coach?.apiKey !== undefined) cfg.coach.apiKey = f.coach.apiKey;
    if (f.excludePaths !== undefined) {
      if (!Array.isArray(f.excludePaths) || f.excludePaths.some((p) => typeof p !== "string")) {
        throw new Error(
          `Invalid excludePaths in ${path.basename(configPath)} at ${configPath}: ` +
            `expected an array of strings`,
        );
      }
      // Replaces rather than merges: a shipped default must be removable.
      cfg.excludePaths = f.excludePaths.map(expandHome);
    }
    if (f.projectGroups !== undefined) {
      const g = f.projectGroups as Record<string, unknown>;
      if (typeof g !== "object" || g === null || Array.isArray(g)) {
        throw new Error(
          `Invalid projectGroups in ${path.basename(configPath)} at ${configPath}: ` +
            `expected an object of label -> string[]`,
        );
      }
      for (const [label, members] of Object.entries(g)) {
        if (!Array.isArray(members) || members.some((m) => typeof m !== "string")) {
          throw new Error(
            `Invalid projectGroups.${label} in ${path.basename(configPath)} at ` +
              `${configPath}: expected an array of strings`,
          );
        }
      }
      cfg.projectGroups = g as Record<string, string[]>;
    }

    if (f.sources !== undefined) {
      const raw = f.sources as Record<string, unknown>;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(
          `Invalid sources in ${path.basename(configPath)} at ${configPath}: ` +
            `expected an object of id -> source config`,
        );
      }
      const out: Record<string, SourceConfig> = {};
      for (const [id, v] of Object.entries(raw)) {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new Error(
            `Invalid sources.${id} in ${path.basename(configPath)} at ${configPath}: ` +
              `expected an object`,
          );
        }
        const sc = v as Record<string, unknown>;
        if (sc.enabled !== undefined && typeof sc.enabled !== "boolean") {
          throw new Error(
            `Invalid sources.${id}.enabled in ${path.basename(configPath)} at ` +
              `${configPath}: expected a boolean`,
          );
        }
        if (sc.projectRoots !== undefined &&
            (!Array.isArray(sc.projectRoots) ||
             sc.projectRoots.some((r) => typeof r !== "string"))) {
          throw new Error(
            `Invalid sources.${id}.projectRoots in ${path.basename(configPath)} at ` +
              `${configPath}: expected an array of strings`,
          );
        }
        for (const key of ["driven", "automated"] as const) {
          const list = sc[key];
          if (list !== undefined && (!Array.isArray(list) || list.some((r) => typeof r !== "string"))) {
            throw new Error(
              `Invalid sources.${id}.${key} in ${path.basename(configPath)} at ` +
                `${configPath}: expected an array of strings`,
            );
          }
        }
        out[id] = {
          enabled: sc.enabled === undefined ? true : (sc.enabled as boolean),
          type: typeof sc.type === "string" ? sc.type : id,
          projectRoots: (sc.projectRoots as string[] | undefined)?.map(expandHome),
          autoDiscover: sc.autoDiscover as boolean | undefined,
          baseUrl: sc.baseUrl as string | undefined,
          apiKeyEnv: sc.apiKeyEnv as string | undefined,
          driven: sc.driven as string[] | undefined,
          automated: sc.automated as string[] | undefined,
        };
      }
      // Replaces rather than merges, so a shipped default can be removed.
      cfg.sources = out;
      // Claude is the source Watchtower exists for: a file that lists only other
      // sources still gets it. Disabling it takes naming it with enabled:false.
      if (!("claude" in out)) out.claude = { enabled: true, type: "claude" };
    }

    if (f.dashboard !== undefined) {
      const d = f.dashboard as unknown as Record<string, unknown>;
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        throw new Error(
          `Invalid dashboard in ${path.basename(configPath)} at ${configPath}: ` +
            `expected an object`,
        );
      }
      if (d.port !== undefined) {
        if (typeof d.port !== "number" || !Number.isInteger(d.port) ||
            d.port < 0 || d.port > 65535) {
          throw new Error(
            `Invalid dashboard.port in ${path.basename(configPath)} at ${configPath}: ` +
              `expected an integer 0-65535`,
          );
        }
        cfg.dashboard.port = d.port;
      }
      if (d.host !== undefined) {
        // Watchtower reads a database of what you typed into every repo you own.
        // Binding it to a LAN interface is not a knob worth shipping.
        if (typeof d.host !== "string" || !LOOPBACK.has(d.host)) {
          throw new Error(
            `Invalid dashboard.host in ${path.basename(configPath)} at ${configPath}: ` +
              `expected a loopback address (127.0.0.1, localhost or ::1), got ` +
              `${JSON.stringify(d.host)}`,
          );
        }
        cfg.dashboard.host = d.host;
      }
      if (d.pollSeconds !== undefined) {
        // Each poll spawns sqlite3 several times; a sub-second interval turns
        // an open tab into a process storm against the live database.
        if (typeof d.pollSeconds !== "number" || !Number.isFinite(d.pollSeconds) || d.pollSeconds < MIN_POLL_SECONDS) {
          throw new Error(
            `Invalid dashboard.pollSeconds in ${path.basename(configPath)} at ` +
              `${configPath}: expected a number of seconds >= ${MIN_POLL_SECONDS}, got ${JSON.stringify(d.pollSeconds)}`,
          );
        }
        cfg.dashboard.pollSeconds = d.pollSeconds;
      }
      if (d.syncSeconds !== undefined) {
        cfg.dashboard.syncSeconds = syncSecondsOf(
          d.syncSeconds, d.syncSeconds, `dashboard.syncSeconds in ${path.basename(configPath)} at ${configPath}`);
      }
    }
  }

  if (env.WATCHTOWER_DB_PATH) cfg.database.path = expandHome(env.WATCHTOWER_DB_PATH);
  if (typeof env.WATCHTOWER_SYNC_SECONDS === "string" && env.WATCHTOWER_SYNC_SECONDS !== "") {
    cfg.dashboard.syncSeconds = syncSecondsOf(
      Number(env.WATCHTOWER_SYNC_SECONDS), env.WATCHTOWER_SYNC_SECONDS, "WATCHTOWER_SYNC_SECONDS");
  }
  if (env.WATCHTOWER_DASHBOARD_PORT) {
    const n = Number(env.WATCHTOWER_DASHBOARD_PORT);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(
        `Invalid WATCHTOWER_DASHBOARD_PORT: expected an integer 0-65535, got ` +
          `${JSON.stringify(env.WATCHTOWER_DASHBOARD_PORT)}`,
      );
    }
    cfg.dashboard.port = n;
  }

  return cfg;
}
