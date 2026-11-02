// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HostImports,
  createPluginExecutor,
  loadPlugin,
} from "../../packages/guests/plugin/index";

const imports = new HostImports("boundary:guest/footprints@1.0.0");
const counterBytes = new Uint8Array(
  readFileSync(new URL("../fixtures/plugin-worker/counter.component.wasm", import.meta.url)),
);
const loopBytes = new Uint8Array(
  readFileSync(new URL("../fixtures/plugin-worker/loop.component.wasm", import.meta.url)),
);

async function ready(
  executor: ReturnType<typeof createPluginExecutor>,
  bytes: Uint8Array,
  lifetime: "per-call" | "persistent",
) {
  const loaded = await loadPlugin({
    executor,
    bytes,
    imports,
    witDigest: "sha256:worker-fixture",
    host: {},
    lifetime,
  });
  expect(loaded.status).toBe("ready");
  if (loaded.status !== "ready") throw new Error(JSON.stringify(loaded));
  return loaded;
}

describe("plugin worker", () => {
  it("serializes persistent calls, rebuilds after a trap, and keeps one artifact compilation", async () => {
    const executor = createPluginExecutor({ callTimeoutMs: 2_000 });
    try {
      const loaded = await ready(executor, counterBytes, "persistent");
      const initial = executor.stats();
      expect(initial.workers).toBe(1);
      expect(initial.compilations).toBeGreaterThan(0);

      const beforeTrap = await Promise.all([
        loaded.instance.call("run", "x"),
        loaded.instance.call("run", "x"),
      ]);
      expect(beforeTrap.map((result) => result.status)).toEqual(["returned", "returned"]);
      expect(beforeTrap.map((result) => result.status === "returned" ? result.payload : "").sort())
        .toEqual(["1", "2"]);
      await expect(loaded.instance.call("run", "t")).resolves.toMatchObject({
        status: "fault", certainty: "unknown",
      });

      const recovered = await Promise.all([
        loaded.instance.call("run", "x"),
        loaded.instance.call("run", "x"),
      ]);
      expect(recovered.map((result) => result.status === "returned" ? result.payload : "").sort())
        .toEqual(["1", "2"]);
      expect(executor.stats().compilations).toBe(initial.compilations);

      await loaded.instance.close();
      await expect(loaded.instance.call("run", "x")).resolves.toMatchObject({
        status: "fault", certainty: "not-started",
      });
    } finally {
      await executor.close();
    }
  });

  it("gives each per-call invocation a fresh heap while retaining compiled modules", async () => {
    const executor = createPluginExecutor({ callTimeoutMs: 2_000 });
    try {
      const loaded = await ready(executor, counterBytes, "per-call");
      const compilations = executor.stats().compilations;
      const outcomes = await Promise.all([
        loaded.instance.call("run", "x"),
        loaded.instance.call("run", "x"),
        loaded.instance.call("run", "x"),
      ]);
      expect(outcomes).toEqual([
        { status: "returned", payload: "1" },
        { status: "returned", payload: "1" },
        { status: "returned", payload: "1" },
      ]);
      expect(executor.stats().compilations).toBe(compilations);
    } finally {
      await executor.close();
    }
  });

  it("times out an infinite loop without blocking the host event loop", async () => {
    const executor = createPluginExecutor({ callTimeoutMs: 30 });
    try {
      const loaded = await ready(executor, loopBytes, "persistent");
      let ticked = false;
      const tick = new Promise<void>((resolve) => setTimeout(() => {
        ticked = true;
        resolve();
      }, 0));
      const result = await loaded.instance.call("run", "x");
      await tick;
      expect(ticked).toBe(true);
      expect(result).toMatchObject({ status: "fault", certainty: "unknown" });
    } finally {
      await executor.close();
    }
  });
});
