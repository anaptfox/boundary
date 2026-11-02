import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileInteractions, composeCompiledInteractions } from "@foxworth/boundary/pipeline";
import { declaredInteractionError } from "@foxworth/boundary";
import { verifyContentManifest, verifyPackReceipt } from "@foxworth/boundary/artifact";
import {
  capacityModule,
  createModuleCompositionHost,
  runModuleCompositionScenario,
  taskModule,
  type Context,
  type DispatchStyle,
} from "../../../examples/snippets/typescript/module-composition.ts";

const receiptPath = process.env.BOUNDARY_PACK_RECEIPT;
const consumerRoot = process.env.BOUNDARY_PACKED_CONSUMER;
assert.ok(receiptPath, "the packed receipt must be supplied");
assert.ok(consumerRoot, "the temporary consumer root must be supplied");
const packed = await verifyPackReceipt(receiptPath, { name: "@foxworth/boundary" });
const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("@foxworth/boundary/package.json")));
const relative = path.relative(consumerRoot, packageRoot);
assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
  "runtime exports must resolve inside the temporary consumer");
await verifyContentManifest(packageRoot, {
  ...packed.receipt.package,
  aggregateDigest: packed.receipt.contentDigest,
});
for (const entry of ["@foxworth/boundary", "@foxworth/boundary/program"]) {
  const resolved = fileURLToPath(import.meta.resolve(entry));
  assert.ok(resolved.startsWith(`${packageRoot}${path.sep}`),
    "every used runtime export must belong to the verified package");
}

const context: Context = { principal: "fox", projects: ["public"], mayMutate: true };
const input = { project: "public", task: "todo-1", completed: true };
const ordinary = await runModuleCompositionScenario("ordinary");
const native = await runModuleCompositionScenario("native");
for (const scenario of [ordinary, native]) {
  const { host } = scenario;
  assert.deepEqual(Object.keys(host.compiled.handles).sort(), [
    "capacityMutate", "capacityQuery", "taskMutate", "taskQuery",
  ]);
  assert.deepEqual(Object.keys(host.projections.taskEditor.handles).sort(), ["mutate", "query"]);
  assert.deepEqual(Object.keys(host.projections.taskReader.handles), ["query"]);
  assert.deepEqual(Object.keys(host.projections.capacityReader.handles), ["query"]);
  for (const binding of Object.values(host.bindings)) {
    assert.equal(binding.manifest.installationId, host.installation.installationId);
    assert.equal(binding.manifest.installationDigest, host.installation.manifest.installationDigest);
  }
  assert.equal(host.installation.manifest.program.programDigest, host.compiled.program.programDigest);
  assert.deepEqual(scenario.before, { ...input, completed: false });
  assert.deepEqual(scenario.completed, input);
  assert.deepEqual(scenario.after, input);
  assert.deepEqual(scenario.capacity, { project: "public", limit: 2 });
  assert.equal(scenario.denied.certainty, "not-started");
  assert.equal(scenario.denied.result.kind, "denied");
  assert.equal(host.telemetry.dispatches.length, 4, "input denial must dispatch zero times");
  assert.equal(host.telemetry.admissions.length, 5);
  assert.ok(host.telemetry.dispatches.every(call => call.context === scenario.context),
    "the original host context must reach every dispatch");
  assert.deepEqual(host.telemetry.admissions.map(request => request.handle.interactionId), [
    "tasks.query", "tasks.mutate", "tasks.query", "capacity.query", "tasks.mutate",
  ]);
  const mutation = host.bindings.taskEditor.resolve(taskModule.mutate.id);
  assert.ok(mutation);
  assert.equal(host.bindings.taskReader.resolve(taskModule.mutate.id), undefined);
  await assert.rejects(host.callers.taskReader.callRaw(mutation, input, scenario.context),
    error => error instanceof Error && "certainty" in error && error.certainty === "not-started");
  assert.equal(host.telemetry.dispatches.length, 4, "an excluded interaction must dispatch zero times");
  const noMutation = await host.callers.taskEditor.callRaw(mutation, input, {
    ...scenario.context, mayMutate: false,
  });
  assert.equal(noMutation.certainty, "not-started");
  assert.equal(noMutation.result.kind, "denied");
  assert.equal(host.telemetry.dispatches.length, 4, "a query-only principal cannot mutate");
  const admissionsBefore = host.telemetry.admissions.length;
  const invalidInput = await host.callers.taskEditor.callRaw(mutation, { project: "public", task: "todo-1" }, scenario.context);
  assert.equal(invalidInput.certainty, "not-started");
  assert.equal(invalidInput.result.kind, "fault");
  assert.equal(host.telemetry.admissions.length, admissionsBefore, "invalid input must not reach authorization");
  assert.equal(host.telemetry.dispatches.length, 4);
}

async function outcomes(style: DispatchStyle) {
  const behaviors = [
    { name: "returned", taskMutation: () => input, certainty: "completed", kind: "returned" },
    { name: "declared", taskMutation: () => { throw declaredInteractionError(taskModule.mutate, "missing", { project: "public", task: "todo-1" }); }, certainty: "completed", kind: "declared-error" },
    { name: "invalid-output", taskMutation: () => ({ ...input, completed: "invalid" } as never), certainty: "unknown", kind: "fault" },
    { name: "exception", taskMutation: () => { throw new Error("host effect may have started"); }, certainty: "unknown", kind: "fault" },
  ] as const;
  const summaries = [];
  for (const behavior of behaviors) {
    const host = await createModuleCompositionHost({ style, taskMutation: behavior.taskMutation });
    const mutation = host.bindings.taskEditor.resolve(taskModule.mutate.id);
    assert.ok(mutation);
    const outcome = await host.callers.taskEditor.callRaw(mutation, input, context);
    assert.equal(outcome.certainty, behavior.certainty, behavior.name);
    assert.equal(outcome.result.kind, behavior.kind, behavior.name);
    assert.equal(host.telemetry.dispatches.length, 1, `${behavior.name} must dispatch once without retries`);
    if (behavior.name === "returned") assert.deepEqual(outcome.result, { kind: "returned", value: input });
    if (behavior.name === "declared") assert.deepEqual(outcome.result, {
      kind: "declared-error", code: "missing", details: { project: "public", task: "todo-1" },
    });
    if (outcome.result.kind === "fault") {
      assert.equal(outcome.result.cause, behavior.name === "invalid-output" ? "invalid-realization-outcome" : "realization-failed");
    }
    summaries.push({ name: behavior.name, certainty: outcome.certainty, result: outcome.result });
  }
  return summaries;
}
assert.deepEqual(await outcomes("ordinary"), await outcomes("native"),
  "the ordinary and native returned-wrapper paths must preserve the same exercised outcomes");

const localTasks = await compileInteractions(taskModule);
const localCapacity = await compileInteractions(capacityModule);
await assert.rejects(composeCompiledInteractions(localTasks, localCapacity),
  "repeated aliases must be rejected instead of silently namespaced");
await assert.rejects(composeCompiledInteractions(
  await compileInteractions({ first: taskModule.mutate }),
  await compileInteractions({ second: taskModule.mutate }),
), "repeated interaction IDs must remain rejected even with distinct aliases");
console.log("Packed module recipe: shared installation, selected authority, validated input, and ordinary/native outcome laws passed.");
