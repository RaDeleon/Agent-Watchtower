import { spawn, type ChildProcess } from "node:child_process";

/**
 * While the dashboard is open, run `watchtower sync --quiet` now and every
 * `everySeconds` (R13) -- as a CHILD process, so the server itself stays
 * read-only (lib/serve.ts never writes). Never two at once: a tick that finds
 * the last sync still running is skipped. The timer is unref'd, so it never
 * keeps a process alive on its own.
 */
export function startBackgroundSync(opts: {
  script: string; everySeconds: number; env?: NodeJS.ProcessEnv;
  spawnImpl?: (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; stdio: "ignore" }) => ChildProcess;
  onExit?: (code: number | null) => void;
}): { stop(): void } {
  const run = opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, o));
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    const child = run(process.execPath, [opts.script, "sync", "--quiet"], { env: opts.env ?? process.env, stdio: "ignore" });
    const done = (code: number | null): void => { running = false; opts.onExit?.(code); };
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
  };
  tick();
  const timer = setInterval(tick, opts.everySeconds * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
