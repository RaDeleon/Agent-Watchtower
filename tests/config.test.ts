import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CODEX_DRIVEN, CODEX_AUTOMATED, HERMES_DRIVEN, HERMES_AUTOMATED,
  configFileFor, entryLists, expandHome, defaultDbPath, loadConfig,
} from "@/lib/config";
import { adaptersFor } from "@/lib/adapters";

describe("expandHome", () => {
  it("expands a leading ~ to the home directory", () => {
    const out = expandHome("~/.watchtower/db.sqlite");
    expect(out.startsWith("~")).toBe(false);
    expect(out.endsWith("/.watchtower/db.sqlite")).toBe(true);
  });

  it("leaves absolute paths untouched", () => {
    expect(expandHome("/tmp/x.sqlite")).toBe("/tmp/x.sqlite");
  });
});

describe("loadConfig", () => {
  it("returns documented defaults when no config file exists", () => {
    const c = loadConfig({
      configPath: "/nonexistent/watchtower.config.json",
      env: {},
    });
    expect(c.schemaVersion).toBe(11);
    expect(c.database.path).toBe(defaultDbPath());
    expect(c.database.path.endsWith("/.watchtower/watchtower.sqlite")).toBe(true);
    expect(c.capture.installDir.endsWith("/.claude")).toBe(true);
    expect(c.coach.mode).toBe("cli");
    expect(c.coach.apiKey).toBeNull();
  });

  it("merges a partial config file over the defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ capture: { installDir: "/opt/claude" } }));
    const c = loadConfig({ configPath: p, env: {} });
    expect(c.capture.installDir).toBe("/opt/claude");
    // untouched keys keep their defaults
    expect(c.coach.mode).toBe("cli");
    expect(c.database.path.endsWith("/.watchtower/watchtower.sqlite")).toBe(true);
  });

  it("lets WATCHTOWER_DB_PATH override the config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ database: { path: "/from/file.sqlite" } }));
    const c = loadConfig({ configPath: p, env: { WATCHTOWER_DB_PATH: "/from/env.sqlite" } });
    expect(c.database.path).toBe("/from/env.sqlite");
  });

  it("throws a clear error on malformed JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, "{ not json");
    expect(() => loadConfig({ configPath: p, env: {} })).toThrow(/watchtower\.config\.json/);
  });

  // The message hardcoded "watchtower.config.json" while the path it printed
  // could be any file (loadConfig takes configPath). A user pointed at
  // ./config/dev.json was told to go fix a file that does not exist.
  it("names the actual config file in the JSON error, not a hardcoded default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "dev.json");
    writeFileSync(p, "{ not json");
    expect(() => loadConfig({ configPath: p, env: {} })).toThrow(/dev\.json/);
    expect(() => loadConfig({ configPath: p, env: {} })).not.toThrow(/watchtower\.config\.json/);
  });

  // coach.mode is typed "cli" | "api" but arrives as untyped JSON, so the cast
  // let any string through to whatever reads it later. Config errors are LOUD.
  it("rejects a coach.mode outside cli|api", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ coach: { mode: "gpt" } }));
    expect(() => loadConfig({ configPath: p, env: {} })).toThrow(/coach\.mode/);
  });

  it("accepts the two documented coach modes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    for (const mode of ["cli", "api"] as const) {
      const p = path.join(dir, `${mode}.json`);
      writeFileSync(p, JSON.stringify({ coach: { mode } }));
      expect(loadConfig({ configPath: p, env: {} }).coach.mode).toBe(mode);
    }
  });

  it("defaults excludePaths to the five measured entries and projectGroups to empty", () => {
    const c = loadConfig({ configPath: "/nonexistent/watchtower.config.json", env: {} });
    expect(c.projectGroups).toEqual({});
    expect(c.excludePaths).toHaveLength(5);
    expect(c.excludePaths.some((p) => p.includes("CodexBar/ClaudeProbe"))).toBe(true);
    expect(c.excludePaths.every((p) => !p.startsWith("~"))).toBe(true);   // expanded
  });

  it("rejects an excludePaths that is not an array of strings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ excludePaths: "not-an-array" }));
    expect(() => loadConfig({ configPath: p, env: {} })).toThrow(/excludePaths/);
  });

  it("rejects a projectGroups whose value is not an array of strings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ projectGroups: { VPS: "a,b,c" } }));
    expect(() => loadConfig({ configPath: p, env: {} })).toThrow(/projectGroups/);
  });

  it("replaces excludePaths wholesale rather than merging with the defaults", () => {
    // Merging would make a shipped default impossible to remove.
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ excludePaths: ["/only/this"] }));
    expect(loadConfig({ configPath: p, env: {} }).excludePaths).toEqual(["/only/this"]);
  });
});

