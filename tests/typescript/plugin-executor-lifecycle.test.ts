// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createPluginExecutor, HostImports, loadPlugin } from "../../packages/guests/plugin/index";

const owners: ReturnType<typeof createPluginExecutor>[] = [];
const owner = () => {
  const created = createPluginExecutor({ maxWorkers: 1 });
  owners.push(created);
  return created;
};
afterEach(async () => { await Promise.all(owners.splice(0).map((entry) => entry.close())); });
const imports = new HostImports("boundary:guest/footprints@1.0.0");
const load = (executor: ReturnType<typeof owner>, artifact = "counter") => loadPlugin({
  executor,
  bytes: new Uint8Array(readFileSync(new URL(`../fixtures/plugin-worker/${artifact}.component.wasm`, import.meta.url))),
  imports, witDigest: "lifecycle", host: {}, lifetime: "persistent",
});

it("closing an active binding invalidates sibling bindings and never starts their queued calls", async () => {
  const executor = owner();
  const first = await load(executor, "loop");
  const sibling = await load(executor, "loop");
  expect(first.status).toBe("ready");
  expect(sibling.status).toBe("ready");
  if (first.status !== "ready" || sibling.status !== "ready") return;
  expect(executor.stats().preparations).toBe(1);
  const active = first.instance.call("run", "x");
  const queued = sibling.instance.call("run", "x");
  await first.instance.close();
  expect(await active).toMatchObject({ status: "fault", certainty: "unknown" });
  expect(await queued).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(await sibling.instance.call("run", "x"))
    .toMatchObject({ status: "fault", certainty: "not-started" });
  await sibling.instance.close();
  expect(executor.stats()).toMatchObject({ workers: 0, instances: 0, pending: 0, active: 0 });
  expect((await load(executor)).status).toBe("ready");
});

it("closing an idle binding preserves its sibling's persistent state and releases the last binding for eviction", async () => {
  const executor = owner();
  const first = await load(executor);
  const sibling = await load(executor);
  if (first.status !== "ready" || sibling.status !== "ready") throw new Error("expected bindings");
  expect(await sibling.instance.call("run", "x")).toEqual({ status: "returned", payload: "1" });
  await first.instance.close();
  expect(await sibling.instance.call("run", "x")).toEqual({ status: "returned", payload: "2" });
  expect(executor.stats().instances).toBe(1);
  await sibling.instance.close();
  expect(executor.stats().instances).toBe(0);
  expect((await load(executor, "loop")).status).toBe("ready");
  expect(executor.stats().workers).toBe(1);
});

it("closing while an artifact is being admitted leaves no late binding or worker", async () => {
  const executor = owner();
  const pending = load(executor);
  await executor.close();
  expect(await pending).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(executor.stats()).toMatchObject({ workers: 0, instances: 0, pending: 0, active: 0 });
  expect((await load(executor)).status).toBe("fault");
});

it("does not evict an artifact reserved by an overlapping bind", async () => {
  const executor = owner();
  const first = load(executor);
  const competing = load(executor, "loop");
  expect((await first).status).toBe("ready");
  expect(await competing).toMatchObject({ status: "fault", certainty: "not-started" });
  expect(executor.stats()).toMatchObject({ workers: 1, instances: 1 });
});
