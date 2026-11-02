import { describe, expect, it } from "vitest";
import type {
  InteractionDefinition,
  InteractionHandle,
  ProjectedInteractionHandle,
} from "@foxworth/boundary";
import { projectInteractions } from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";
import {
  createInvocationState,
  createProposalInteraction,
} from "@foxworth/boundary/client";
import { RemoteInvocationError } from "@foxworth/boundary/remote";
import type { ProjectionClient } from "@foxworth/boundary/client";
import { createProtocolHandler, fetchTransport } from "@foxworth/boundary/http/protocol";
import { createProjectionClient } from "@foxworth/boundary/client";
import { createAdapterFixture } from "./helpers/adapter";

const DIGEST = `sha256:${"b".repeat(64)}` as const;
type Definition<Arity extends 0 | 1> = InteractionDefinition<
  string, JsonValue, JsonValue, Readonly<Record<string, JsonValue>>, Arity
>;

function handle<const Mode extends "direct" | "request">(
  mode: Mode,
): ProjectedInteractionHandle<InteractionHandle<Definition<0>>, readonly [Mode]> {
  return Object.freeze({
    interactionId: mode === "direct" ? "drafts.save" : "drafts.publish",
    contractDigest: DIGEST,
    inputArity: 0,
    modes: Object.freeze([mode]),
  }) as ProjectedInteractionHandle<InteractionHandle<Definition<0>>, readonly [Mode]>;
}

function client(calls: string[], outcome: () => Promise<JsonValue>): ProjectionClient {
  const call: ProjectionClient["call"] = async () => {
    calls.push("call");
    return (await outcome()) as never;
  };
  const request: ProjectionClient["request"] = async () => {
    calls.push("request");
    return (await outcome()) as never;
  };
  return {
    // Interaction tests do not mount reads; completed-change invalidation is
    // deliberately best-effort and this isolated transport has no Binding.
    inspect: async () => { throw new Error("not mounted in this interaction test"); },
    call,
    request,
    callRaw: async () => outcome(),
    requestRaw: async () => outcome(),
  };
}

