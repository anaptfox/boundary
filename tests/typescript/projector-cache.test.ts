import { describe, expect, it } from "vitest";
import {
  projectInteractions,
  type InteractionDefinition,
  type InteractionHandle,
  type ProjectedInteractionHandle,
} from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";
import {
  createInteractionCacheScope,
  invalidateReadsForChange,
  mountRead,
  watchInteraction,
} from "@foxworth/boundary/client/cache";
import { createHandoffInvocation } from "@foxworth/boundary/handoff";
import { createProjectionClient } from "@foxworth/boundary/client";
import {
  createProtocolHandler,
  fetchTransport,
} from "@foxworth/boundary/http/protocol";
import { createAdapterFixture } from "./helpers/adapter";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  return {
    promise: new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    }),
    resolve,
    reject,
  };
}

type StubDefinition<Arity extends 0 | 1> = InteractionDefinition<
  string,
  JsonValue,
  JsonValue,
  Readonly<Record<string, JsonValue>>,
  Arity
>;

function projectedHandle<const Arity extends 0 | 1>(interactionId: string, inputArity: Arity) {
  return Object.freeze({
    interactionId,
    contractDigest: DIGEST,
    inputArity,
    modes: Object.freeze(["direct"] as const),
  }) as ProjectedInteractionHandle<InteractionHandle<StubDefinition<Arity>>, readonly ["direct"]>;
}

function readClient(options: Readonly<{
  interactionId?: string;
  inputArity?: 0 | 1;
  reads?: readonly string[];
  changes?: readonly string[];
  call: (input: unknown) => Promise<unknown>;
}>) {
  const interactionId = options.interactionId ?? "todos.list";
  const inputArity = options.inputArity ?? 0;
  const reads = options.reads ?? ["todos"];
  const changes = options.changes ?? [];
  const calls: unknown[] = [];
  const client = {
    inspect: async () => ({
      expectedProgram: {
        interactions: [{ contract: { id: interactionId, reads, changes } }],
      },
      interactions: [{
        interactionId,
        mode: "direct",
        expectedContractDigest: DIGEST,
        inputArity,
      }],
    }),
    call: async (_handle: unknown, input?: unknown) => {
      calls.push(input);
      return options.call(input);
    },
  } as never;
  return { client, calls };
}

