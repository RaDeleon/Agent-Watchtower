import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync, chmodSync,
  lstatSync, statSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { slow } from "./helpers/timeout";

const CAPTURE = path.resolve(__dirname, "..", "capture");
const INSTALL = path.join(CAPTURE, "install.sh");

function run(claudeDir: string): string {
  return execFileSync("bash", [INSTALL], {
    env: { ...process.env, CLAUDE_DIR: claudeDir },
    encoding: "utf8",
  });
}
const settings = (d: string) => JSON.parse(readFileSync(path.join(d, "settings.json"), "utf8"));
const commands = (d: string, event: string): string[] =>
  (settings(d).hooks[event] ?? []).flatMap((e: { hooks?: { command: string }[] }) =>
    (e.hooks ?? []).map((h) => h.command)
  );

/** Fresh CLAUDE_DIR with a pre-seeded settings.json, then install into it. */
function runSeeded(seed: unknown): string {
  const d = mkdtempSync(path.join(tmpdir(), "wt-install-seed-"));
  writeFileSync(path.join(d, "settings.json"), JSON.stringify(seed, null, 2));
  run(d);
  return d;
}

describe("install.sh", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wt-install-"));
    run(dir);
  });

  it("installs the scripts to the existing tracker paths", () => {
    expect(existsSync(path.join(dir, "cc-track-lib.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "hooks", "cc-track-hook.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "claude-usage-rollup.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "watchtower-snapshot.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "watchtower-ingest.sh"))).toBe(true);
  });

  it("registers the hook on all eight events", () => {
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SubagentStart",
                      "SubagentStop", "PreCompact", "PostCompact", "SessionEnd"]) {
      expect(commands(dir, ev).length).toBeGreaterThan(0);
    }
  });

  it("chains the rollup after the hook on SessionEnd", () => {
    const cmd = commands(dir, "SessionEnd")[0];
    expect(cmd).toContain("cc-track-hook.sh");
    expect(cmd).toContain("claude-usage-rollup.sh --quiet");
    expect(cmd.indexOf("cc-track-hook.sh")).toBeLessThan(cmd.indexOf("claude-usage-rollup.sh"));
    // The suffix is load-bearing, not decoration. The redirects keep
    // rollup.sh's `exit 1` and its stderr away from Claude Code, and they
    // release the hook's pipes so Claude Code is not left waiting on them. The
    // `&` keeps the command inside Claude Code's 1.5s SessionEnd timeout.
    expect(cmd.endsWith("</dev/null >/dev/null 2>&1 &")).toBe(true);
  });

  it("is idempotent — a second run adds no duplicate hooks", () => {
    const before = commands(dir, "SessionStart").length;
    run(dir);
    expect(commands(dir, "SessionStart").length).toBe(before);
    expect(commands(dir, "SessionEnd").length).toBe(1);
  });

  it("preserves unrelated settings and existing hooks", () => {
    const d2 = mkdtempSync(path.join(tmpdir(), "wt-install2-"));
    writeFileSync(path.join(d2, "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    }));
    run(d2);
    expect(settings(d2).model).toBe("opus");
    expect(commands(d2, "Stop")).toContain("echo mine");
    expect(commands(d2, "Stop").some((c) => c.includes("cc-track-hook.sh"))).toBe(true);
  });

  it("backs up a settings.json it modifies", () => {
    const d3 = mkdtempSync(path.join(tmpdir(), "wt-install3-"));
    writeFileSync(path.join(d3, "settings.json"), JSON.stringify({ model: "sonnet" }));
    run(d3);
    const backups = readdirSync(path.join(d3, "backups"));
    expect(backups.some((f) => f.startsWith("settings.json."))).toBe(true);
  });

  it("does not add a second snapshot writer when one already exists", () => {
    const d4 = mkdtempSync(path.join(tmpdir(), "wt-install4-"));
    writeFileSync(path.join(d4, "statusline.sh"), "# INSERT INTO claude_status_snapshots ...");
    const out = run(d4);
    expect(out).toContain("leaving it alone");
  });

  // Regression: the check greps statusline.sh for a marker of an existing
  // snapshot writer, but "claude_status_snapshots" only appears in snapshot.sh —
  // never in the one-line call this installer tells the user to add. A user who
  // followed the instruction was told "no snapshot capture found" on every run.
  it("detects the watchtower-snapshot.sh call it told the user to add", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-sl-"));
    writeFileSync(
      path.join(d, "statusline.sh"),
      `#!/usr/bin/env bash\ntee >(${path.join(d, "watchtower-snapshot.sh")} &) | jq -r .x\n`,
    );
    expect(run(d)).toContain("leaving it alone");
  });

  it("still reports no capture when statusline.sh has neither writer", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-sl2-"));
    writeFileSync(path.join(d, "statusline.sh"), "#!/usr/bin/env bash\nprintf 'just a prompt'\n");
    expect(run(d)).toContain("no snapshot capture found");
  });

  // D2: the TMPDIR-based test that would seem obvious here does NOT
  // discriminate — BSD mktemp silently falls back to the per-user
  // /var/folders/.../T, so a bare `mktemp` succeeds just as a
  // "$CLAUDE_DIR/..." one does and the assertion proves nothing. Pin the
  // location at source instead, in the style of the constants test: reverting
  // to bare `mktemp` would reintroduce the cross-filesystem `mv` that can
  // degrade from an atomic rename into copy-then-unlink.
  it("creates the settings.json temp file inside CLAUDE_DIR, not $TMPDIR", () => {
    const src = readFileSync(INSTALL, "utf8");
    expect(src).toMatch(/mktemp "\$CLAUDE_DIR\//);
  });

  // Regression: a real settings.json can have our command sharing a hook GROUP
  // with an unrelated command (e.g. PostCompact holding both an obsidian hook
  // and cc-track-hook.sh in one entry). The `ensure` filter must dedupe at the
  // individual command level, not drop the whole group — otherwise re-running
  // the installer silently deletes the sibling hook. The fixture must use the
  // exact path the installer will write for THIS temp dir (<d>/hooks/cc-track-hook.sh),
  // not a literal, or the filter never matches anything and the test proves nothing.
  it("keeps a sibling command that shares a hook group with the tracker command", () => {
    const d5 = mkdtempSync(path.join(tmpdir(), "wt-install5-"));
    const trackerPath = path.join(d5, "hooks", "cc-track-hook.sh");
    writeFileSync(path.join(d5, "settings.json"), JSON.stringify({
      hooks: {
        PostCompact: [{
          hooks: [
            { type: "command", command: "/some/obsidian-bg-agent.sh", timeout: 10, async: true },
            { type: "command", command: trackerPath },
          ],
        }],
      },
    }));

    run(d5);

    const postCompact = settings(d5).hooks.PostCompact as { hooks: { command: string; timeout?: number; async?: boolean }[] }[];
    const all = postCompact.flatMap((e) => e.hooks);
    const sibling = all.find((h) => h.command === "/some/obsidian-bg-agent.sh");
    const tracker = all.filter((h) => h.command === trackerPath);

    expect(sibling).toBeDefined();
    expect(sibling?.timeout).toBe(10);
    expect(sibling?.async).toBe(true);
    expect(tracker).toHaveLength(1);
  });

  it("stays idempotent for the shared-group shape across three runs", () => {
    const d6 = mkdtempSync(path.join(tmpdir(), "wt-install6-"));
    const trackerPath = path.join(d6, "hooks", "cc-track-hook.sh");
    writeFileSync(path.join(d6, "settings.json"), JSON.stringify({
      hooks: {
        PostCompact: [{
          hooks: [
            { type: "command", command: "/some/obsidian-bg-agent.sh", timeout: 10, async: true },
            { type: "command", command: trackerPath },
          ],
        }],
      },
    }));

    run(d6);
    run(d6);
    run(d6);

    const all = (settings(d6).hooks.PostCompact as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks);
    expect(all.filter((h) => h.command === "/some/obsidian-bg-agent.sh")).toHaveLength(1);
    expect(all.filter((h) => h.command === trackerPath)).toHaveLength(1);
  });

  // Regression: install.sh derives SRC from its own location (dirname "$0"), so
  // exercising a missing-source-script refusal means copying install.sh into a
  // temp dir alongside a deliberately incomplete set of siblings (omitting
  // hook.sh here) — not pointing an env var at anything.
  it("refuses a partial install when a source script is missing, before writing anything", () => {
    const srcDir = mkdtempSync(path.join(tmpdir(), "wt-install-src-"));
    for (const name of ["install.sh", "lib.sh", "rollup.sh", "snapshot.sh", "ingest.sh"]) {
      copyFileSync(path.join(CAPTURE, name), path.join(srcDir, name));
    }
    chmodSync(path.join(srcDir, "install.sh"), 0o755);
    // hook.sh deliberately not copied.

    const claudeDir = mkdtempSync(path.join(tmpdir(), "wt-install7-"));
    let error: (Error & { status?: number | null; stderr?: string }) | undefined;
    try {
      execFileSync("bash", [path.join(srcDir, "install.sh")], {
        env: { ...process.env, CLAUDE_DIR: claudeDir },
        encoding: "utf8",
        // Capture stderr instead of letting it inherit to the test runner's own
        // stderr (execFileSync's default) — this deliberately-failing install
        // otherwise prints "install: missing source script(s): hook.sh" straight
        // into the vitest output.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      error = e as Error & { status?: number | null; stderr?: string };
    }

    expect(error).toBeDefined();
    expect(error?.status).not.toBe(0);
    expect(error?.stderr).toContain("hook.sh");
    expect(existsSync(path.join(claudeDir, "settings.json"))).toBe(false);
    expect(existsSync(path.join(claudeDir, "cc-track-lib.sh"))).toBe(false);
    expect(existsSync(path.join(claudeDir, "hooks", "cc-track-hook.sh"))).toBe(false);
    expect(existsSync(path.join(claudeDir, "claude-usage-rollup.sh"))).toBe(false);
    expect(existsSync(path.join(claudeDir, "watchtower-snapshot.sh"))).toBe(false);
    expect(existsSync(path.join(claudeDir, "watchtower-ingest.sh"))).toBe(false);
  });

  // Cheap coverage for the atomic-rename fix: the settings.json temp file now
  // lives inside CLAUDE_DIR (so the final mv can't cross a filesystem boundary)
  // instead of $TMPDIR, which means an abort has somewhere to litter if the
  // cleanup trap doesn't fire. Can't exercise the cross-filesystem case itself
  // (needs a second filesystem) — just that no stray temp file survives either
  // a normal run or a forced failure.
  it("leaves no stray settings.json temp file behind, on success or on a forced failure", () => {
    const strays = (d: string) => readdirSync(d).filter((f) => f.startsWith(".settings.json.tmp."));

    const ok = mkdtempSync(path.join(tmpdir(), "wt-install8-"));
    run(ok);
    expect(strays(ok)).toHaveLength(0);

    const bad = mkdtempSync(path.join(tmpdir(), "wt-install9-"));
    writeFileSync(path.join(bad, "settings.json"), "{ not valid json");
    expect(() =>
      execFileSync("bash", [INSTALL], {
        env: { ...process.env, CLAUDE_DIR: bad },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"], // suppress jq's parse-error noise from leaking to the test runner
      })
    ).toThrow();
    expect(strays(bad)).toHaveLength(0);
  });

  // Regression: the sibling-preserving filter strips our command out of each
  // group, drops any group left empty, then appends a fresh bare group. For a
  // group holding ONLY our command that round-trip silently discarded the
  // group's own fields — including a `matcher` the user had set to scope the
  // hook. Re-running the installer must never widen a deliberately-scoped hook.
  it("preserves a matcher on a group that holds only the tracker command", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-matcher-"));
    const trackerPath = path.join(d, "hooks", "cc-track-hook.sh");
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "manual", hooks: [{ type: "command", command: trackerPath }] }],
      },
    }));

    run(d);

    type Group = { matcher?: string; hooks: { command: string }[] };
    const groups = settings(d).hooks.PreCompact as Group[];
    const carrying = groups.filter((g) => g.hooks.some((h) => h.command === trackerPath));
    expect(carrying).toHaveLength(1);
    expect(carrying[0].matcher).toBe("manual");
  });

  it("keeps that scoped group stable across repeated runs", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-matcher2-"));
    const trackerPath = path.join(d, "hooks", "cc-track-hook.sh");
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "manual", hooks: [{ type: "command", command: trackerPath }] }],
      },
    }));

    run(d);
    run(d);
    run(d);

    type Group = { matcher?: string; hooks: { command: string }[] };
    const groups = settings(d).hooks.PreCompact as Group[];
    const all = groups.flatMap((g) => g.hooks);
    expect(all.filter((h) => h.command === trackerPath)).toHaveLength(1);
    expect(groups.find((g) => g.hooks.some((h) => h.command === trackerPath))?.matcher).toBe("manual");
  });
});

