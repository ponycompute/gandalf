import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  resolve: { conditions: ["source"] },
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    globalSetup: ["e2e/ffmpeg.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
