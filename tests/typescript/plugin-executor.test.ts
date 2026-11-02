import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createPluginExecutor, HostImports, loadPlugin, type ExecutorOptions } from "../../packages/guests/plugin/index";

const executors: ReturnType<typeof createPluginExecutor>[] = [];
function executor(options?: ExecutorOptions) {
  const result = createPluginExecutor(options);
  executors.push(result);
  return result;
}
afterEach(async () => { await Promise.all(executors.splice(0).map((entry) => entry.close())); });
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/plugin-worker/${name}.component.wasm`, import.meta.url)));
const imports = new HostImports("boundary:guest/footprints@1.0.0");
const bind = (owner: ReturnType<typeof executor>, name = "counter") =>
  loadPlugin({ executor: owner, bytes: fixture(name), imports, witDigest: "test", host: {} });

it("bounds active artifact capacity and evicts only released bindings", async () => {
  const owner = executor({ maxWorkers: 1 });
  const first = await bind(owner);
  expect(first.status).toBe("ready");
  if (first.status !== "ready") return;
  const other = await bind(owner, "loop");
  expect(other).toMatchObject({ status: "fault", certainty: "not-started" });
  await first.instance.close();
  const replacement = await bind(owner, "loop");
  expect(replacement.status).toBe("ready");
  expect(owner.stats().workers).toBe(1);
  await owner.close();
  expect(owner.stats()).toMatchObject({ workers: 0, instances: 0, pending: 0 });
});

it("refuses excess instances without changing another instance", async () => {
  const owner = executor({ maxInstances: 1 });
  const first = await bind(owner);
  expect(first.status).toBe("ready");
  if (first.status !== "ready") return;
  expect(await bind(owner)).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(await first.instance.call("run", "x")).toMatchObject({ status: "returned" });
});

it("does not retain a failed preparation promise", async () => {
  const owner = executor({ maxPreparedBytes: 1 });
  // A valid, admitted component fails the prepared byte limit after decoding.
  const attempt = () => bind(owner);
  expect(await attempt()).toMatchObject({ status: "fault", certainty: "not-started" });
  const preparations = owner.stats().preparations;
  expect(await attempt()).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(owner.stats().preparations).toBeGreaterThan(preparations);
  expect(owner.stats().workers).toBe(0);
});

const thumbnail = new URL("../../examples/guests/thumbnail/zig/zig-out/thumbnail.component.wasm", import.meta.url);
it.skipIf(!existsSync(thumbnail))("aborts an async host effect without dispatching queued calls or retrying", async () => {
  const owner = executor({ maxPending: 2 });
  let started!: () => void;
  const effectStarted = new Promise<void>((resolve) => { started = resolve; });
  let hostCalls = 0;
  let hostSignal: AbortSignal | undefined;
  const loaded = await loadPlugin({ executor: owner, bytes: new Uint8Array(readFileSync(thumbnail)),
    imports: new HostImports(imports.interface).provide("images"), witDigest: "thumbnail", host: {
      images: async (_request, { signal }) => {
        hostCalls += 1;
        hostSignal = signal;
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { tag: "unknown", val: "effect acknowledgement lost" };
      },
    } });
  expect(loaded.status).toBe("ready");
  if (loaded.status !== "ready") return;
  const activeAbort = new AbortController();
  const payload = JSON.stringify({ imageId: "source", maxWidth: 200 });
  const active = loaded.instance.call("images-make-thumbnail", payload, { signal: activeAbort.signal });
  await effectStarted;
  const queuedAbort = new AbortController();
  const queued = loaded.instance.call("images-make-thumbnail", payload, { signal: queuedAbort.signal });
  expect(await loaded.instance.call("images-make-thumbnail", payload))
    .toMatchObject({ status: "fault", certainty: "not-started" });
  queuedAbort.abort();
  expect(await queued).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(hostCalls).toBe(1);
  activeAbort.abort();
  expect(await active).toMatchObject({ status: "fault", certainty: "unknown" });
  expect(hostSignal?.aborted).toBe(true);
  expect(await loaded.instance.call("images-make-thumbnail", payload))
    .toMatchObject({ status: "fault", certainty: "not-started" });
  expect(hostCalls).toBe(1);
});

it("rejects missing or colliding host capabilities before preparing code", async () => {
  const owner = executor();
  const bytes = new Uint8Array(readFileSync(new URL("../fixtures/wasm-imports/compliant.component.wasm", import.meta.url)));
  const args = { executor: owner, bytes, imports: new HostImports(imports.interface).provide("images"), witDigest: "admission" };
  expect(await loadPlugin({ ...args, host: {} })).toMatchObject({ status: "refused" });
  expect(await loadPlugin({ ...args, host: { images: () => "{}", Images: () => "{}" } }))
    .toMatchObject({ status: "fault", certainty: "not-started" });
  expect(owner.stats()).toMatchObject({ preparations: 0, workers: 0 });
});

it("enforces source and prepared byte limits before executing guest initializers", async () => {
  const sourceBound = executor({ maxArtifactBytes: 1 });
  expect(await bind(sourceBound)).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(sourceBound.stats().preparations).toBe(0);
  const preparedBound = executor({ maxPreparedBytes: 1 });
  expect(await bind(preparedBound)).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(preparedBound.stats()).toMatchObject({ preparations: 1, workers: 0, instances: 0 });
});
