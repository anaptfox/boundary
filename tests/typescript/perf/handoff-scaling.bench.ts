// @vitest-environment node
import { expect, it } from "vitest";
import {
  bindProjection, compileInteractions, defineInteraction, directRealizationIds,
  implementInteractions, installInteractions, projectAllDirect,
  type AnyInteractionDefinition,
} from "@foxworth/boundary";
import {
  createCheckedHandoff, createHandoffInvocation, executeHandoff,
  type HandoffExecutable,
} from "@foxworth/boundary/handoff";
import { portableSchema, type JsonValue } from "@foxworth/boundary/program";
import { measure, measureSync, recordCase } from "./measure";

const Echo = portableSchema<{ readonly text: string }>({
  type: "object", properties: { text: { type: "string" } },
  required: ["text"], additionalProperties: false,
});

async function fixture(count: number) {
  type Catalog = Record<`echo${number}`, AnyInteractionDefinition>;
  const definitions: Catalog = {};
  for (let index = 0; index < count; index++) {
    definitions[`echo${index}`] = defineInteraction({ id: `perf.echo.${index}`,
      input: Echo, output: Echo, reads: ["echo"], changes: [] });
  }
  const compiled = await compileInteractions(definitions);
  const implementations = implementInteractions(definitions,
    Object.fromEntries(Object.keys(definitions).map(key => [key, (input: unknown) => input])) as
      Record<`echo${number}`, (input: unknown) => unknown>);
  const { installation } = await installInteractions(compiled, {
    installationId: `perf:handoff:${count}`, implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
  const projection = await projectAllDirect(compiled);
  const bound = await bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }),
  });
  if (bound.status !== "bound") throw new Error("performance fixture is unbound");
  const binding = bound.binding;
  const checked = await createCheckedHandoff(binding);
  // An explicit alternate workload estimates the avoidable manifest-processing
  // cost. This is a host-chosen checked snapshot, not an implementation patch.
  const prevalidated: HandoffExecutable = Object.freeze({
    manifest: checked.manifest,
    resolve: binding.resolve.bind(binding), invoke: binding.invoke.bind(binding),
  });
  return { binding, checked, prevalidated, caller: binding.connect(),
    handles: projection.handles,
    handle: projection.handles[`echo${count - 1}`]!, id: `perf.echo.${count - 1}` };
}

async function digestCalls(fn: () => Promise<unknown>): Promise<number> {
  const subtle = globalThis.crypto.subtle;
  const descriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
  const original = subtle.digest;
  let calls = 0;
  Object.defineProperty(subtle, "digest", { configurable: true, writable: true,
    value: function (...args: Parameters<typeof original>) {
      calls++;
      return Reflect.apply(original, subtle, args);
    } });
  try { await fn(); return calls; }
  finally {
    if (descriptor) Object.defineProperty(subtle, "digest", descriptor);
    else Reflect.deleteProperty(subtle, "digest");
  }
}

it("records matched dispatch tiers and immutable manifest scaling", async () => {
  const input = { text: "x" };
  const host = (value: typeof input) => value;
  let consumed: unknown;
  recordCase({ id: "ts.dispatch.host-direct", lang: "ts", class: "per-call",
    ...measureSync(() => { consumed = host(input); }, { warmup: 100, iters: 1000, batchSize: 32 }) });
  expect(consumed).toEqual(input);

  for (const count of [1, 10, 100, 1000]) {
    const f = await fixture(count);
    const invocation = await createHandoffInvocation(f.checked.manifest, f.id, "direct", input);
    const methods = {
      binding: () => f.caller.call(f.handle, input),
      raw: () => executeHandoff(f.binding, invocation, undefined),
      checked: () => f.checked.invoke(invocation, undefined),
      prevalidated: () => executeHandoff(f.prevalidated, invocation, undefined),
    };
    for (const [tier, call] of Object.entries(methods)) {
      const output = await call();
      if (tier === "binding") expect(output).toEqual(input);
      else expect(output).toMatchObject({ certainty: "completed", result: { kind: "returned", value: input } });
      const hashes = await digestCalls(call);
      recordCase({ id: `ts.dispatch.${tier}.${count}`, lang: "ts", class: "per-call",
        extra: { interactions: count, payloadBytes: 1, diagnosticDigestCalls: hashes },
        ...await measure(call, { warmup: count === 1000 ? 2 : 10, iters: count === 1000 ? 12 : 40 }) });
    }
    recordCase({ id: `ts.checked.setup.${count}`, lang: "ts", class: "startup",
      extra: { interactions: count },
      ...await measure(() => createCheckedHandoff(f.binding), { warmup: 1, iters: count === 1000 ? 3 : 8 }) });
    if (count === 1000) for (const [position, index] of [["first", 0], ["middle", 500]] as const) {
      const selected = await createHandoffInvocation(f.checked.manifest, `perf.echo.${index}`, "direct", input);
      const call = () => f.checked.invoke(selected, undefined);
      expect(await call()).toMatchObject({ certainty: "completed", result: { kind: "returned", value: input } });
      recordCase({ id: `ts.dispatch.checked.1000.${position}`, lang: "ts", class: "per-call",
        extra: { interactions: count, interactionIndex: index, payloadBytes: 1 },
        ...await measure(call, { warmup: 10, iters: 80 }) });
    }
  }
}, 180_000);

it("records direct and checked payload-copy scaling", async () => {
  const f = await fixture(10);
  for (const size of [1024, 65536]) {
    const input: JsonValue = { text: "x".repeat(size) };
    const invocation = await createHandoffInvocation(f.checked.manifest, f.id, "direct", input);
    for (const [tier, call] of [
      ["binding", () => f.caller.call(f.handle, input)],
      ["checked", () => f.checked.invoke(invocation, undefined)],
      ["prevalidated", () => executeHandoff(f.prevalidated, invocation, undefined)],
    ] as const) {
      recordCase({ id: `ts.payload.${tier}.${size}`, lang: "ts", class: "per-call",
        extra: { interactions: 10, payloadBytes: size },
        ...await measure(call, { warmup: 20, iters: 80 }) });
    }
  }
});
