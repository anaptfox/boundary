import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  admitAll, bindProjection, compileInteractions, defineInteraction,
  implementInteractions, installInteractions, pickProjection, projectInteractions,
  restrictBinding, type Admission, type AdmissionRequest,
} from "@foxworth/boundary";
import { portableSchema, type InvocationObservation } from "@foxworth/boundary/program";
import { createControlRequestContributions } from "../../packages/core/host/control";

const Input = portableSchema<{ readonly value: string }>({
  type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
});
const Output = portableSchema<string>({ type: "string" });
type Context = { marker: object };
const law = JSON.parse(readFileSync(new URL("../conformance/v1/binding-restriction.json", import.meta.url), "utf8")) as {
  version: number;
  admission: Array<{ name: string; parent: "allow" | "deny"; additional: "allow" | "deny"; calls: string[]; dispatches: number }>;
  subset: Array<{ name: string; difference: "none" | "alias" | "empty" | "interaction" | "contract" | "mode"; status: string; reason?: string }>;
  revocation: { revokedParentRefusesEmptySelection: boolean; revokedInstallationRefusesEmptySelection: boolean };
};

async function fixture(admit: Admission<Context> = admitAll, events?: InvocationObservation[]) {
  const interactions = {
    get: defineInteraction({ id: "restriction.get", input: Input, output: Output, reads: ["documents"] }),
    save: defineInteraction({ id: "restriction.save", input: Input, output: Output, changes: ["documents"] }),
  } as const;
  const compiled = await compileInteractions(interactions);
  const dispatched: Array<{ input: unknown; context: Context }> = [];
  const { installation, controller: installationController } = await installInteractions<typeof interactions, Context>(compiled, {
    installationId: "restriction:installation",
    implementations: implementInteractions<typeof interactions, Context>(interactions, {
      get(input, context) { dispatched.push({ input, context }); return input.value; },
      save(input, context) { dispatched.push({ input, context }); return input.value; },
    }),
    requests: createControlRequestContributions<typeof interactions, Context>(compiled, {
      get: { interaction: compiled.handles.get, controlDigest: compiled.handles.get.contractDigest, previewSchema: Output, request(input) { return input.value; } },
    }),
    realizationIds: { get: { direct: "restriction:get:direct", request: "restriction:get:request" }, save: { direct: "restriction:save" } },
  });
  const projection = await projectInteractions(compiled, {
    get: { interaction: compiled.handles.get, modes: ["direct", "request"] },
    save: { interaction: compiled.handles.save, modes: ["direct"] },
  });
  const result = await bindProjection(projection, installation, {
    admit,
    ...(events === undefined ? {} : { observation: { publish(event: InvocationObservation) { events.push(event); }, correlate(context: Context) { return { marker: context.marker === context.marker }; } } }),
  });
  if (result.status !== "bound") throw new Error("fixture did not bind");
  return { ...result, compiled, projection, installation, installationController, dispatched };
}

function assertBound<T extends { status: string }>(result: T): asserts result is Extract<T, { status: "bound" }> {
  expect(result.status).toBe("bound");
  if (result.status !== "bound") throw new Error("expected bound");
}

