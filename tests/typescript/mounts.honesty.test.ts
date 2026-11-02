import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const mountSources = [
  "packages/adapters/frameworks/vite.ts",
  "packages/adapters/frameworks/next.ts",
  "packages/adapters/frameworks/hono.ts",
  "packages/adapters/cloudflare/durable-object.ts",
  "packages/adapters/cloudflare/worker.ts",
  "packages/adapters/electron/projection-main.ts",
  "packages/adapters/electron/dispatch.ts",
  "packages/adapters/electron/ipc.ts",
] as const;

function runtimeSource(source: string): string {
  // This remains a source regression guard, not a dependency-graph proof.
  // Only a whole `import type` declaration is excluded; mixed imports remain.
  return source.replace(/^import\s+type\b[^;]*;[ \t]*$/gm, "");
}

describe("framework adapters preserve the HTTP projection boundary", () => {
  for (const relative of mountSources) {
    it(`${relative} accepts a handler and owns no interaction meaning`, async () => {
      const source = await readFile(path.join(root, relative), "utf8");
      expect(source).toContain("HttpHandler");
      // Native interfaces can carry host types without acquiring an execution
      // engine. Behavioral native tests separately prove admission and pinning.
      expect(runtimeSource(source)).not.toMatch(
        /@foxworth\/host|@foxworth\/handoff|createHost|host\.invoke|hostModule|createJiti|jiti|target\s*===|verb\s*===|routeFor\s*\(|\/_boundary\/(?:program|call)/,
      );
    });
  }
});
