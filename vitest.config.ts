import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "apps/desktop/scripts/**/*.test.ts",
      "apps/landing/src/**/*.test.ts",
    ],
    testTimeout: 60_000,
  },
});