describe("Binding restriction", () => {
  it("independently consumes the reviewed admission and subset laws", async () => {
    expect(law.version).toBe(1);
    for (const row of law.admission) {
      const calls: string[] = [];
      const parent = await fixture(() => { calls.push("parent"); return row.parent === "allow" ? { decision: "allow" } : { decision: "deny", reason: "vector" }; });
      const child = await restrictBinding(parent.binding, { projection: parent.projection, admit() { calls.push("additional"); return row.additional === "allow" ? { decision: "allow" } : { decision: "deny", reason: "vector" }; } });
      assertBound(child);
      const outcome = await child.binding.connect().callRaw(child.binding.resolve("restriction.get")!, { value: "vector" }, { marker: {} });
      expect(calls, row.name).toEqual(row.calls);
      expect(parent.dispatched.length, row.name).toBe(row.dispatches);
      expect(outcome.certainty, row.name).toBe(row.dispatches === 1 ? "completed" : "not-started");
    }
    for (const row of law.subset) {
      const source = await fixture();
      const direct = await projectInteractions(source.compiled, { get: { interaction: source.compiled.handles.get, modes: ["direct"] } });
      const parent = await restrictBinding(source.binding, { projection: direct, admit: admitAll });
      assertBound(parent);
      const changed = await compileInteractions({ get: defineInteraction({ id: "restriction.get", input: Input, output: Output, reads: ["other"] }) });
      const candidates = {
        none: direct,
        alias: await projectInteractions(source.compiled, { renamed: { interaction: source.compiled.handles.get, modes: ["direct"] } }),
        empty: await projectInteractions(source.compiled, {}),
        interaction: await projectInteractions(source.compiled, { save: { interaction: source.compiled.handles.save, modes: ["direct"] } }),
        contract: await projectInteractions(changed, { get: { interaction: changed.handles.get, modes: ["direct"] } }),
        mode: await projectInteractions(source.compiled, { get: { interaction: source.compiled.handles.get, modes: ["request"] } }),
      };
      const child = await restrictBinding(parent.binding, { projection: candidates[row.difference], admit: admitAll });
      expect(child.status, row.name).toBe(row.status);
      if (child.status === "unrealized") {
        expect(child.report.issues.map(issue => issue.reason), row.name).toEqual([row.reason]);
      } else if (row.difference === "none") {
        expect(child.binding.manifest.bindingDigest).toBe(parent.binding.manifest.bindingDigest);
      }
    }
  });
  it("retains exact pins, fresh inherited admission, and one child observation", async () => {
    const seen: Array<[string, AdmissionRequest<Context>]> = [];
    const events: InvocationObservation[] = [];
    const parent = await fixture(request => { seen.push(["parent", request]); return { decision: "allow" }; }, events);
    const reads = await projectInteractions(parent.compiled, { read: { interaction: parent.compiled.handles.get, modes: ["direct"] } });
    const child = await restrictBinding(parent.binding, { projection: reads, admit(request) { seen.push(["child", request]); return { decision: "allow" }; } });
    assertBound(child);
    const context: Context = { marker: {} };
    await expect(child.binding.connect().call(reads.handles.read, { value: "one" }, context)).resolves.toBe("one");
    await expect(child.binding.connect().call(reads.handles.read, { value: "two" }, context)).resolves.toBe("two");
    expect(seen.map(([name]) => name)).toEqual(["parent", "child", "parent", "child"]);
    expect(seen[0]![1].input).toBe(seen[1]![1].input);
    expect(seen[0]![1].context).toBe(context);
    expect(parent.dispatched[0]!.context).toBe(context);
    expect(parent.dispatched[0]!.input).toBe(seen[0]![1].input);
    expect(child.binding.manifest.interactions[0]).toEqual({ ...parent.binding.manifest.interactions.find(entry => entry.mode === "direct" && entry.interactionId === "restriction.get"), alias: "read" });
    expect(child.binding.manifest.installationDigest).toBe(parent.binding.manifest.installationDigest);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ bindingDigest: child.binding.manifest.bindingDigest, projectionDigest: reads.projectionDigest, realizationId: "restriction:get:direct", certainty: "completed", resultKind: "returned" });
    const sameSurface = await restrictBinding(parent.binding, { projection: parent.projection, admit: admitAll });
    assertBound(sameSurface);
    expect(sameSurface.binding.manifest.bindingDigest).toBe(parent.binding.manifest.bindingDigest);
  });

  it("short circuits parent denial and evaluates nested admissions oldest first", async () => {
    let denied = false;
    const seen: string[] = [];
    const parent = await fixture(() => { seen.push("parent"); return denied ? { decision: "deny", reason: "host policy" } : { decision: "allow" }; });
    const reads = await pickProjection(parent.projection, "get");
    const child = await restrictBinding(parent.binding, { projection: reads, admit() { seen.push("child"); return { decision: "allow" }; } });
    assertBound(child);
    const grandchild = await restrictBinding(child.binding, { projection: reads, admit() { seen.push("grandchild"); return { decision: "allow" }; } });
    assertBound(grandchild);
    const caller = grandchild.binding.connect();
    await caller.call(reads.handles.get, { value: "allowed" }, { marker: {} });
    expect(seen).toEqual(["parent", "child", "grandchild"]);
    denied = true;
    await expect(caller.call(reads.handles.get, { value: "denied" }, { marker: {} })).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    expect(seen).toEqual(["parent", "child", "grandchild", "parent"]);
    expect(parent.dispatched).toHaveLength(1);
  });

  it("rejects all widened selections even if the installation offers them", async () => {
    const parent = await fixture();
    const direct = await projectInteractions(parent.compiled, { get: { interaction: parent.compiled.handles.get, modes: ["direct"] } });
    const narrow = await restrictBinding(parent.binding, { projection: direct, admit: admitAll });
    assertBound(narrow);
    const widened = await restrictBinding(narrow.binding, { projection: parent.projection, admit: admitAll });
    expect(widened).not.toHaveProperty("binding");
    expect(widened).toMatchObject({ status: "unrealized", report: { issues: [
      { alias: "get", mode: "request", reason: "mode-not-selected" },
      { alias: "save", reason: "interaction-not-selected" },
    ] } });
    const changed = await compileInteractions({ get: defineInteraction({ id: "restriction.get", input: Input, output: Output, reads: ["other"] }) });
    const changedProjection = await projectInteractions(changed, { get: { interaction: changed.handles.get, modes: ["direct"] } });
    expect(await restrictBinding(narrow.binding, { projection: changedProjection, admit: admitAll })).toMatchObject({ status: "unrealized", report: { issues: [{ reason: "contract-not-selected" }] } });
    const changedArity = await compileInteractions({ get: defineInteraction({ id: "restriction.get", output: Output, reads: ["documents"] }) });
    const changedArityProjection = await projectInteractions(changedArity, { get: { interaction: changedArity.handles.get, modes: ["direct"] } });
    expect(await restrictBinding(narrow.binding, { projection: changedArityProjection, admit: admitAll })).toMatchObject({ status: "unrealized", report: { issues: [{ reason: "contract-not-selected" }, { reason: "arity-not-selected" }] } });
  });

  it("child revocation leaves its parent and siblings live; parent revocation reaches descendants", async () => {
    const parent = await fixture();
    const reads = await pickProjection(parent.projection, "get");
    const child = await restrictBinding(parent.binding, { projection: reads, admit: admitAll });
    const sibling = await restrictBinding(parent.binding, { projection: reads, admit: admitAll });
    assertBound(child); assertBound(sibling);
    const descendant = await restrictBinding(child.binding, { projection: reads, admit: admitAll });
    assertBound(descendant);
    expect(child.controller.revoke()).toBe(true);
    expect(child.controller.revoke()).toBe(false);
    await expect(descendant.binding.connect().call(reads.handles.get, { value: "no" }, { marker: {} })).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    await sibling.binding.connect().call(reads.handles.get, { value: "yes" }, { marker: {} });
    await parent.binding.connect().call(parent.projection.handles.get, { value: "yes" }, { marker: {} });
    parent.controller.revoke();
    await expect(sibling.binding.connect().call(reads.handles.get, { value: "no" }, { marker: {} })).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    expect(await restrictBinding(parent.binding, { projection: reads, admit: admitAll })).toMatchObject({ status: "unrealized", report: { issues: [{ reason: "binding-revoked" }] } });
    expect(parent.dispatched).toHaveLength(2);
  });

  it.each([
    ["parent", "parent"], ["parent", "child"],
    ["installation", "parent"], ["installation", "child"],
  ] as const)("rechecks %s revocation after awaited %s admission before dispatch", async (revoked, awaiting) => {
    let resume!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const suspended = new Promise<void>(resolve => { resume = resolve; });
    const pause: Admission<Context> = async () => { started(); await suspended; return { decision: "allow" }; };
    const parent = await fixture(awaiting === "parent" ? pause : admitAll);
    const reads = await pickProjection(parent.projection, "get");
    const child = await restrictBinding(parent.binding, { projection: reads, admit: awaiting === "child" ? pause : admitAll });
    assertBound(child);
    const pending = child.binding.connect().call(reads.handles.get, { value: "never" }, { marker: {} });
    await entered;
    (revoked === "parent" ? parent.controller : parent.installationController).revoke();
    resume();
    await expect(pending).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    expect(parent.dispatched).toHaveLength(0);
  });

  it("supports request-only narrowing and rejects calls outside the child's modes", async () => {
    const parent = await fixture();
    const requests = await projectInteractions(parent.compiled, { get: { interaction: parent.compiled.handles.get, modes: ["request"] } });
    const child = await restrictBinding(parent.binding, { projection: requests, admit: admitAll });
    assertBound(child);
    await expect(child.binding.connect().request(requests.handles.get, { value: "preview" }, { marker: {} })).resolves.toBe("preview");
    expect(await child.binding.invoke({ interaction: child.binding.resolve("restriction.get")!, mode: "request", input: { value: "preview" } }, { marker: {} })).toMatchObject({ certainty: "not-started", result: { kind: "proposed" } });
    // oxlint-disable-next-line no-constant-condition -- compile-only @ts-expect-error assertions
    if (false) {
      // @ts-expect-error request-only handles cannot authorize direct calls
      await child.binding.connect().call(requests.handles.get, { value: "no" }, { marker: {} });
      // @ts-expect-error exact Context type is retained through restriction
      await child.binding.connect().request(requests.handles.get, { value: "no" }, { wrong: true });
    }
    expect(parent.dispatched).toHaveLength(0);
  });

  it("rejects forged bindings, foreign resolved handles, and revoked installation restriction", async () => {
    const parent = await fixture();
    const reads = await pickProjection(parent.projection, "get");
    const child = await restrictBinding(parent.binding, { projection: reads, admit: admitAll });
    assertBound(child);
    await expect(restrictBinding({ ...parent.binding }, { projection: reads, admit: admitAll })).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    await expect(child.binding.connect().callRaw(parent.binding.resolve("restriction.get")!, { value: "never" }, { marker: {} })).rejects.toMatchObject({ cause: "invalid-invocation", certainty: "not-started" });
    parent.installationController.revoke();
    expect(await restrictBinding(parent.binding, { projection: reads, admit: admitAll })).toMatchObject({ status: "unrealized", report: { issues: [{ reason: "installation-revoked" }] } });
    expect(parent.dispatched).toHaveLength(0);
  });

  it.each(["parent", "installation"] as const)("refuses an empty restriction of a revoked %s", async target => {
    const parent = await fixture();
    const empty = await projectInteractions(parent.compiled, {});
    (target === "parent" ? parent.controller : parent.installationController).revoke();
    const child = await restrictBinding(parent.binding, { projection: empty, admit: admitAll });
    expect(child.status === "unrealized").toBe(target === "parent"
      ? law.revocation.revokedParentRefusesEmptySelection
      : law.revocation.revokedInstallationRefusesEmptySelection);
    expect(child).toMatchObject({ status: "unrealized", report: { projection: empty.manifest, issues: [] } });
    expect(child).not.toHaveProperty("binding");
  });

  it("rechecks parent liveness after asynchronous empty Binding construction", async () => {
    const parent = await fixture();
    const empty = await projectInteractions(parent.compiled, {});
    const pending = restrictBinding(parent.binding, { projection: empty, admit: admitAll });
    parent.controller.revoke();
    expect(await pending).toMatchObject({ status: "unrealized", report: { issues: [] } });
  });

  it("root construction also refuses an empty surface on a revoked Installation", async () => {
    const parent = await fixture();
    const empty = await projectInteractions(parent.compiled, {});
    parent.installationController.revoke();
    expect(await bindProjection(empty, parent.installation, { admit: admitAll }))
      .toMatchObject({ status: "unrealized", report: { issues: [] } });
  });

  it("root construction rechecks installation liveness after hashing", async () => {
    const parent = await fixture();
    const empty = await projectInteractions(parent.compiled, {});
    const pending = bindProjection(empty, parent.installation, { admit: admitAll });
    parent.installationController.revoke();
    expect(await pending).toMatchObject({ status: "unrealized", report: { issues: [] } });
  });
});