describe("projector footprint cache", () => {
  it("watches a direct read as a stable framework-neutral external store", async () => {
    const { client, calls } = readClient({ call: async () => ["first"] });
    const read = watchInteraction(client, projectedHandle("todos.list", 0));
    const initial = read.getSnapshot();
    expect(initial).toEqual({ data: undefined, error: undefined, isPending: false });
    expect(read.getSnapshot()).toBe(initial);
    expect(read.getSnapshot).toBe(read.getSnapshot);
    expect(read.refresh).toBe(read.refresh);

    const snapshots: unknown[] = [];
    const unsubscribe = read.subscribe(() => snapshots.push(read.getSnapshot()));
    await read.refresh();

    expect(calls).toEqual([undefined]);
    expect(read.getSnapshot()).toEqual({ data: ["first"], error: undefined, isPending: false });
    expect(snapshots.length).toBeGreaterThan(0);
    unsubscribe();
    read.dispose();
  });

  it("keeps one input snapshot, coalesces bursts, and drains one trailing refresh", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let attempt = 0;
    const { client, calls } = readClient({
      interactionId: "todos.page",
      inputArity: 1,
      call: async () => (++attempt === 1 ? first.promise : second.promise),
    });
    const read = watchInteraction(client, projectedHandle("todos.page", 1), { page: 1 });
    const firstRefresh = read.refresh();
    await expect.poll(() => calls).toEqual([{ page: 1 }]);
    const trailingRefresh = read.refresh();
    expect(trailingRefresh).toBe(firstRefresh);

    first.resolve(["first"]);
    await expect.poll(() => calls).toEqual([{ page: 1 }, { page: 1 }]);
    expect(read.getSnapshot()).toMatchObject({ data: ["first"], isPending: true });
    second.resolve(["second"]);
    await expect(firstRefresh).resolves.toEqual(["second"]);
    expect(read.getSnapshot()).toEqual({ data: ["second"], error: undefined, isPending: false });
  });

  it("rejects declared changes before dispatch and preserves successful data through a read error", async () => {
    const { client, calls } = readClient({
      interactionId: "todos.create",
      reads: ["todos"],
      changes: ["todos"],
      call: async () => [],
    });
    const change = watchInteraction(client, projectedHandle("todos.create", 0));
    await expect(change.refresh()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toEqual([]);

    let fail = false;
    const healthy = readClient({
      call: async () => {
        if (fail) throw new Error("offline");
        return ["saved"];
      },
    });
    const read = watchInteraction(healthy.client, projectedHandle("todos.list", 0));
    await expect(read.refresh()).resolves.toEqual(["saved"]);
    fail = true;
    await expect(read.refresh()).rejects.toThrow("offline");
    expect(read.getSnapshot()).toMatchObject({ data: ["saved"], isPending: false });
    expect(read.getSnapshot().error).toBeInstanceOf(Error);
  });

  it("stops invalidation after the final listener leaves and rejects pending callers on dispose", async () => {
    const waiting = deferred<unknown>();
    const { client, calls } = readClient({ call: async () => waiting.promise });
    const scope = createInteractionCacheScope();
    const read = watchInteraction(client, projectedHandle("todos.list", 0), { scope });
    const unsubscribe = read.subscribe(() => {});
    await Promise.resolve();
    unsubscribe();
    await invalidateReadsForChange(client, { interactionId: "todos.create" }, scope);
    expect(calls).toHaveLength(1);

    const pending = read.refresh();
    read.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(read.refresh()).rejects.toMatchObject({ name: "AbortError" });
    waiting.resolve(["late"]);
    await Promise.resolve();
    expect(read.getSnapshot()).toEqual({ data: undefined, error: undefined, isPending: false });
  });

  it("invalidates mounted reads without react-ui", async () => {
    const fixture = await createAdapterFixture();
    const projection = projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const protocol = createProtocolHandler({
      binding,
      context: () => Object.freeze({ role: "owner" as const, marker: {} }),
      path: "/_boundary",
    });
    const client = createProjectionClient(
      fetchTransport({
        baseUrl: "https://example.test/_boundary",
        fetch: (input, init) => protocol(new Request(input, init)),
      }),
    );
    const refreshed: string[] = [];
    const scope = createInteractionCacheScope();
    const unmount = mountRead(
      client,
      "todos.list",
      async () => {
        refreshed.push("todos.list");
      },
      scope,
    );
    await invalidateReadsForChange(client, { interactionId: "todos.create" }, scope);
    expect(refreshed).toEqual(["todos.list"]);
    unmount();
    await invalidateReadsForChange(client, { interactionId: "todos.create" }, scope);
    expect(refreshed).toEqual(["todos.list"]);
  });

  it("merges per-invoke headers onto the fetch transport", async () => {
    const fixture = await createAdapterFixture();
    const projection = projectInteractions(fixture.compiled, {
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const seen: string[] = [];
    const protocol = createProtocolHandler({
      binding,
      context: (request) => {
        seen.push(request.headers.get("x-host-run") ?? "");
        return Object.freeze({ role: "owner" as const, marker: {} });
      },
      path: "/_boundary",
    });
    const transport = fetchTransport({
      baseUrl: "https://example.test/_boundary",
      headers: { "x-host-run": "boot" },
      fetch: (input, init) => protocol(new Request(input, init)),
    });
    const manifest = await createProjectionClient(transport).inspect();
    const invocation = await createHandoffInvocation(
      manifest,
      "todos.create",
      "direct",
      { title: "Framed" },
    );
    await transport.invoke(invocation, { headers: { "x-host-run": "turn-3" } });
    expect(seen).toEqual(["turn-3"]);
  });
});

it("isolates throwing listeners and settles both successful and failed refreshes", async () => {
  let fail = false;
  let notified = 0;
  const fixture = readClient({ call: async () => { if (fail) throw new Error("read failed"); return ["saved"]; } });
  const read = watchInteraction(fixture.client, projectedHandle("todos.list", 0));
  const stopBad = read.subscribe(() => { throw new Error("view failed"); });
  const stopGood = read.subscribe(() => { notified += 1; });
  await expect(read.refresh()).resolves.toEqual(["saved"]);
  expect(notified).toBeGreaterThan(0);
  fail = true;
  await expect(read.refresh()).rejects.toThrow("read failed");
  expect(read.getSnapshot()).toMatchObject({ data: ["saved"], isPending: false });
  stopBad(); stopGood(); read.dispose();
});
