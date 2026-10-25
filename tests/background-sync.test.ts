import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startBackgroundSync } from "@/lib/background-sync";

function fake() {
  const calls: { cmd: string; args: string[] }[] = [];
  const children: EventEmitter[] = [];
  const spawnImpl = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = new EventEmitter();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  return { calls, children, spawnImpl };
}

describe("startBackgroundSync", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("spawns once immediately, running sync --quiet", () => {
    const f = fake();
    const h = startBackgroundSync({ script: "/x/watchtower", everySeconds: 300, spawnImpl: f.spawnImpl });
    expect(f.calls).toEqual([{ cmd: process.execPath, args: ["/x/watchtower", "sync", "--quiet"] }]);
    h.stop();
  });

  it("never runs two at once", () => {
    const f = fake();
    const h = startBackgroundSync({ script: "/x/watchtower", everySeconds: 300, spawnImpl: f.spawnImpl });
    vi.advanceTimersByTime(300_000);
    expect(f.calls.length).toBe(1);
    h.stop();
  });

  it("spawns again after the child exits, and reports the exit code", () => {
    const f = fake();
    const codes: (number | null)[] = [];
    const h = startBackgroundSync({ script: "/x/watchtower", everySeconds: 300, spawnImpl: f.spawnImpl, onExit: (c) => codes.push(c) });
    f.children[0].emit("exit", 0);
    vi.advanceTimersByTime(300_000);
    expect(f.calls.length).toBe(2);
    expect(codes).toEqual([0]);
    h.stop();
  });

  it("stop() ends the schedule", () => {
    const f = fake();
    const h = startBackgroundSync({ script: "/x/watchtower", everySeconds: 300, spawnImpl: f.spawnImpl });
    f.children[0].emit("exit", 0);
    h.stop();
    vi.advanceTimersByTime(600_000);
    expect(f.calls.length).toBe(1);
  });
});
