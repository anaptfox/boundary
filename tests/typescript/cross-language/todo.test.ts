import { afterEach, describe, expect, it } from "vitest";
import { createHandoffInvocation, executeHandoff, validateProjectionBindingManifest } from "@foxworth/boundary/handoff";
import { createProjectionClient } from "@foxworth/boundary/client";
import { normalizeJson } from "@foxworth/boundary/program";
import scenarios from "./scenarios.v1.json";
import { nativeTodo } from "./native";
import { startRustTodo } from "./transport";

const processes: ReturnType<typeof startRustTodo>[] = [];
function rust() { const host = startRustTodo(); processes.push(host); return host; }
afterEach(async () => { for (const host of processes.splice(0)) await host.close(); });

describe("current Rust/TypeScript Todo process fixture", () => {
  it("runs the reviewed seven-interaction scenario in both native hosts", async () => {
    const host = rust();
    const client = createProjectionClient(host.transport);
    const manifest = await client.inspect();
    const native = await nativeTodo();
    const ts = createProjectionClient({ inspect: async () => native.binding.manifest, invoke: (invocation) => executeHandoff(native.binding, invocation, undefined) });
    expect(manifest.interactions).toHaveLength(7);
    for (const step of scenarios.direct.steps) {
      if (step.kind === "domain-error") {
        // Both hosts declare one { code, details } error contract; details carry the id.
        const invocation = await createHandoffInvocation(manifest, step.interactionId, "direct", normalizeJson(step.input ?? null));
        const outcome = await host.transport.invoke(invocation);
        expect(outcome).toMatchObject({ certainty: "completed", result: { kind: "declared-error", code: "todo_not_found", details: step.expected } });
        await expect(ts.callRaw(step.interactionId, step.input)).rejects.toMatchObject({ value: { code: "todo_not_found", details: { id: "todo-missing" } } });
      } else {
        expect(await client.callRaw(step.interactionId, step.input)).toEqual(step.expected);
        expect(await ts.callRaw(step.interactionId, step.input)).toEqual(step.expected);
      }
    }
    expect(await host.request({ kind: "stats" })).toMatchObject({ rows: 0, calls: { "todos.create": 2, "todos.clearCompleted": 1 } });
  });

  it("rejects invalid input, stale identity, and an unselected interaction before effects", async () => {
    const host = rust();
    const manifest = validateProjectionBindingManifest(await host.transport.inspect());
    const invocation = await createHandoffInvocation(manifest, "todos.create", "direct", { title: "valid" });
    for (const input of [scenarios.boundary.invalidCreateInput, scenarios.boundary.emptyCreateInput]) {
      expect(await host.transport.invoke({ ...invocation, input })).toMatchObject({ certainty: "not-started", result: { kind: "fault", cause: "invalid-input" } });
    }
    for (const replacement of [
      { bindingDigest: `sha256:${"0".repeat(64)}` },
      { actualContractDigest: `sha256:${"0".repeat(64)}` },
      { interactionId: "todos.hidden" },
      { mode: "request" },
    ]) {
      await expect(host.request({ kind: "invoke", invocation: { ...invocation, ...replacement } })).rejects.toThrow("rejected");
    }
    expect(await host.request({ kind: "stats" })).toMatchObject({ rows: 0, calls: { "todos.create": 0 } });
  });

  it("shares one declared-error contract and accepts the Rust declared error", async () => {
    const host = rust();
    const client = createProjectionClient(host.transport);
    const manifest = await client.inspect();
    const native = await nativeTodo();
    for (const rustInteraction of manifest.actualProgram.interactions) {
      const tsInteraction = native.compiled.program.interactions.find((item) => item.contract.id === rustInteraction.contract.id)!;
      expect(rustInteraction.contract.inputSchema).toEqual(tsInteraction.contract.inputSchema);
      expect(rustInteraction.contract.outputSchema).toEqual(tsInteraction.contract.outputSchema);
      expect(rustInteraction.contract.reads).toEqual(tsInteraction.contract.reads);
      expect(rustInteraction.contract.changes).toEqual(tsInteraction.contract.changes);
      expect(rustInteraction.contract.errorSchema).toEqual(tsInteraction.contract.errorSchema);
    }
    // The complete { code, details } value validates against both pinned contracts.
    await expect(client.callRaw("todos.rename", { id: "missing", title: "x" })).rejects.toMatchObject({
      value: { code: "todo_not_found", details: { id: "missing" } },
    });
  });
});