describe("framework-neutral interaction interactions", () => {
  it("is inert until explicit invocation and never retries an unknown result", async () => {
    const calls: string[] = [];
    const interaction = createInvocationState(
      client(calls, async () => { throw new RemoteInvocationError("transport", "lost response"); }),
      handle("direct"),
      "direct",
    );
    expect(interaction.getSnapshot()).toMatchObject({ phase: "idle", isPending: false });
    expect(calls).toEqual([]);

    await expect(interaction.invoke()).rejects.toBeInstanceOf(RemoteInvocationError);
    expect(calls).toEqual(["call"]);
    expect(interaction.getSnapshot()).toMatchObject({ phase: "uncertain", isPending: false });
    expect(interaction.getSnapshot().error).toBeInstanceOf(RemoteInvocationError);
    expect(calls).toEqual(["call"]);
  });

  const retiredAvailability = {
    disconnect: "disconnected", markStale: "stale", dispose: "disposed",
  } as const;

  for (const action of ["disconnect", "markStale", "dispose"] as const) {
    it(`keeps a late unknown outcome visible after ${action} without another dispatch`, async () => {
      let reject!: (error: Error) => void;
      const pending = new Promise<JsonValue>((_, no) => { reject = no; });
      const calls: string[] = [];
      const interaction = createInvocationState(client(calls, () => pending), handle("direct"), "direct");
      const error = new RemoteInvocationError("transport", "reply lost after dispatch");
      const invoking = interaction.invoke();
      const rejected = expect(invoking).rejects.toBe(error);
      interaction[action]();
      expect(interaction.getSnapshot()).toMatchObject({
        phase: "pending", availability: retiredAvailability[action], isPending: true,
      });
      await expect(interaction.invoke()).rejects.toThrow(retiredAvailability[action]);
      reject(error);
      await rejected;
      expect(interaction.getSnapshot()).toMatchObject({
        phase: "uncertain", availability: retiredAvailability[action], error, isPending: false,
      });
      interaction[action]();
      expect(interaction.getSnapshot().phase).toBe("uncertain");
      await expect(interaction.invoke()).rejects.toThrow(retiredAvailability[action]);
      expect(calls).toEqual(["call"]);
    });

    it(`retains a known late result after ${action} while invocation stays blocked`, async () => {
      let resolve!: (value: JsonValue) => void;
      const pending = new Promise<JsonValue>((yes) => { resolve = yes; });
      const calls: string[] = [];
      const interaction = createInvocationState(client(calls, () => pending), handle("direct"), "direct");
      const invoking = interaction.invoke();
      interaction[action]();
      resolve({ saved: true });
      await expect(invoking).resolves.toEqual({ saved: true });
      expect(interaction.getSnapshot()).toMatchObject({
        phase: "succeeded", availability: retiredAvailability[action], result: { saved: true }, isPending: false,
      });
      await expect(interaction.invoke()).rejects.toThrow(retiredAvailability[action]);
      expect(calls).toEqual(["call"]);
    });
  }

  it("keeps an already uncertain attempt when its connection becomes stale or disconnected", async () => {
    const error = new RemoteInvocationError("response", "invalid response after dispatch");
    const interaction = createInvocationState(client([], async () => { throw error; }), handle("direct"), "direct");
    await expect(interaction.invoke()).rejects.toBe(error);
    interaction.markStale();
    expect(interaction.getSnapshot()).toMatchObject({ phase: "uncertain", availability: "stale", error });
    interaction.disconnect();
    expect(interaction.getSnapshot()).toMatchObject({ phase: "uncertain", availability: "disconnected", error });
  });

  it("makes stale and disconnected state explicit and blocks later effects", async () => {
    const calls: string[] = [];
    const interaction = createInvocationState(client(calls, async () => ({ ok: true })), handle("direct"), "direct");
    interaction.markStale();
    await expect(interaction.invoke()).rejects.toThrow("stale");
    interaction.disconnect();
    await expect(interaction.invoke()).rejects.toThrow("disconnected");
    expect(calls).toEqual([]);
  });

  it("observes a proposal only through the supplied public reader function", async () => {
    const calls: string[] = [];
    const proposal = { id: "proposal-1" };
    const requestHandle = handle("request");
    const interaction = createProposalInteraction<typeof requestHandle, { id: string; phase: "uncertain" }>(
      client(calls, async () => proposal),
      requestHandle,
      async () => ({ id: "proposal-1", phase: "uncertain" as const }),
    );
    const submitted = await interaction.invocation.invoke();
    expect(submitted).toEqual(proposal);
    expect(interaction.getStatusSnapshot()).toEqual({ proposal: undefined, status: undefined, error: undefined, isPending: false });
    await expect(interaction.observe(proposal)).resolves.toEqual({ id: "proposal-1", phase: "uncertain" });
    expect(interaction.getStatusSnapshot()).toEqual({
      proposal,
      status: { id: "proposal-1", phase: "uncertain" },
      error: undefined,
      isPending: false,
    });
    expect(calls).toEqual(["request"]);
  });

  it("uses the invocation availability to block proposal observation", async () => {
    let observations = 0;
    const requestHandle = handle("request");
    const interaction = createProposalInteraction(
      client([], async () => ({ id: "proposal-1" })), requestHandle,
      async () => { observations += 1; return { phase: "proposed" }; },
    );
    const proposal = await interaction.invocation.invoke();
    interaction.invocation.disconnect();
    await expect(interaction.observe(proposal)).rejects.toThrow("disconnected");
    expect(interaction.invocation.getSnapshot()).toMatchObject({ phase: "succeeded", availability: "disconnected", result: proposal });
    expect(observations).toBe(0);
  });

  for (const action of ["disconnect", "markStale", "dispose"] as const) {
    it(`suppresses a late status after direct invocation ${action}`, async () => {
      let release!: (status: { phase: "approved" }) => void;
      const pending = new Promise<{ phase: "approved" }>((resolve) => { release = resolve; });
      const requestHandle = handle("request");
      const interaction = createProposalInteraction<typeof requestHandle, { phase: "approved" }>(
        client([], async () => ({ id: "proposal-1" })), requestHandle, () => pending,
      );
      const snapshots: ReturnType<typeof interaction.getStatusSnapshot>[] = [];
      const stop = interaction.subscribeStatus(() => { snapshots.push(interaction.getStatusSnapshot()); });
      const observing = interaction.observe({ id: "proposal-1" });
      expect(interaction.getStatusSnapshot().isPending).toBe(true);
      interaction.invocation[action]();
      const retired = { proposal: undefined, status: undefined, error: undefined, isPending: false };
      expect(interaction.getStatusSnapshot()).toEqual(retired);
      expect(snapshots).toHaveLength(2); // Pending, then the availability-driven retirement.
      expect(snapshots[1]).toEqual(retired);
      release({ phase: "approved" });
      await observing;
      expect(interaction.getStatusSnapshot()).toEqual(retired);
      expect(snapshots).toHaveLength(2); // The late status cannot publish.
      await expect(interaction.observe({ id: "proposal-2" })).rejects.toThrow(retiredAvailability[action]);
      stop();
    });
  }

  for (const action of ["disconnect", "markStale", "dispose"] as const) {
    it(`clears a completed public status and notifies on direct invocation ${action}`, async () => {
      const requestHandle = handle("request");
      const interaction = createProposalInteraction(
        client([], async () => ({ id: "proposal-1" })), requestHandle, async () => ({ phase: "approved" }),
      );
      const proposal = await interaction.invocation.invoke();
      await interaction.observe(proposal);
      expect(interaction.getStatusSnapshot().status).toEqual({ phase: "approved" });
      const snapshots: ReturnType<typeof interaction.getStatusSnapshot>[] = [];
      const stop = interaction.subscribeStatus(() => { snapshots.push(interaction.getStatusSnapshot()); });
      interaction.invocation[action]();
      const retired = { proposal: undefined, status: undefined, error: undefined, isPending: false };
      expect(interaction.getStatusSnapshot()).toEqual(retired);
      expect(snapshots).toEqual([retired]);
      expect(interaction.invocation.getSnapshot()).toMatchObject({ phase: "succeeded", availability: retiredAvailability[action], result: proposal });
      await expect(interaction.observe(proposal)).rejects.toThrow(retiredAvailability[action]);
      if (action === "dispose") expect(() => interaction.subscribeStatus(() => {})).toThrow("disposed");
      stop();
    });
  }

  it("does not let a throwing listener rewrite a completed invocation", async () => {
    const interaction = createInvocationState(client([], async () => ({ ok: true })), handle("direct"), "direct");
    interaction.subscribe(() => { throw new Error("view failure"); });
    await expect(interaction.invoke()).resolves.toEqual({ ok: true });
    expect(interaction.getSnapshot()).toMatchObject({ phase: "succeeded", result: { ok: true } });
  });

  it("rejects a concurrent invocation before it can dispatch a second effect", async () => {
    let release!: () => void;
    const waiting = new Promise<JsonValue>((resolve) => { release = () => resolve({ ok: true }); });
    const calls: string[] = [];
    const interaction = createInvocationState(client(calls, async () => waiting), handle("direct"), "direct");
    const first = interaction.invoke();
    await expect(interaction.invoke()).rejects.toThrow("in flight");
    expect(calls).toEqual(["call"]);
    release();
    await first;
  });

  it("clears proposal A status before observing proposal B", async () => {
    const first = { id: "proposal-a" };
    const second = { id: "proposal-b" };
    const requestHandle = handle("request");
    const interaction = createProposalInteraction<typeof requestHandle, { phase: string }>(
      client([], async () => first), requestHandle, async () => ({ phase: "proposed" }),
    );
    await interaction.observe(first);
    const observing = interaction.observe(second);
    expect(interaction.getStatusSnapshot()).toEqual({ proposal: second, status: undefined, error: undefined, isPending: true });
    await observing;
  });

  it("submits a request through the checked Binding client", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      create: { interaction: fixture.compiled.handles.create, modes: ["request"] },
    });
    const binding = await fixture.bind(projection);
    const protocol = createProtocolHandler({
      binding,
      context: () => Object.freeze({ role: "owner" as const }),
      path: "/_boundary",
    });
    const checkedClient = createProjectionClient(fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: (input, init) => protocol(new Request(input, init)),
    }));
    const interaction = createProposalInteraction(
      checkedClient,
      projection.handles.create,
      async () => ({ phase: "proposed" as const }),
    );
    await expect(interaction.invocation.invoke({ title: "Typed request" })).resolves.toMatchObject({ title: "Typed request" });
  });

  it("disconnect during observation clears status and suppresses a late public read", async () => {
    let release!: (value: { phase: "approved" }) => void;
    const pending = new Promise<{ phase: "approved" }>((resolve) => { release = resolve; });
    const requestHandle = handle("request");
    const interaction = createProposalInteraction<typeof requestHandle, { phase: "approved" }>(
      client([], async () => ({ id: "proposal-1" })), requestHandle, async () => pending,
    );
    const observing = interaction.observe({ id: "proposal-1" });
    interaction.disconnect();
    expect(interaction.getStatusSnapshot()).toEqual({ proposal: undefined, status: undefined, error: undefined, isPending: false });
    release({ phase: "approved" });
    await observing;
    expect(interaction.getStatusSnapshot().status).toBeUndefined();
    await expect(interaction.observe({ id: "proposal-2" })).rejects.toThrow("disconnected");
  });
});
