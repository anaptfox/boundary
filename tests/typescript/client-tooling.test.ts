import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
  type ProjectionBindingManifest,
} from "@foxworth/boundary";
import {
  createProjectionClient,
  handlesFromBinding,
  pinProjectionReferences,
} from "@foxworth/boundary/client";
import { createCheckedHandoff } from "@foxworth/boundary/handoff";
import { portableSchema } from "@foxworth/boundary/program";

async function fixture() {
  let executions = 0;
  const interactions = {
    ping: defineInteraction({
      id: "client-tooling.ping",
      output: portableSchema<Readonly<{ ok: true }>>({
        type: "object",
        properties: { ok: { const: true } },
        required: ["ok"],
        additionalProperties: false,
      }),
    }),
  };
  const compiled = compileInteractions(interactions);
  const implementations = implementInteractions(interactions, {
    ping() {
      executions += 1;
      return { ok: true as const };
    },
  });
  const { installation } = installInteractions(compiled, {
    installationId: "installation:client-tooling:1",
    implementations,
    realizationIds: { ping: { direct: "realization:client-tooling:1" } },
  });
  const projection = projectInteractions(compiled, {
    ["__proto__"]: { interaction: compiled.handles.ping, modes: ["direct"] },
  });
  const bound = bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }),
  });
  if (bound.status !== "bound") throw new Error("fixture did not bind");
  const handoff = await createCheckedHandoff(bound.binding);
  return { handoff, projection, get executions() { return executions; } };
}

describe("caller tooling boundaries", () => {
  it("owns a failed eager handshake until a caller awaits it, without retrying", async () => {
    const cause = { reason: "host is offline", diagnostic: "local-only handshake detail" };
    const inspect = vi.fn(async () => { throw cause; });
    const invoke = vi.fn(async () => { throw new Error("must not invoke"); });
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", observe);
    try {
      const client = createProjectionClient({ inspect, invoke });
      await setImmediate();
      await setImmediate();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      const failure = await client.inspect().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "TRANSPORT_FAILURE", path: "transport.inspect", cause,
      });
      expect(JSON.stringify(failure)).not.toContain(cause.diagnostic);
      await expect(client.callRaw("client-tooling.ping")).rejects.toMatchObject({ cause });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", observe);
    }
  });

  it("retains the manifest validation diagnostic behind a failed handshake", async () => {
    const app = await fixture();
    const bindingDigest: ProjectionBindingManifest["bindingDigest"] = `sha256:${"0".repeat(64)}`;
    const client = createProjectionClient({
      inspect: async () => ({ ...app.handoff.manifest, bindingDigest }),
      invoke: (invocation) => app.handoff.invoke(invocation, undefined),
    });
    await expect(client.inspect()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      cause: { name: "HandoffError", code: "INVALID_MANIFEST", path: "manifest.bindingDigest" },
    });
    expect(app.executions).toBe(0);
  });

  it("keeps a lost outcome unknown with its local cause and never replays the effect", async () => {
    const app = await fixture();
    const cause = { reason: "connection closed after dispatch", diagnostic: "local-only invocation detail" };
    const invoke = vi.fn(async (invocation: Parameters<typeof app.handoff.invoke>[0]) => {
      await app.handoff.invoke(invocation, undefined);
      throw cause;
    });
    const client = createProjectionClient({
      inspect: async () => app.handoff.manifest,
      invoke,
    });
    const failure = await client.call(app.projection.handles["__proto__"]).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "REMOTE_INVOCATION_FAILED", certainty: "unknown", phase: "transport", cause,
    });
    expect(JSON.stringify(failure)).not.toContain(cause.diagnostic);
    await client.inspect();
    expect(app.executions).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps rejected response pins unknown while retaining the mismatched field", async () => {
    const app = await fixture();
    const client = createProjectionClient({
      inspect: async () => app.handoff.manifest,
      invoke: async (invocation) => ({
        ...await app.handoff.invoke(invocation, undefined),
        realizationId: "realization:other",
      }),
    });
    await expect(client.call(app.projection.handles["__proto__"])).rejects.toMatchObject({
      code: "REMOTE_INVOCATION_FAILED", certainty: "unknown", phase: "response",
      cause: { name: "HandoffError", code: "STALE_REALIZATION", path: "outcome.realizationId" },
    });
    expect(app.executions).toBe(1);
  });

  it("hydrates and checks __proto__ as an enumerable own alias", async () => {
    const app = await fixture();
    const client = createProjectionClient({
      inspect: async () => app.handoff.manifest,
      invoke: (invocation) => app.handoff.invoke(invocation, undefined),
    });
    const handles = await handlesFromBinding(client);
    expect(Object.keys(handles)).toEqual(["__proto__"]);
    expect(Object.hasOwn(handles, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(handles)).toBe(Object.prototype);
    expect(handles["__proto__"]).toEqual(app.projection.handles["__proto__"]);
    await expect(pinProjectionReferences(client, handles)).resolves.toBe(handles);
    const contractDigest: ProjectionBindingManifest["bindingDigest"] = `sha256:${"0".repeat(64)}`;
    await expect(pinProjectionReferences(client, {
      ["__proto__"]: { ...handles["__proto__"], contractDigest },
    })).rejects.toMatchObject({ code: "STALE_REFERENCE", path: "__proto__" });
    await expect(client.callRaw("client-tooling.ping")).resolves.toEqual({ ok: true });
    expect(app.executions).toBe(1);
  });
});
