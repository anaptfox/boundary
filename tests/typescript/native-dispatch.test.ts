import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  admitAll, bindNativeInteractions, bindProjection, compileInteractions, defineInteraction,
  describeBinding, installInteractions, projectInteractions, restrictBinding,
  type Admission, type InvocationCoordinator, type RawInvocationOutcome,
} from "@foxworth/boundary";
import { portableSchema, type InvocationObservation } from "@foxworth/boundary/program";
import { createControlRequestContributions } from "../../packages/core/host/control";
import { createHandoffInvocation, executeHandoff } from "@foxworth/boundary/handoff";

const Input = portableSchema<string>({ type: "string" });
const Output = portableSchema<string>({ type: "string" });
type Context = { requestId: string; marker?: object };

async function fixture(coordinate?: InvocationCoordinator<Context>, admit: Admission<Context> = admitAll) {
  const definitions = {
    echo: defineInteraction({ id: "coordination.echo", input: Input, output: Output, changes: ["documents"] }),
    other: defineInteraction({ id: "coordination.other", output: Output }),
  };
  const compiled = compileInteractions(definitions);
  const dispatched: Context[] = [];
  const events: InvocationObservation[] = [];
  const requests: Context[] = [];
  const bindings = bindNativeInteractions<typeof definitions, { echo: number; other: number }, Context>(compiled, { echo: 1, other: 2 }, {
    echo({ input, context, outcomes }) { dispatched.push(context); return outcomes.returned(input); },
    other({ outcomes }) { return outcomes.returned("other"); },
  });
  const installed = installInteractions<typeof definitions, Context>(compiled, {
    installationId: "coordination:installation", bindings,
    requests: createControlRequestContributions(compiled, {
      echo: { interaction: compiled.handles.echo, controlDigest: compiled.handles.echo.contractDigest, previewSchema: Output,
        request(input, context: Context) { requests.push(context); return input; } },
    }),
    realizationIds: { echo: { direct: "echo:direct", request: "echo:request" }, other: { direct: "other:direct" } },
  });
  const projection = projectInteractions(compiled, {
    echo: { interaction: compiled.handles.echo, modes: ["direct", "request"] }, other: "direct",
  });
  const bound = bindProjection(projection, installed.installation, { admit, coordinate, observation: { publish(event) { events.push(event); } } });
  if (bound.status !== "bound") throw new Error("fixture not bound");
  return { ...bound, compiled, projection, installed, dispatched, events, requests };
}

describe("typed native integration", () => {
  it("lowers shorthand to the same exact selection identity and keeps explicit aliases", async () => {
    const { compiled } = await fixture();
    const simple = projectInteractions(compiled, { echo: "direct" });
    const explicit = projectInteractions(compiled, { echo: { interaction: compiled.handles.echo, modes: ["direct"] } });
    expect(simple.manifest).toEqual(explicit.manifest);
    expect(Object.keys(simple.handles)).toEqual(["echo"]);
    const mixed = projectInteractions(compiled, { echo: "request", renamed: { interaction: compiled.handles.other, modes: ["direct"] } });
    expect(mixed.handles.renamed.interactionId).toBe("coordination.other");
  });

  it("rejects unknown keys, accessors, symbols, hidden keys and malformed modes without invoking getters", async () => {
    const { compiled } = await fixture();
    let getters = 0;
    const accessor = Object.defineProperty({}, "echo", { enumerable: true, get() { getters++; return "direct"; } });
    const hidden = Object.defineProperty({}, "echo", { value: "direct" });
    for (const invalid of [{ missing: "direct" }, { echo: "invalid" }, accessor, hidden, { [Symbol("echo")]: "direct" }]) {
      expect(() => projectInteractions(compiled, invalid as never)).toThrow(expect.objectContaining({ code: "INVALID_PROJECTION" }));
    }
    expect(getters).toBe(0);
    expect(() => bindNativeInteractions(compiled, { echo: 1 } as never, {} as never)).toThrow();
  });
});

describe("checked selected Binding descriptions", () => {
  it("only exposes the narrowed selection, freezes schema data and rejects forged bindings", async () => {
    const parent = await fixture();
    const projection = projectInteractions(parent.compiled, { echo: "request" });
    const child = restrictBinding(parent.binding, { projection, admit: admitAll });
    if (child.status !== "bound") throw new Error("child not bound");
    const descriptions = describeBinding(child.binding);
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatchObject({ alias: "echo", mode: "request", inputArity: 1, realizationId: "echo:request", request: { controlDigest: parent.compiled.handles.echo.contractDigest } });
    expect(Object.isFrozen(descriptions[0]?.expected.contract.inputSchema)).toBe(true);
    expect(JSON.stringify(descriptions)).not.toMatch(/dispatch|marker|admission|revoke/);
    expect(() => describeBinding({ ...child.binding })).toThrow();
    const mutable = structuredClone(descriptions);
    (mutable[0]!.expected.contract as { outputSchema: unknown }).outputSchema = { type: "number" };
    await expect(child.binding.connect().request(projection.handles.echo, "safe", { requestId: "describe" })).resolves.toBe("safe");
  });
});