describe("SessionEnd chain migration", () => {
  /** The exact two-step chain install.sh wrote before Stage 2. */
  const oldChain = (d: string) =>
    `${d}/hooks/cc-track-hook.sh; ${d}/claude-usage-rollup.sh --quiet >/dev/null 2>&1 || true`;

  /** The exact three-step foreground chain install.sh wrote in Stage 2. Claude
   *  Code cancels SessionEnd hooks after 1.5s, which killed ingest every time. */
  const stage2Chain = (d: string) =>
    `${d}/hooks/cc-track-hook.sh; ${d}/watchtower-ingest.sh --quiet >/dev/null 2>&1 || true; ` +
    `${d}/claude-usage-rollup.sh --quiet >/dev/null 2>&1 || true`;

  /** The exact chain install.sh should now write: the logger inline, ingest
   *  then rollup in the background. */
  const newChain = (d: string) =>
    `${d}/hooks/cc-track-hook.sh; nohup sh -c '${d}/watchtower-ingest.sh --quiet; ` +
    `${d}/claude-usage-rollup.sh --quiet' </dev/null >/dev/null 2>&1 &`;

  // watchtower-ingest.sh's own installed-file coverage lives with the other
  // four scripts in "installs the scripts to the existing tracker paths"
  // above -- one place to remember on the next addition, not two.

  it("runs ingest before the rollup on SessionEnd, joined with `;`, not `&&`", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-order-"));
    run(d);
    const cmds = commands(d, "SessionEnd");
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0];
    expect(cmd.indexOf("cc-track-hook.sh"))
      .toBeLessThan(cmd.indexOf("watchtower-ingest.sh"));
    expect(cmd.indexOf("watchtower-ingest.sh"))
      .toBeLessThan(cmd.indexOf("claude-usage-rollup.sh"));
    // Full-string equality, not just substring/order checks: this is what
    // pins the separator as `;` (so a failing ingest can never suppress the
    // rollup via `&&`) and the background redirects. Swapping `;` for `&&`,
    // or dropping a redirect or the `&`, turns this red.
    expect(cmd).toBe(newChain(d));
  });

  // The behaviour behind the string above. Claude Code cancels SessionEnd
  // hooks after 1.5s. The foreground chain took ~11s, so ingest and the rollup
  // were killed on every exit and the live data froze for four days. Stub
  // scripts stand in for the real ones: a slow ingest must not hold up the
  // hook, and the order hook -> ingest -> rollup must survive the backgrounding.
  // execFileSync waits for the child's stdout and stderr to close, so a
  // background job still holding either pipe fails the timing check too.
  it("returns before a slow ingest finishes, then runs ingest and rollup in order", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-bg-"));
    run(d);
    const log = path.join(d, "order.log");
    writeFileSync(path.join(d, "hooks", "cc-track-hook.sh"),
      `#!/usr/bin/env bash\ncat >/dev/null\necho hook >> '${log}'\n`);
    writeFileSync(path.join(d, "watchtower-ingest.sh"),
      `#!/usr/bin/env bash\nsleep 2\necho "ingest $*" >> '${log}'\n`);
    writeFileSync(path.join(d, "claude-usage-rollup.sh"),
      `#!/usr/bin/env bash\necho "rollup $*" >> '${log}'\n`);

    const start = Date.now();
    execFileSync("sh", ["-c", commands(d, "SessionEnd")[0]], {
      input: "{}", encoding: "utf8", env: { ...process.env, HOME: d },
    });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(readFileSync(log, "utf8")).toBe("hook\n");

    const deadline = Date.now() + 10_000;
    while (!readFileSync(log, "utf8").includes("rollup") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readFileSync(log, "utf8")).toBe("hook\ningest --quiet\nrollup --quiet\n");
  }, slow(15_000));

  // ensure() dedupes by EXACT string equality, so the pre-Stage-2 chain is no
  // longer recognised as ours. Without retire() it stays registered alongside
  // the new one and SessionEnd runs the hook and rollup twice.
  it("retires the exact previous chain rather than leaving it alongside", () => {
    // The seeded path must match what install.sh will compute, so seed with a
    // placeholder and rewrite it to the real dir after mkdtemp.
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-retire-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: oldChain(d) }] }] },
    }, null, 2));
    run(d);
    const cmds = commands(d, "SessionEnd");
    expect(cmds.some((c) => c === oldChain(d))).toBe(false);
    expect(cmds.filter((c) => c.includes("claude-usage-rollup.sh"))).toHaveLength(1);
  });

  // The live install carries the Stage 2 chain. Left in place, it would still
  // be cancelled at 1.5s, and a second ingest would start beside the new one.
  it("retires the exact Stage 2 foreground chain too", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-retire2-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: stage2Chain(d) }] }] },
    }, null, 2));
    run(d);
    expect(commands(d, "SessionEnd")).toEqual([newChain(d)]);
  });

  // The guard SESSION.md has demanded since Stage 1: a near-miss spelling is
  // the USER's hook, not ours, and deleting it is the bug that shipped once.
  it("does NOT delete a near-miss SessionEnd command it does not own", () => {
    const mine = "/opt/me/claude-usage-rollup.sh --quiet";
    const d = runSeeded({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: mine }] }] },
    });
    expect(commands(d, "SessionEnd")).toContain(mine);
  });

  // SESSION.md:501-503 names `contains("cc-track-hook.sh")` specifically as
  // the hazardous mutation `retire` must never regress to: `cc-track-hook.sh`
  // is the stable *prefix* shared by both the old and new chains, so it's the
  // substring a user's own wrapper around our hook is most likely to contain.
  // The near-miss case above only pins the rollup spelling; this pins the
  // hook spelling, which is the one the mutation actually targets.
  // Mutation-checked by hand: with `retire`'s `select(.command != $cmd)`
  // temporarily changed to a `contains("cc-track-hook.sh")`-based predicate,
  // this test goes RED (the wrapper is wrongly deleted); reverted, it is
  // GREEN again. See Fix round 1 in task-4-report.md for the transcript.
  it("does NOT delete a near-miss command that wraps our hook path as a substring", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-nearmiss-wrap-"));
    const wrapper = `logger start; ${d}/hooks/cc-track-hook.sh; logger end`;
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: wrapper }] }] },
    }, null, 2));
    run(d);
    expect(commands(d, "SessionEnd")).toContain(wrapper);
  });

  // Documented, deliberate behaviour -- see the comment at `retire`'s
  // definition in install.sh. Migrating off the old chain drops any
  // `matcher` that scoped the group holding it: `retire` empties the group,
  // its own cleanup drops empty groups (fields included), and `ensure` then
  // appends a fresh bare group. Preserving the matcher would mean threading
  // it from `retire` into `ensure` -- real complexity in the one function
  // that already shipped a deletion bug, for a case that doesn't occur in
  // the user's real settings. This pins it as intentional, not an accident.
  // Killing mutation: making `retire` copy the emptied group's `matcher`
  // onto the group `ensure` appends turns this red.
  it("drops a stale matcher when migrating off the old chain (documented, not a bug)", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-matcher-drop-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: { SessionEnd: [{ matcher: "clear", hooks: [{ type: "command", command: oldChain(d) }] }] },
    }, null, 2));
    run(d);
    const groups = settings(d).hooks.SessionEnd as { matcher?: string; hooks: { command: string }[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks.map((h) => h.command)).toContain(newChain(d));
    expect(groups[0].matcher).toBeUndefined();
  });

  // The real "shared group" hazard on the retire path: our OLD chain sharing
  // one SessionEnd group's `hooks` array with an unrelated user command.
  // `retire` must strip only its own command out of the group, not the whole
  // group (the exact bug class the comment at install.sh:106-109 names).
  // Killing mutation: reverting `retire` to drop the whole group whenever it
  // contains $cmd (instead of filtering per-command inside the group) turns
  // this red -- the sibling would be deleted along with the old chain.
  it("keeps a sibling command in the same SessionEnd group while the old chain is retired", () => {
    const sibling = "/opt/me/notify-done.sh";
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-retire-sibling-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: {
        SessionEnd: [{
          hooks: [
            { type: "command", command: sibling },
            { type: "command", command: oldChain(d) },
          ],
        }],
      },
    }, null, 2));
    run(d);
    const cmds = commands(d, "SessionEnd");
    expect(cmds).toContain(sibling);
    expect(cmds).toContain(newChain(d));
    expect(cmds).not.toContain(oldChain(d));
  });

  it("leaves a sibling hook in a different hook event untouched", () => {
    const sibling = "/opt/me/obsidian-bg-agent.sh";
    const d = runSeeded({
      hooks: { PostCompact: [{ hooks: [{ type: "command", command: sibling }] }] },
    });
    expect(commands(d, "PostCompact")).toContain(sibling);
  });

  it("is idempotent: a second run changes settings.json not at all", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-idem-"));
    run(d);
    const first = readFileSync(path.join(d, "settings.json"), "utf8");
    run(d);
    expect(readFileSync(path.join(d, "settings.json"), "utf8")).toBe(first);
  });

  // Guards against `RETIRED_SESSION_END` drifting to equal the CURRENT
  // `SESSION_END_CMD` (a "self-retire" bug). On a fresh dir, remove-then-
  // re-append converges to the same bare group either way, so plain
  // byte-identical idempotence can't see it (verified above and by hand).
  // Seeding a matcher-scoped group that ALREADY holds the correct new chain
  // makes it visible: if retire matched its own output, the group would be
  // emptied and rebuilt bare, losing the matcher, even though the command
  // was already exactly right.
  it("does not retire its own freshly-installed command (self-retire guard)", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-selfretire-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: { SessionEnd: [{ matcher: "clear", hooks: [{ type: "command", command: newChain(d) }] }] },
    }, null, 2));
    run(d);
    const groups = settings(d).hooks.SessionEnd as { matcher?: string; hooks: { command: string }[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe("clear");
    expect(groups[0].hooks.map((h) => h.command)).toEqual([newChain(d)]);
  });
});

