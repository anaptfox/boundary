// @vitest-environment node
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createPluginExecutor, HostImports, loadPlugin } from "../../../packages/guests/plugin/index";
import { measure, recordCase } from "./measure";

// Real component workload. Compilation, instantiation, invocation, and host
// wall time are distinct measurements; these are not cross-runtime claims.
const bytes = new Uint8Array(readFileSync(new URL("../../fixtures/plugin-worker/counter.component.wasm", import.meta.url)));
const imports = new HostImports("boundary:guest/footprints@1.0.0");

it("records plugin preparation, heap lifetimes, and recovery", async () => {
  const executor = createPluginExecutor();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const rssBefore = process.memoryUsage().rss;
  try {
    const start = performance.now();
    const loaded = await loadPlugin({ executor, bytes, imports, witDigest: "counter", host: {}, lifetime: "persistent" });
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error(JSON.stringify(loaded));
    const firstLoadNs = (performance.now() - start) * 1e6;
    recordCase({ id: "ts.plugin.cold-load", lang: "ts", class: "startup", iters: 1,
      nsMedian: firstLoadNs, nsP95: firstLoadNs,
      extra: { artifactBytes: bytes.byteLength, ...executor.stats() } });
    for (const lifetime of ["per-call", "persistent"] as const) {
      const bound = await loadPlugin({ executor, bytes, imports, witDigest: "counter", host: {}, lifetime });
      if (bound.status !== "ready") throw new Error(JSON.stringify(bound));
      for (const size of [1, 1024]) {
        const input = "x".repeat(size);
        recordCase({ id: `ts.plugin.${lifetime}.${size}`, lang: "ts", class: "per-call",
          ...await measure(async () => {
            const result = await bound.instance.call("run", input);
            if (result.status !== "returned") throw new Error(JSON.stringify(result));
          }, { warmup: 5, iters: 30 }), extra: { payloadBytes: size } });
      }
      await bound.instance.close();
    }
    recordCase({ id: "ts.plugin.trap-and-recovery", lang: "ts", class: "per-call",
      ...await measure(async () => {
        expect(await loaded.instance.call("run", "t")).toMatchObject({ status: "fault", certainty: "unknown" });
        expect(await loaded.instance.call("run", "x")).toMatchObject({ status: "returned" });
      }, { warmup: 2, iters: 10 }),
      extra: { ...executor.stats(), rssDeltaBytes: process.memoryUsage().rss - rssBefore,
        eventLoopP99Ms: delay.percentile(99) / 1e6 } });
  } finally {
    delay.disable();
    await executor.close();
  }
});
