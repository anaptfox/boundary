import { describe, expect, it } from "vitest";
import {
  admitAll, bindProjection, compileInteractions, defineInteraction,
  implementInteractions, installInteractions, projectAllDirect,
  projectInteractions, restrictBinding,
} from "@foxworth/boundary";
import { createInvocationState, createProjectionClient } from "@foxworth/boundary/client";
import { createProtocolHandler, fetchTransport } from "@foxworth/boundary/http/protocol";
import {
  observedRead, type ObservationSource, type ObservedReadDiagnostic,
} from "@foxworth/boundary/observations";
import { portableSchema } from "@foxworth/boundary/program";

const Input = portableSchema<string>({ type: "string" });
const Output = portableSchema<string>({ type: "string" });
type Context = { actorId: string };
const context: Context = { actorId: "owner" };

describe("integration with main's contract and invocation laws", () => {
  it("restricts a compatible unequal contract without replacing expected or actual pins, and checks admission before observed reuse", async () => {
    const expected = {
      read: defineInteraction({ id: "integration.read", input: Input,
        output: portableSchema<string | null>({ anyOf: [{ type: "string" }, { type: "null" }] }),
        reads: ["documents"], changes: [] }),
    };
    const actual = {
      read: defineInteraction({ id: "integration.read", input: Input,
        output: Output, reads: ["documents"], changes: [] }),
    };
    const expectedCompiled = compileInteractions(expected);
    const actualCompiled = compileInteractions(actual);
    const parentProjection = projectAllDirect(expectedCompiled);
    const childProjection = projectInteractions(expectedCompiled, {
      lookup: { interaction: expectedCompiled.handles.read, modes: ["direct"] },
    });
    const actualProjection = projectAllDirect(actualCompiled);
    let value = "first";
    let evaluations = 0;
    let authorizations = 0;
    let allowed = true;
    const admissions: string[] = [];
    const diagnostics: ObservedReadDiagnostic[] = [];
    const snapshots: ObservationSource<Context, string, string, string, string> = {
      async withSnapshot(_context, _scope, run) {
        const captured = value;
        return run({
          read: () => ({ kind: "present", value: captured, token: captured }),
          query() { throw new Error("this host does not expose queries"); },
          validate: observation => observation.token === captured ? "matching" : "changed",
        });
      },
    };
    const { installation } = installInteractions<typeof actual, Context>(actualCompiled, {
      installationId: "integration:observed",
      realizationIds: { read: { direct: "integration:observed:read" } },
      implementations: implementInteractions<typeof actual, Context>(actual, {
        read: observedRead(actual.read, {
          snapshots, scope: ctx => ({ actorId: ctx.actorId }), reuse: "validated",
          authorize() { authorizations++; },
          async evaluate(input, view) {
            evaluations++;
            const point = await view.read(input);
            if (point.kind === "absent") throw new Error("document disappeared");
            return point.value;
          },
          diagnostic: event => { diagnostics.push(event); },
        }),
      }),
    });
    const parent = bindProjection(parentProjection, installation, {
      admit() {
        admissions.push("parent");
        return allowed ? { decision: "allow" } : { decision: "deny", reason: "host policy changed" };
      },
    });
    expect(parent.status).toBe("bound");
    if (parent.status !== "bound") throw new Error("compatible contract did not bind");
    const child = restrictBinding(parent.binding, {
      projection: childProjection,
      admit() { admissions.push("child"); return { decision: "allow" }; },
    });
    expect(child.status).toBe("bound");
    if (child.status !== "bound") throw new Error("expected contract did not restrict");
    expect(expectedCompiled.handles.read.contractDigest).not.toBe(actualCompiled.handles.read.contractDigest);
    expect(child.binding.manifest.interactions).toEqual([
      { ...parent.binding.manifest.interactions[0], alias: "lookup" },
    ]);
    expect(child.binding.manifest).toMatchObject({
      installationDigest: parent.binding.manifest.installationDigest,
      expectedProgramDigest: expectedCompiled.program.programDigest,
      actualProgramDigest: actualCompiled.program.programDigest,
    });
    expect(child.binding.manifest.interactions[0]).toMatchObject({
      expectedContractDigest: expectedCompiled.handles.read.contractDigest,
      actualContractDigest: actualCompiled.handles.read.contractDigest,
      realizationId: "integration:observed:read",
    });
    expect(restrictBinding(parent.binding, { projection: actualProjection, admit: admitAll }))
      .toMatchObject({ status: "unrealized", report: { issues: [{ reason: "contract-not-selected" }] } });
    const caller = child.binding.connect();
    await expect(caller.call(childProjection.handles.lookup, "document", context)).resolves.toBe("first");
    await expect(caller.call(childProjection.handles.lookup, "document", context)).resolves.toBe("first");
    expect(evaluations).toBe(1);
    expect(authorizations).toBe(2);
    expect(diagnostics.map(event => event.reason)).toEqual(["miss", "matching"]);
    expect(admissions).toEqual(["parent", "child", "parent", "child"]);
    allowed = false;
    await expect(caller.call(childProjection.handles.lookup, "document", context))
      .rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    expect(evaluations).toBe(1);
    expect(authorizations).toBe(2);
    expect(admissions.at(-1)).toBe("parent");
    allowed = true;
    value = "updated";
    await expect(caller.call(childProjection.handles.lookup, "document", context)).resolves.toBe("updated");
    expect(evaluations).toBe(2);
    expect(authorizations).toBe(3);
    expect(diagnostics.at(-1)?.reason).toBe("changed");
    parent.controller.revoke();
    await expect(caller.call(childProjection.handles.lookup, "document", context))
      .rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    expect(evaluations).toBe(2);
    expect(authorizations).toBe(3);
  });

  for (const action of ["disconnect", "dispose"] as const) {
    for (const outcome of ["returned", "unknown"] as const) {
      it(`keeps a started ${outcome} outcome after parent revocation and view ${action} through the real protocol`, async () => {
        let signalStarted!: () => void;
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        let finish!: (value: string) => void;
        let fail!: (error: Error) => void;
        const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
        let dispatches = 0;
        const admissions: string[] = [];
        const definitions = {
          save: defineInteraction({ id: "integration.save", input: Input,
            output: Output, changes: ["documents"] }),
        };
        const compiled = compileInteractions(definitions);
        const parentProjection = projectAllDirect(compiled);
        const childProjection = projectInteractions(compiled, {
          write: { interaction: compiled.handles.save, modes: ["direct"] },
        });
        const { installation } = installInteractions<typeof definitions, Context>(compiled, {
          installationId: `integration:deferred:${action}:${outcome}`,
          realizationIds: { save: { direct: "integration:deferred:save" } },
          implementations: implementInteractions<typeof definitions, Context>(definitions, {
            save() { dispatches++; signalStarted(); return pending; },
          }),
        });
        const parent = bindProjection(parentProjection, installation, {
          admit() { admissions.push("parent"); return { decision: "allow" }; },
        });
        if (parent.status !== "bound") throw new Error("parent did not bind");
        const child = restrictBinding(parent.binding, {
          projection: childProjection,
          admit() { admissions.push("child"); return { decision: "allow" }; },
        });
        if (child.status !== "bound") throw new Error("child did not bind");
        const protocol = createProtocolHandler({ binding: child.binding, context: () => context, path: "/_boundary" });
        const client = createProjectionClient(fetchTransport({
          baseUrl: "https://example.test/_boundary",
          fetch: (input, init) => protocol(new Request(input, init)),
        }));
        const view = createInvocationState(client, childProjection.handles.write, "direct");
        const invoking = view.invoke("save once");
        // Attach both handlers before settling the deferred implementation.
        const settled = invoking.then(value => ({ value }), error => ({ error }));
        await started;
        parent.controller.revoke();
        view[action]();
        const availability = action === "disconnect" ? "disconnected" : "disposed";
        expect(view.getSnapshot()).toMatchObject({ phase: "pending", availability, isPending: true });
        await expect(view.invoke("view cannot dispatch")).rejects.toThrow(availability);
        await expect(client.call(childProjection.handles.write, "revoked host cannot dispatch"))
          .rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
        expect(dispatches).toBe(1);
        expect(admissions).toEqual(["parent", "child"]);
        if (outcome === "returned") {
          finish("saved");
          expect(await settled).toEqual({ value: "saved" });
          expect(view.getSnapshot()).toMatchObject({ phase: "succeeded", availability, result: "saved", isPending: false });
        } else {
          fail(new Error("effect may have started before the host lost its evidence"));
          expect(await settled).toMatchObject({ error: { cause: "realization-failed", certainty: "unknown" } });
          expect(view.getSnapshot()).toMatchObject({ phase: "uncertain", availability,
            error: { cause: "realization-failed", certainty: "unknown" }, isPending: false });
        }
        view[action]();
        expect(view.getSnapshot().phase).toBe(outcome === "returned" ? "succeeded" : "uncertain");
        await expect(view.invoke("still unavailable")).rejects.toThrow(availability);
        expect(dispatches).toBe(1);
      });
    }
  }
});
