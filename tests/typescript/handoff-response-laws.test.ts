import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHandoffInvocation, executeHandoff, validateHandoffInvocation, validateHandoffOutcome, validateHandoffResponse, validateBindingManifest } from "@foxworth/boundary/handoff";
import { RemoteDomainError, snapshotSurfaceHandle } from "@foxworth/boundary/remote";
import { createSurfaceClient } from "@foxworth/boundary/client";
import type { ClientTransport } from "@foxworth/boundary/client";
import { registerWebMcpTransport, webMcpTool, type ModelContextTool } from "@foxworth/boundary/webmcp";
import { createAdapterFixture } from "./helpers/adapter";

async function fixture() {
  const host = await createAdapterFixture();
  const { caller, binding, projection } = await host.connect({ call: ["create", "list"], propose: ["create"] });
  return { ...host, caller, binding, projection };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Driver = (f: Fixture, transport: ClientTransport, title: string) => Promise<unknown>;
function transportLaws(name: string, drive: Driver) {
  describe(name, () => {
    for (const fault of ["sibling", "mode", "pins", "output", "lost"] as const) {
      it(`keeps ${fault} response unknown and sends exactly once`, async () => {
        const f = await fixture();
        let calls = 0;
        const transport: ClientTransport = {
          inspect: async () => f.binding.manifest,
          invoke: async (invocation) => {
            calls++;
            const actual = await executeHandoff(f.binding, invocation, { role: "owner" });
            if (fault === "lost") throw new Error("acknowledgment lost");
            if (fault === "sibling" || fault === "mode") {
              const other = await createHandoffInvocation(f.binding.manifest,
                fault === "sibling" ? "todos.list" : "todos.create",
                fault === "sibling" ? "direct" : "request",
                fault === "sibling" ? null : { title: "other" });
              return executeHandoff(f.binding, other, { role: "owner" });
            }
            if (fault === "pins") return { ...actual, realizationId: "realization:wrong:1" };
            return { ...actual, result: { kind: "returned", value: 42 } };
          },
        };
        await expect(drive(f, transport, "once")).resolves.toMatchObject({ certainty: "unknown" });
        expect(calls).toBe(1);
        expect(f.rows).toHaveLength(1);
      });
    }
    for (const scenario of ["returned", "declared-error", "denied"] as const) {
      it(`preserves ${scenario}`, async () => {
        const f = await fixture();
        let calls = 0;
        const transport: ClientTransport = {
          inspect: async () => f.binding.manifest,
          invoke: async invocation => {
            calls++;
            return executeHandoff(f.binding, invocation, { role: scenario === "denied" ? "viewer" : "owner" });
          },
        };
        const result = await drive(f, transport, scenario === "declared-error" ? "duplicate" : "ok");
        if (scenario === "returned") expect(result).toMatchObject({ id: 1, title: "ok" });
        else expect(result).toMatchObject({ certainty: scenario === "denied" ? "not-started" : "completed" });
        expect(calls).toBe(1);
      });
    }
  });
}

transportLaws("SurfaceClient transport laws", async (f, transport, title) => {
  try { return await createSurfaceClient(transport).call(f.projection.handles.create, { title }); }
  catch (error) { return error instanceof RemoteDomainError ? { certainty: "completed", result: error.value } : error; }
});
transportLaws("WebMCP transport laws", async (f, transport, title) => {
  let tool: ModelContextTool | undefined;
  const registration = await registerWebMcpTransport({ transport,
    tools: [webMcpTool(f.caller, "create", { mode: "call" })],
    modelContext: { async registerTool(value) { tool = value; } },
  });
  try {
    const outcome = validateHandoffOutcome((await tool!.execute({ title }) as { structuredContent: unknown }).structuredContent);
    return outcome.result.kind === "returned" ? outcome.result.value : outcome;
  } finally { registration.dispose(); }
});

describe("owned boundary snapshots", () => {
  it("revalidates a reused manifest, nested mutations and accessors", async () => {
    const f = await fixture();
    for (const mutate of [
      (raw: any) => { raw.bindingDigest = `sha256:${"0".repeat(64)}`; },
      (raw: any) => { raw.interactions[0].realizationId = "realization:changed:1"; },
      (raw: any) => { Object.defineProperty(raw, "bindingDigest", { get() { throw new Error("accessed"); } }); },
    ]) {
      const raw = structuredClone(f.binding.manifest);
      const owned = await validateBindingManifest(raw);
      expect(owned).not.toBe(raw);
      expect(Object.isFrozen(owned.interactions[0])).toBe(true);
      mutate(raw);
      await expect(validateBindingManifest(raw)).rejects.toThrow();
      expect(await validateBindingManifest(owned)).toBe(owned);
    }
  });
  it("revalidates mutable invocation input and snapshots handle modes", async () => {
    const f = await fixture();
    const invocation = await createHandoffInvocation(f.binding.manifest, "todos.create", "direct", { title: "ok" });
    const raw = structuredClone(invocation);
    const owned = validateHandoffInvocation(raw);
    (raw.input as { title: unknown }).title = undefined;
    expect(() => validateHandoffInvocation(raw)).toThrow();
    expect(validateHandoffInvocation(owned)).toBe(owned);
    const handle = structuredClone(f.projection.handles.create);
    const snapshot = snapshotSurfaceHandle(handle);
    (handle.modes as unknown as string[]).push("invalid");
    expect(() => snapshotSurfaceHandle(handle)).toThrow();
    expect(snapshotSurfaceHandle(snapshot)).toBe(snapshot);
    expect(Object.isFrozen(snapshot.modes)).toBe(true);
  });
});

const responseLaws = JSON.parse(readFileSync(new URL("../conformance/v1/handoff-response.json", import.meta.url), "utf8")) as { cases: Array<{ field: string; replacement: string }> };
describe("reviewed cross-language response pins", () => {
  for (const { field, replacement } of responseLaws.cases) {
    it(`rejects mismatched ${field}`, async () => {
      const f = await fixture();
      const invocation = await createHandoffInvocation(f.binding.manifest, "todos.create", "direct", { title: "ok" });
      const outcome = await executeHandoff(f.binding, invocation, { role: "owner" });
      await expect(validateHandoffResponse(f.binding.manifest, invocation, { ...outcome, [field]: replacement })).rejects.toThrow();
    });
  }
});

it("keeps a lost WebMCP request response unknown without fabricating a request fault", async () => {
  const f = await fixture();
  let tool: ModelContextTool | undefined;
  let calls = 0;
  const registration = await registerWebMcpTransport({
    tools: [webMcpTool(f.caller, "create", { mode: "propose" })],
    modelContext: { async registerTool(value) { tool = value; } },
    transport: {
      inspect: async () => f.binding.manifest,
      invoke: async invocation => {
        calls++;
        await executeHandoff(f.binding, invocation, { role: "owner" });
        throw new Error("lost response");
      },
    },
  });
  try {
    await expect(tool!.execute({ title: "ok" })).rejects.toMatchObject({ certainty: "unknown" });
    expect(calls).toBe(1);
    expect(f.contexts).toHaveLength(1);
  } finally { registration.dispose(); }
});

it("checks the sent input against both pinned schemas before accepting an outcome", async () => {
  const f = await fixture();
  const invocation = await createHandoffInvocation(f.binding.manifest, "todos.create", "direct", { title: "ok" });
  const outcome = await executeHandoff(f.binding, invocation, { role: "owner" });
  await expect(validateHandoffResponse(f.binding.manifest, { ...invocation, input: { title: 42 } }, outcome)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("revalidates accessor replacement on reused invocation and handle objects", async () => {
  const f = await fixture();
  const invocation = structuredClone(await createHandoffInvocation(f.binding.manifest, "todos.create", "direct", { title: "ok" }));
  validateHandoffInvocation(invocation);
  Object.defineProperty(invocation, "mode", { get() { return "invalid"; } });
  expect(() => validateHandoffInvocation(invocation)).toThrow();
  const handle = structuredClone(f.projection.handles.create);
  snapshotSurfaceHandle(handle);
  Object.defineProperty(handle, "modes", { get() { return ["invalid"]; } });
  expect(() => snapshotSurfaceHandle(handle)).toThrow();
});

it("rejects changing array accessors before trusting a projected handle", async () => {
  const f = await fixture();
  const handle = structuredClone(f.projection.handles.create);
  let reads = 0;
  Object.defineProperty(handle.modes, "0", {
    enumerable: true,
    get() { return ++reads < 3 ? "direct" : "invalid"; },
  });
  expect(() => snapshotSurfaceHandle(handle)).toThrow();
  expect(reads).toBe(0);
});

for (const mode of ["direct", "request"] as const) {
  it(`preserves checked ${mode} invalid-input rejection without dispatch`, async () => {
    const f = await fixture();
    const invocation = await createHandoffInvocation(f.binding.manifest, "todos.create", mode, { title: "" });
    const outcome = await executeHandoff(f.binding, invocation, { role: "owner" });
    expect(outcome).toMatchObject({ certainty: "not-started", result: { kind: "fault", cause: "invalid-input" } });
    await expect(validateHandoffResponse(f.binding.manifest, invocation, outcome)).resolves.toEqual(outcome);
    await expect(validateHandoffResponse(f.binding.manifest, invocation, { ...outcome, realizationId: "realization:forged:1" })).rejects.toThrow();
    expect(f.contexts).toEqual([]);
    expect(f.rows).toEqual([]);
  });
}
