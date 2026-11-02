import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/typescript/live/**/*.test.ts",
      // Repeat the composition assertions over TCP instead of injected fetch.
      "tests/typescript/model-composition.test.ts",
      "tests/typescript/control-capabilities.test.ts",
    ],
    env: { BOUNDARY_COMPOSITION_LIVE: "1" },
  },
});
