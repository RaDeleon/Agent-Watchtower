import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { entryLists, loadConfig } from "@/lib/config";
import type { SetupFacts } from "@/lib/setup/facts";
import { choose, parseFlags, questionsFor, sourcesConfig, stepsFor, type Flags } from "@/lib/setup/plan";

// `lib/setup/plan.ts` is pure: facts and answers in, choices and ordered steps
// out. Every default of `watchtower setup` lives there. This file holds them as
// identities; the fresh-install defaults appear as literals in exactly one test
// (R21), "a fresh install defaults to the recommended steps".

const IDS = ["codex", "hermes", "openviking", "atlas"];
const LABELS: Record<string, string> = { codex: "Codex", hermes: "Hermes", openviking: "OpenViking", atlas: "Atlas" };

/** The sources as facts lists them, with `ids` detected. */
const detected = (...ids: string[]): SetupFacts["sources"] =>
  IDS.map((id) => ({ id, label: LABELS[id], detected: ids.includes(id) }));

/** Facts for a fresh machine where every question applies; override what a test varies. */
function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    fresh: true,
    claudeDir: "/Users/you/.claude",
    checkout: "/Users/you/Agent-Watchtower",
    db: { path: "/Users/you/.watchtower/watchtower.sqlite", exists: false },
    configFile: null,
    sources: detected(...IDS),
    statusLineOffered: true,
    settingsPath: "/Users/you/.claude/settings.json",
    settingsNow: null,
    preview: { plain: "{}\n", withStatusLine: "{\"statusLine\":{}}\n" },
    scripts: [],
    link: { path: "/Users/you/.local/bin/watchtower", state: "absent", onPath: true },
    ...over,
  };
}

const noFlags: Flags = { yes: false };

function flags(argv: string[]): Flags {
  const f = parseFlags(argv);
  if ("error" in f) throw new Error(f.error);
  return f;
}

const keys = (f: SetupFacts, fl: Flags = noFlags): string[] => questionsFor(f, fl).map((q) => q.key);

