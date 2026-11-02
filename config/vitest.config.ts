import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/typescript/**/*.test.ts",
      "tests/typescript/**/*.test.tsx",
    ],
    exclude: ["tests/typescript/live/**", "tests/typescript/cross-language/**", "**/node_modules/**"],
    env: { BOUNDARY_COMPOSITION_LIVE: "0" },
  },
});