describe("sources", () => {
  const write = (o: unknown) => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), "wt-")), "watchtower.config.json");
    writeFileSync(p, JSON.stringify(o));
    return p;
  };

  // Backward compatibility is load-bearing: every config written before Stage 3
  // omits `sources` entirely and must keep working.
  it("defaults to all five sources, Claude enabled", () => {
    const c = loadConfig({ configPath: "/nonexistent/watchtower.config.json", env: {} });
    expect(Object.keys(c.sources)).toEqual(["claude", "codex", "hermes", "openviking", "atlas"]);
    expect(c.sources.claude.enabled).toBe(true);
    expect(c.sources.claude.type).toBe("claude");
    expect(c.sources.codex.driven).toEqual([...CODEX_DRIVEN]);
    expect(c.sources.codex.automated).toEqual([...CODEX_AUTOMATED]);
    expect(c.dashboard.syncSeconds).toBe(300);
  });

  it("adds claude back to a sources block that omits it", () => {
    const c = loadConfig({ configPath: write({ sources: { codex: { enabled: true } } }), env: {} });
    expect(Object.keys(c.sources).sort()).toEqual(["claude", "codex"]);
    expect(c.sources.claude.enabled).toBe(true);
    expect(c.sources.hermes).toBeUndefined();
  });

  it("rejects a non-array driven list", () => {
    expect(() => loadConfig({ configPath: write({ sources: { codex: { driven: "x" } } }), env: {} }))
      .toThrow(/Invalid sources\.codex\.driven/);
  });

  it("entryLists falls back to the shipped defaults", () => {
    expect(entryLists("hermes", undefined)).toEqual({ driven: [...HERMES_DRIVEN], automated: [...HERMES_AUTOMATED] });
    expect(entryLists("codex", { enabled: true, type: "codex", driven: ["a"] }))
      .toEqual({ driven: ["a"], automated: [...CODEX_AUTOMATED] });
  });

  it("adaptersFor lists every enabled adapter in order, and none when claude is off", () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-")), "x.sqlite");
    const c = loadConfig({ configPath: "/nonexistent/watchtower.config.json", env: { WATCHTOWER_DB_PATH: db } });
    expect(adaptersFor(c).map((a) => a.id)).toEqual(["claude", "codex", "hermes", "openviking", "atlas"]);
    const off = loadConfig({ configPath: write({ sources: { claude: { enabled: false } } }), env: {} });
    expect(adaptersFor(off).map((a) => a.id)).toEqual([]);
  });

  // The reframe requires that an AUTO-DISCOVERED source can be turned off.
  it("lets a discovered source be disabled explicitly", () => {
    const c = loadConfig({ configPath: write({
      sources: { claude: { enabled: true, type: "claude" },
                 atlas: { enabled: false, type: "atlas" } },
    }), env: {} });
    expect(c.sources.atlas.enabled).toBe(false);
  });

  it("defaults an omitted enabled to true and an omitted type to the id", () => {
    const c = loadConfig({ configPath: write({ sources: { codex: {} } }), env: {} });
    expect(c.sources.codex.enabled).toBe(true);
    expect(c.sources.codex.type).toBe("codex");
  });

  it("expands ~ in projectRoots", () => {
    const c = loadConfig({ configPath: write({
      sources: { atlas: { type: "atlas", projectRoots: ["~/code"] } },
    }), env: {} });
    expect(c.sources.atlas.projectRoots?.[0].startsWith("~")).toBe(false);
  });

  it("carries apiKeyEnv, which names the variable and never the key", () => {
    const c = loadConfig({ configPath: write({
      sources: { openviking: { type: "openviking", baseUrl: "http://localhost:1933",
                               apiKeyEnv: "OPENVIKING_API_KEY" } },
    }), env: {} });
    expect(c.sources.openviking.apiKeyEnv).toBe("OPENVIKING_API_KEY");
  });

  it.each([
    ["sources", { sources: [] }, /sources/],
    ["a source entry", { sources: { atlas: "yes" } }, /sources\.atlas/],
    ["enabled", { sources: { atlas: { enabled: "yes" } } }, /enabled/],
    ["projectRoots", { sources: { atlas: { projectRoots: "x" } } }, /projectRoots/],
  ])("rejects a malformed %s loudly", (_label, cfg, re) => {
    expect(() => loadConfig({ configPath: write(cfg), env: {} })).toThrow(re);
  });
});