describe("setup plan", () => {
  it("every default on an existing install is today's behaviour", () => {
    const existing = facts({ fresh: false });
    const qs = questionsFor(existing, noFlags);
    // Every question a fresh install asks is asked here too, so none escapes the identity.
    expect(qs.map((q) => q.key)).toEqual(keys(facts()));
    expect(qs.length).toBeGreaterThanOrEqual(5);
    for (const q of qs) expect(q.def, q.key).toBe(q.today);

    const none = choose(existing, { yes: false }, "none", new Map());
    expect(choose(existing, { yes: true }, "yes", new Map())).toEqual(none);
    // Enter through every question takes each one's def.
    const enter = new Map(qs.map((q) => [q.key, q.def] as const));
    expect(choose(existing, noFlags, "interactive", enter)).toEqual(none);
  });

  it("a fresh install defaults to the recommended steps", () => {
    const fresh = facts({ sources: detected("codex") });
    expect(questionsFor(fresh, noFlags).map((q) => [q.key, q.def])).toEqual([
      ["statusLine", true], ["source:codex", true], ["backfill", true], ["link", true], ["open", true],
    ]);
    expect(stepsFor(choose(fresh, { yes: true }, "yes", new Map()))).toEqual([
      { kind: "install", statusLine: true }, { kind: "backfill" }, { kind: "link" }, { kind: "open" },
    ]);
  });

  it("non-interactive without --yes runs the install only", () => {
    for (const f of [facts(), facts({ fresh: false })]) {
      expect(stepsFor(choose(f, { yes: false }, "none", new Map()))).toEqual([{ kind: "install", statusLine: false }]);
    }
  });

  it("a flag answers its question", () => {
    const f = facts();
    const switches = [["status-line", "statusLine"], ["backfill", "backfill"], ["link", "link"], ["open", "open"]] as const;
    for (const [flag, key] of switches) {
      expect(keys(f), key).toContain(key);
      const off = flags([`--no-${flag}`]);
      expect(keys(f, off), key).not.toContain(key);
      expect(choose(f, { ...off, yes: true }, "yes", new Map())[key], key).toBe(false);
      // The positive form answers yes even where the default is no.
      const on = flags([`--${flag}`]);
      expect(keys(f, on), key).not.toContain(key);
      expect(choose(facts({ fresh: false }), on, "none", new Map())[key], key).toBe(true);
    }

    expect(flags(["--yes"]).yes).toBe(true);
    const disable = flags(["--disable", "codex,atlas"]);
    expect(keys(f, disable).filter((k) => k.startsWith("source:"))).toEqual([]);
    expect(choose(f, { ...disable, yes: true }, "yes", new Map()).disable).toEqual(["codex", "atlas"]);
    expect(stepsFor(choose(f, disable, "none", new Map()))).toContainEqual({ kind: "config", disable: ["codex", "atlas"] });
    expect(flags(["--disable=hermes"]).disable).toEqual(["hermes"]);
  });

  it("an answer of no declines a source and its step", () => {
    const f = facts();
    const answers = new Map(questionsFor(f, noFlags).map((q) => [q.key, q.def] as const));
    answers.set("source:hermes", false);
    answers.set("backfill", false);
    const c = choose(f, noFlags, "interactive", answers);
    expect(c.disable).toEqual(["hermes"]);
    expect(c.backfill).toBe(false);
    expect(stepsFor(c).map((s) => s.kind)).toEqual(["install", "config", "link", "open"]);
  });

  it("questions apply only when they can", () => {
    expect(keys(facts())).toContain("statusLine");
    expect(keys(facts({ statusLineOffered: false }))).not.toContain("statusLine");

    expect(keys(facts())).toContain("link");
    for (const state of ["ours", "other"] as const) {
      expect(keys(facts({ link: { path: "/Users/you/.local/bin/watchtower", state, onPath: true } })), state).not.toContain("link");
    }

    const sourceKeys = (f: SetupFacts) => keys(f).filter((k) => k.startsWith("source:"));
    expect(sourceKeys(facts())).toEqual(IDS.map((id) => `source:${id}`));
    expect(sourceKeys(facts({ configFile: "/Users/you/Agent-Watchtower/watchtower.config.json" }))).toEqual([]);
    expect(sourceKeys(facts({ sources: detected() }))).toEqual([]);
  });

  it("usage errors", () => {
    for (const argv of [["--frobnicate"], ["--disable", "nope"], ["--disable"], ["--disable", "claude"], ["now"]]) {
      expect(parseFlags(argv), argv.join(" ")).toHaveProperty("error");
    }
  });

  // Guard 9. A source map in a config file REPLACES the defaults, so a written
  // file that dropped a default (Atlas's projectRoots) would silently change a
  // source the user said yes to.
  it("a declined source keeps every other default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-setup-cfg-"));
    const configPath = path.join(dir, "watchtower.config.json");
    writeFileSync(configPath, sourcesConfig(["codex"]));
    const got = loadConfig({ configPath, env: {} });
    const want = loadConfig({ configPath: "/nonexistent", env: {} });

    expect(Object.keys(got.sources).sort()).toEqual(Object.keys(want.sources).sort());
    for (const id of Object.keys(want.sources)) {
      const g = got.sources[id];
      const w = want.sources[id];
      expect(g.enabled, id).toBe(id === "codex" ? false : w.enabled);
      expect(g.type, id).toBe(w.type);
      expect(g.baseUrl, id).toEqual(w.baseUrl);
      expect(g.projectRoots, id).toEqual(w.projectRoots);
      if (id === "codex" || id === "hermes") expect(entryLists(id, g), id).toEqual(entryLists(id, w));
    }

    // Two-space JSON and a newline, with no driven/automated lists, so later
    // updates to the shipped lists still reach this user.
    const text = readFileSync(configPath, "utf8");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(text).not.toMatch(/driven|automated/);
  });
});
