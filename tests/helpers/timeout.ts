/**
 * A test's own timeout, stretched on CI. These timeouts guard against hangs
 * and were set on a 10+ core workstation. A hosted runner has 3-4 cores and
 * runs the same bash and sqlite3 work several times slower under parallel
 * load: the live-density report test takes 7.8 s here and over 30 s on
 * macos-15. vitest.config.ts stretches the default the same way.
 */
export const slow = (ms: number): number => (process.env.CI ? ms * 4 : ms);