describe("install.sh flags", () => {
  /** Run install.sh with arguments, stdio piped. Never throws. */
  function runArgs(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const r = spawnSync("bash", [INSTALL, ...args], {
      env: { ...process.env, CLAUDE_DIR: dir, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SubagentStart",
                  "SubagentStop", "PreCompact", "PostCompact", "SessionEnd"];
  const tracker = (d: string) => path.join(d, "hooks", "cc-track-hook.sh");
  /** The Stage 2 foreground chain, the SessionEnd command install.sh wrote last. */
  const previousChain = (d: string) =>
    `${d}/hooks/cc-track-hook.sh; ${d}/watchtower-ingest.sh --quiet >/dev/null 2>&1 || true; ` +
    `${d}/claude-usage-rollup.sh --quiet >/dev/null 2>&1 || true`;
  const OWN_STATUS_LINE = { type: "command", command: "/x/line.sh", padding: 2 };

  /** The settings.json shapes the merge has to survive, each built for its dir. */
  const SEEDS: Record<string, (d: string) => unknown> = {
    "empty": () => ({}),
    "a shared PostCompact group": (d) => ({
      hooks: { PostCompact: [{ hooks: [
        { type: "command", command: "/some/obsidian-bg-agent.sh", timeout: 10, async: true },
        { type: "command", command: tracker(d) },
      ] }] },
    }),
    "a scoped matcher": (d) => ({
      hooks: { PreCompact: [{ matcher: "manual", hooks: [{ type: "command", command: tracker(d) }] }] },
    }),
    "the previous SessionEnd chain": (d) => ({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: previousChain(d) }] }] },
    }),
    "an existing status line": () => ({ statusLine: OWN_STATUS_LINE }),
  };

  /** A fresh CLAUDE_DIR holding only the seeded settings.json. */
  function seeded(seed: (d: string) => unknown): string {
    const d = mkdtempSync(path.join(tmpdir(), "wt-flags-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify(seed(d), null, 2));
    return d;
  }

  /** Every entry under a directory: directories by name, files with their sha256. */
  function entries(root: string): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(path.join(root, rel)).sort()) {
        const r = path.join(rel, name);
        if (lstatSync(path.join(root, r)).isDirectory()) {
          out.push(`${r}/`);
          walk(r);
        } else {
          out.push(`${r} ${createHash("sha256").update(readFileSync(path.join(root, r))).digest("hex")}`);
        }
      }
    };
    walk("");
    return out;
  }

  /** A PATH directory linking every executable on the current PATH except `tool`. First one wins. */
  function pathWithout(tool: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-flags-path-"));
    const seen = new Set<string>();
    for (const p of (process.env.PATH ?? "").split(path.delimiter)) {
      let names: string[];
      try { names = readdirSync(p); } catch { continue; }
      for (const name of names) {
        if (name === tool || seen.has(name)) continue;
        const full = path.join(p, name);
        try {
          const st = statSync(full);
          if (!st.isFile() || (st.mode & 0o111) === 0) continue;
        } catch { continue; }
        seen.add(name);
        symlinkSync(full, path.join(dir, name));
      }
    }
    return dir;
  }

  // Guard 1. `watchtower setup` shows the user this output as the change it is
  // about to make, so it has to be the file the real run then writes.
  it("--dry-run predicts the real run, byte for byte", () => {
    for (const [name, seed] of Object.entries(SEEDS)) {
      for (const flags of [[], ["--status-line"]]) {
        const label = `${name}, flags [${flags.join(" ")}]`;
        const d = seeded(seed);
        const dry = runArgs(d, ["--dry-run", ...flags]);
        expect(dry.status, label).toBe(0);
        expect(runArgs(d, flags).status, label).toBe(0);
        expect(readFileSync(path.join(d, "settings.json"), "utf8"), label).toBe(dry.stdout);
      }
    }
  }, slow(30_000));

  // Guard 2, and a machine with no Claude dir yet.
  it("--dry-run writes nothing, into a seeded or a missing directory", () => {
    const d = seeded(SEEDS["a shared PostCompact group"]);
    writeFileSync(path.join(d, "statusline.sh"), "#!/usr/bin/env bash\nprintf 'just a prompt'\n");
    const before = entries(d);
    for (const flags of [[], ["--status-line"]]) {
      expect(runArgs(d, ["--dry-run", ...flags]).status).toBe(0);
    }
    expect(entries(d)).toEqual(before);

    const missing = path.join(mkdtempSync(path.join(tmpdir(), "wt-flags-missing-")), "absent", ".claude");
    const r = runArgs(missing, ["--dry-run"]);
    expect(r.status).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout).hooks).sort()).toEqual([...EVENTS].sort());
    expect(existsSync(missing)).toBe(false);
  });

  // A valid value followed by garbage is the case jq alone gets wrong: it prints
  // the merged first value, then fails, so stdout would hold half a preview.
  it("dry-run refuses invalid JSON", () => {
    for (const text of ["{not json", "{} trailing"]) {
      const d = mkdtempSync(path.join(tmpdir(), "wt-flags-badjson-"));
      writeFileSync(path.join(d, "settings.json"), text);
      const r = runArgs(d, ["--dry-run"]);
      expect(r.status, text).not.toBe(0);
      expect(r.stdout, text).toBe("");
    }
  });

  it("--status-line adds the snapshot script when there is no status line", () => {
    const d = seeded(SEEDS.empty);
    const r = runArgs(d, ["--status-line"]);
    expect(r.status).toBe(0);
    expect(settings(d).statusLine).toEqual({ type: "command", command: `${d}/watchtower-snapshot.sh` });
    expect(r.stdout).toContain(
      `install: status line set to ${d}/watchtower-snapshot.sh (records snapshots, displays nothing)`);
  });

  // Guard 3. The display is the user's; a tracker must never break Claude Code.
  it("--status-line never edits an existing status line", () => {
    const d = seeded(SEEDS["an existing status line"]);
    const r = runArgs(d, ["--status-line"]);
    expect(r.status).toBe(0);
    expect(JSON.stringify(settings(d).statusLine)).toBe(JSON.stringify(OWN_STATUS_LINE));
    expect(r.stdout).toContain("/x/line.sh");
    expect(r.stdout).toContain("watchtower-snapshot.sh");
  });

  // Guard 4. The second run finds the writer through settings.json's statusLine.
  it("--status-line is idempotent", () => {
    const d = seeded(SEEDS.empty);
    expect(runArgs(d, ["--status-line"]).status).toBe(0);
    const first = readFileSync(path.join(d, "settings.json"), "utf8");
    const second = runArgs(d, ["--status-line"]);
    expect(second.status).toBe(0);
    expect(readFileSync(path.join(d, "settings.json"), "utf8")).toBe(first);
    expect(second.stdout).toContain("existing snapshot capture detected");
  });

  // Guard 5. Without sqlite3 every capture script exits 0 silently, so an
  // install would report done and record nothing.
  it("refuses to install without sqlite3", () => {
    const bin = pathWithout("sqlite3");
    expect(existsSync(path.join(bin, "jq"))).toBe(true);
    const d = mkdtempSync(path.join(tmpdir(), "wt-flags-nosqlite-"));
    const r = runArgs(d, [], { PATH: bin });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("install: sqlite3 is required");
    expect(existsSync(path.join(d, "settings.json"))).toBe(false);
    expect(existsSync(path.join(d, "cc-track-lib.sh"))).toBe(false);
  });

  it("rejects an unknown argument before writing", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-flags-badarg-"));
    const r = runArgs(d, ["--frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: install.sh");
    expect(readdirSync(d)).toEqual([]);
  });
});
