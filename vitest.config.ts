import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { LOG_LEVEL: "silent" },
    // `npm run test:coverage`: a diagnostic, not a gate - there is deliberately no threshold. CI publishes the summary.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
