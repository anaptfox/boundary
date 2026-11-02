import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    environment: "happy-dom",
    include: ["tests/typescript/perf/**/*.bench.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
