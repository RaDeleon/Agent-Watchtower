import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSource } from "@/lib/core/discovery";

function emptyHome(): string {
  return mkdtempSync(path.join(tmpdir(), "wtd-"));
}

describe("detectSource", () => {
  it("detects claude when the config dir exists", async () => {
    const home = emptyHome();
    mkdirSync(path.join(home, ".claude"));
    expect((await detectSource("claude", { home })).detected).toBe(true);
  });

  // THE NEGATIVE CONTROL the positive case cannot supply. The real ~/.claude
  // exists on any machine that runs this suite, so "detects claude" stays green
  // even if opts.home were ignored entirely and homedir() probed instead. Only
  // asserting FALSE against a home that demonstrably lacks .claude proves the
  // option is load-bearing.
  it("does not detect claude when the given home lacks the config dir", async () => {
    expect((await detectSource("claude", { home: emptyHome() })).detected).toBe(false);
  });

  // Same argument for codex: ~/.codex/sessions is populated on the development
  // machine, so a not-detected assertion under a temp home is only meaningful
  // alongside a positive case that proves the probe can say true at all.
  it("detects codex only under the given home", async () => {
    const home = emptyHome();
    const sessions = path.join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    expect((await detectSource("codex", { home })).detected).toBe(false); // empty dir
    writeFileSync(path.join(sessions, "s.jsonl"), "");
    expect((await detectSource("codex", { home })).detected).toBe(true);
  });

  // Missing is NORMAL, never an error.
  it("reports not-detected rather than throwing when a source is absent", async () => {
    const home = emptyHome();
    await expect(detectSource("codex", { home })).resolves.toMatchObject({ detected: false });
  });

  it("never throws on an unknown source id", async () => {
    await expect(detectSource("nonesuch", { home: "/nope" }))
      .resolves.toMatchObject({ detected: false });
  });

  it("never throws on a home that does not exist", async () => {
    await expect(detectSource("claude", { home: "/nope/not/here" }))
      .resolves.toMatchObject({ detected: false });
  });

  // Atlas state is PER-REPO. An unbounded home scan is not acceptable.
  it("finds atlas only under configured roots", async () => {
    const home = emptyHome();
    const repo = path.join(home, "code", "proj");
    mkdirSync(path.join(repo, ".atlas"), { recursive: true });
    writeFileSync(path.join(repo, ".atlas", "sessions.db"), "");
    expect((await detectSource("atlas", { home, projectRoots: [path.join(home, "code")] })).detected).toBe(true);
    expect((await detectSource("atlas", { home, projectRoots: [] })).detected).toBe(false);
  });

  // "Bounded" is the whole point, so the bound gets its own test: a repo one
  // level deeper than maxDepth must NOT be found. Without this, maxDepth could
  // be ignored (or treated as infinite) and every test above would still pass.
  it("honours maxDepth and does not walk past it", async () => {
    const home = emptyHome();
    const deep = path.join(home, "code", "a", "b", "c", "proj");
    mkdirSync(path.join(deep, ".atlas"), { recursive: true });
    writeFileSync(path.join(deep, ".atlas", "sessions.db"), "");
    const roots = [path.join(home, "code")];
    expect((await detectSource("atlas", { home, projectRoots: roots, maxDepth: 2 })).detected).toBe(false);
    expect((await detectSource("atlas", { home, projectRoots: roots, maxDepth: 4 })).detected).toBe(true);
  });

  it("reports the path it matched so a detection is auditable", async () => {
    const home = emptyHome();
    const repo = path.join(home, "code", "proj");
    mkdirSync(path.join(repo, ".atlas"), { recursive: true });
    writeFileSync(path.join(repo, ".atlas", "sessions.db"), "");
    const r = await detectSource("atlas", { home, projectRoots: [path.join(home, "code")] });
    expect(r.detail).toBe(path.join(repo, ".atlas", "sessions.db"));
  });

  it("does not detect atlas from a root that does not exist", async () => {
    await expect(detectSource("atlas", { home: emptyHome(), projectRoots: ["/nope/nowhere"] }))
      .resolves.toMatchObject({ detected: false });
  });
});