describe("host invocation coordination", () => {
  it("independently consumes the reviewed portable coordination laws", async () => {
    const vector = JSON.parse(readFileSync(new URL("../conformance/v1/invocation-coordination.json", import.meta.url), "utf8")) as {
      version: number; cases: Array<{ law: string; admit: boolean; coordinate: string; restricted?: boolean; mode?: "direct" | "request"; resultKind: string; certainty: string; hooks: number; dispatches: number }>;
    };
    expect(vector.version).toBe(1);
    for (const row of vector.cases) {
      let hooks = 0;
      let revoke!: () => boolean;
      const f = await fixture(async (request, proceed) => {
        hooks++;
        switch (row.coordinate) {
          case "proceed": return proceed();
          case "error": throw new Error("host failure");
          case "unknown": return { ...request.policy, certainty: "unknown", result: { kind: "fault", cause: "realization-failed" } };
          case "revoke": await Promise.resolve(); revoke(); return proceed();
          default: return { ...request.policy,
            ...(row.coordinate === "wrong-pins" ? { realizationId: "changed" } : {}),
            certainty: "completed", result: { kind: "returned", value: row.coordinate === "wrong-output" ? 42 : "retained" } };
        }
      }, () => row.admit ? { decision: "allow" } : { decision: "deny", reason: "vector" });
      revoke = f.controller.revoke;
      const projection = projectInteractions(f.compiled, { echo: "direct" });
      const child = restrictBinding(f.binding, { projection, admit: admitAll });
      if (child.status !== "bound") throw new Error("not bound");
      const binding = row.restricted ? child.binding : f.binding;
      const result = await binding.invoke({ interaction: binding.resolve("coordination.echo")!, mode: row.mode ?? "direct", input: "input" }, { requestId: row.law });
      expect(result.result.kind, row.law).toBe(row.resultKind);
      expect(result.certainty, row.law).toBe(row.certainty);
      expect(hooks, row.law).toBe(row.hooks);
      expect(f.dispatched.length, row.law).toBe(row.dispatches);
      expect(f.events.length, row.law).toBe(1);
    }
  });

  it("keeps request coordinator failures unknown through typed and Handoff calls", async () => {
    const f = await fixture(() => { throw new Error("host uncertain"); });
    await expect(f.binding.connect().request(f.projection.handles.echo, "input", { requestId: "typed" })).rejects.toMatchObject({ certainty: "unknown" });
    const invocation = await createHandoffInvocation(f.binding.manifest, "coordination.echo", "request", "input");
    expect((await executeHandoff(f.binding, invocation, { requestId: "handoff" })).certainty).toBe("unknown");
    expect(f.requests).toHaveLength(0);
  });
  it("shares retained host outcomes through typed, raw and Handoff routes, after admission", async () => {
    const retained = new Map<string, { fingerprint: string; outcome: RawInvocationOutcome }>();
    let hooks = 0;
    let admitted = 0;
    const f = await fixture(async (request, proceed) => {
      hooks++;
      const fingerprint = JSON.stringify({ policy: request.policy, input: request.input });
      const previous = retained.get(request.context.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("reused request identity");
        return previous.outcome;
      }
      const outcome = await proceed();
      retained.set(request.context.requestId, { fingerprint, outcome });
      return outcome;
    }, () => { admitted++; return { decision: "allow" }; });
    const context = { requestId: "lost-ack", marker: {} };
    await expect(f.binding.connect().call(f.projection.handles.echo, "once", context)).resolves.toBe("once");
    const resolved = f.binding.resolve("coordination.echo")!;
    expect((await f.binding.connect().callRaw(resolved, "once", context)).certainty).toBe("completed");
    const invocation = await createHandoffInvocation(f.binding.manifest, "coordination.echo", "direct", "once");
    expect((await executeHandoff(f.binding, invocation, context)).certainty).toBe("completed");
    expect(f.dispatched).toEqual([context]);
    expect([hooks, admitted, f.events.length]).toEqual([3, 3, 3]);
    expect((await f.binding.invoke({ interaction: resolved, mode: "direct", input: "changed" }, context)).certainty).toBe("unknown");
    expect(f.dispatched).toHaveLength(1);
    await expect(f.binding.connect().request(f.projection.handles.echo, "preview", { requestId: "request" })).resolves.toBe("preview");
    expect((await f.binding.connect().requestRaw(resolved, "preview", { requestId: "request" })).result.kind).toBe("proposed");
    expect(f.requests).toHaveLength(1);
  });

  it("prevents duplicate dispatch and expires a leaked continuation", async () => {
    let leaked!: () => Promise<RawInvocationOutcome>;
    const f = await fixture(async (_request, proceed) => {
      leaked = proceed;
      const [first, second] = await Promise.all([proceed(), proceed()]);
      expect(second).toBe(first);
      return first;
    });
    await f.binding.connect().call(f.projection.handles.echo, "once", { requestId: "once" });
    await expect(leaked()).rejects.toThrow("expired");
    expect(f.dispatched).toHaveLength(1);
  });

  it("assigns the continuation promise before a native dispatcher can re-enter it", async () => {
    const definitions = { run: defineInteraction({ id: "coordination.reentrant", output: Output }) };
    const compiled = compileInteractions(definitions);
    let proceed!: () => Promise<RawInvocationOutcome>;
    let dispatches = 0;
    let reentered: Promise<RawInvocationOutcome> | undefined;
    const installed = installInteractions(compiled, {
      installationId: "coordination:reentrant",
      bindings: bindNativeInteractions(compiled, { run: null }, { run({ outcomes }) {
        dispatches++;
        if (dispatches === 1) reentered = proceed();
        return outcomes.returned("once");
      } }),
      realizationIds: { run: { direct: "reentrant:run" } },
    });
    const projection = projectInteractions(compiled, { run: "direct" });
    const bound = bindProjection(projection, installed.installation, { admit: admitAll, coordinate(_request, continuation) { proceed = continuation; return proceed(); } });
    if (bound.status !== "bound") throw new Error("not bound");
    expect(await bound.binding.connect().call(projection.handles.run)).toBe("once");
    expect((await reentered)?.certainty).toBe("completed");
    expect(dispatches).toBe(1);
  });

  it("expires a synchronous retained return before queued continuation entry", async () => {
    let late: Promise<unknown> | undefined;
    const f = await fixture((request, proceed) => {
      queueMicrotask(() => { late = proceed().catch(error => error); });
      return { ...request.policy, certainty: "completed", result: { kind: "returned", value: "retained" } };
    });
    expect(await f.binding.connect().call(f.projection.handles.echo, "input", { requestId: "retained" })).toBe("retained");
    expect(await late).toBeInstanceOf(TypeError);
    expect(f.dispatched).toHaveLength(0);
  });

  it("rejects request-only fault causes in direct retained outcomes through every route", async () => {
    const f = await fixture(request => ({ ...request.policy, certainty: "not-started", result: { kind: "fault", cause: "request-failed" } }));
    const outcome = await f.binding.connect().callRaw(f.binding.resolve("coordination.echo")!, "input", { requestId: "raw" });
    expect(outcome.certainty).toBe("unknown");
    await expect(f.binding.connect().call(f.projection.handles.echo, "input", { requestId: "typed" })).rejects.toMatchObject({ certainty: "unknown" });
    const invocation = await createHandoffInvocation(f.binding.manifest, "coordination.echo", "direct", "input");
    expect((await executeHandoff(f.binding, invocation, { requestId: "handoff" })).certainty).toBe("unknown");
    expect(f.dispatched).toHaveLength(0);
  });

  it("rechecks parent and installation revocation after queueing", async () => {
    for (const target of ["parent", "installation"] as const) {
      let resume!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>(resolve => { resume = resolve; });
      const queued = new Promise<void>(resolve => { entered = resolve; });
      const f = await fixture(async (_request, proceed) => { entered(); await pending; return proceed(); });
      const projection = projectInteractions(f.compiled, { echo: "direct" });
      const child = restrictBinding(f.binding, { projection, admit: admitAll });
      if (child.status !== "bound") throw new Error("not bound");
      const call = child.binding.connect().call(projection.handles.echo, "never", { requestId: target });
      await queued;
      (target === "parent" ? f.controller : f.installed.controller).revoke();
      resume();
      await expect(call).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
      expect(f.dispatched).toHaveLength(0);
    }
  });

  it("validates input before coordination and retained disclosures after current admission", async () => {
    let hooks = 0;
    const f = await fixture(async (_request, proceed) => { hooks++; return proceed(); }, () => ({ decision: "deny", reason: "current policy" }));
    const resolved = f.binding.resolve("coordination.echo")!;
    expect((await f.binding.connect().callRaw(resolved, 42, { requestId: "invalid" })).result).toEqual({ kind: "fault", cause: "invalid-input" });
    expect((await f.binding.connect().callRaw(resolved, "no", { requestId: "denied" })).result.kind).toBe("denied");
    expect([hooks, f.dispatched.length]).toEqual([0, 0]);
  });
});