describe("dashboard", () => {
  const write = (o: unknown) => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), "wt-")), "watchtower.config.json");
    writeFileSync(p, JSON.stringify(o));
    return p;
  };

  it("syncSeconds: 0 is off, below 60 is refused, and the env overrides", () => {
    expect(loadConfig({ configPath: write({ dashboard: { syncSeconds: 0 } }), env: {} }).dashboard.syncSeconds).toBe(0);
    expect(() => loadConfig({ configPath: write({ dashboard: { syncSeconds: 30 } }), env: {} }))
      .toThrow("expected 0 (off) or an integer number of seconds >= 60");
    expect(loadConfig({ configPath: "/nonexistent/x.json", env: { WATCHTOWER_SYNC_SECONDS: "0" } }).dashboard.syncSeconds).toBe(0);
    expect(() => loadConfig({ configPath: "/nonexistent/x.json", env: { WATCHTOWER_SYNC_SECONDS: "abc" } }))
      .toThrow("Invalid WATCHTOWER_SYNC_SECONDS");
  });

  it("has documented defaults", () => {
    const c = loadConfig({ configPath: "/nonexistent/watchtower.config.json", env: {} });
    expect(c.dashboard).toEqual({ port: 4317, host: "127.0.0.1", pollSeconds: 5, syncSeconds: 300 });
  });

  // Watchtower reads a database of what you typed into every repo you own.
  // Binding it to a LAN interface is not a knob worth shipping.
  it.each(["0.0.0.0", "192.168.1.10", "::"])("refuses the non-loopback host %s", (host) => {
    expect(() => loadConfig({ configPath: write({ dashboard: { host } }), env: {} }))
      .toThrow(/loopback/);
  });

  it.each(["127.0.0.1", "localhost", "::1"])("accepts the loopback host %s", (host) => {
    expect(loadConfig({ configPath: write({ dashboard: { host } }), env: {} }).dashboard.host)
      .toBe(host);
  });

  // Each poll spawns sqlite3 several times; 0.01 would be ~10 spawns per 10 ms.
  it.each([0, 0.01, 0.5, -1, "5", null])("rejects pollSeconds %s, below the 1s floor or not a number", (pollSeconds) => {
    expect(() => loadConfig({ configPath: write({ dashboard: { pollSeconds } }), env: {} }))
      .toThrow(/dashboard\.pollSeconds.*>= 1/);
  });

  it.each([1, 2.5, 30])("accepts pollSeconds %s", (pollSeconds) => {
    expect(loadConfig({ configPath: write({ dashboard: { pollSeconds } }), env: {} }).dashboard.pollSeconds)
      .toBe(pollSeconds);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ configPath: write({ dashboard: { port: 99999 } }), env: {} }))
      .toThrow(/dashboard\.port/);
  });

  it("lets WATCHTOWER_DASHBOARD_PORT override the file", () => {
    const p = write({ dashboard: { port: 4317 } });
    expect(loadConfig({ configPath: p, env: { WATCHTOWER_DASHBOARD_PORT: "5000" } })
      .dashboard.port).toBe(5000);
  });

  it("rejects a non-numeric WATCHTOWER_DASHBOARD_PORT rather than silently ignoring it", () => {
    expect(() => loadConfig({ configPath: write({}), env: { WATCHTOWER_DASHBOARD_PORT: "abc" } }))
      .toThrow(/WATCHTOWER_DASHBOARD_PORT/);
  });
});

describe("config file location", () => {
  // Guard 13. `watchtower setup` writes its config into the checkout, and the
  // linked CLI normally runs from somewhere else. The current directory's file
  // still wins; the checkout's is read only when the current directory has none.
  it("reads the current directory's config, else the checkout's", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-cwd-"));
    const checkoutDir = mkdtempSync(path.join(tmpdir(), "wt-checkout-"));
    const inCwd = path.join(cwd, "watchtower.config.json");
    const inCheckout = path.join(checkoutDir, "watchtower.config.json");

    expect(configFileFor(cwd, checkoutDir)).toBeNull();
    expect(loadConfig({ cwd, checkoutDir, env: {} }))
      .toEqual(loadConfig({ configPath: "/nonexistent", env: {} }));

    writeFileSync(inCheckout, JSON.stringify({ dashboard: { port: 4400 } }));
    expect(configFileFor(cwd, checkoutDir)).toBe(inCheckout);
    expect(loadConfig({ cwd, checkoutDir, env: {} }).dashboard.port).toBe(4400);

    writeFileSync(inCwd, JSON.stringify({ dashboard: { port: 4500 } }));
    expect(configFileFor(cwd, checkoutDir)).toBe(inCwd);
    expect(loadConfig({ cwd, checkoutDir, env: {} }).dashboard.port).toBe(4500);
  });
});
