import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  // Hosted CI runners have 3-4 cores against a workstation's 10+, and every
  // rollup test runs the real bash scripts, so vitest's 5 s default only holds
  // locally. Four times it on CI, as tests/helpers/timeout.ts does for tests
  // that set their own.
  test: { environment: "node", testTimeout: process.env.CI ? 20_000 : 5_000 },
});
