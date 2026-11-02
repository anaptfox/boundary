// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import type { InteractionDefinition } from "@foxworth/boundary";
import type { InteractionHandle, SurfaceHandle } from "@foxworth/boundary/pipeline";
import { projectInteractions } from "@foxworth/boundary/pipeline";
import type { JsonValue } from "@foxworth/boundary/program";
import type { SurfaceClient } from "@foxworth/boundary/client";
import {
  createInteractionCacheScope,
  invalidateReadsForChange,
} from "@foxworth/boundary/client/cache";
import {
  AdapterError,
  isDomainErrorFor,
  RemoteDomainError,
  RemoteInvocationError,
} from "@foxworth/boundary/remote";
import {
  describeInteractionError,
  InteractionCacheProvider,
  useInteraction,
} from "@foxworth/boundary/react";
import { createAdapterFixture } from "./helpers/adapter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DIGEST = `sha256:${"0".repeat(64)}` as const;

const PROGRAM_INTERACTIONS = [
  { id: "todos.list", reads: ["todos"], changes: [] },
  { id: "notes.list", reads: ["notes"], changes: [] },
  { id: "todos.create", reads: [], changes: ["todos"] },
  { id: "noop.change", reads: [], changes: [] },
  { id: "releases.inspect", reads: ["releases"], changes: [] },
  { id: "releases.publish", reads: ["releases"], changes: ["releases"] },
  { id: "control.execute", reads: [], changes: ["control.grants"] },
  { id: "needy.read", reads: ["needy"], changes: [] },
  { id: "needy.touch", reads: [], changes: ["needy"] },
];

type StubDefinition<Arity extends 0 | 1> = InteractionDefinition<
  string,
  JsonValue,
  JsonValue,
  Readonly<Record<string, JsonValue>>,
  Arity
>;

function handle<const Arity extends 0 | 1>(interactionId: string, inputArity: Arity) {
  return Object.freeze({
    interactionId,
    contractDigest: DIGEST,
    inputArity,
    modes: Object.freeze(["direct"] as const),
  }) as SurfaceHandle<
    InteractionHandle<StubDefinition<Arity>>,
    readonly ["direct"]
  >;
}

function stubClient(
  respond: (interactionId: string, input: unknown) => unknown,
): { client: SurfaceClient; calls: string[] } {
  const calls: string[] = [];
  const handshake = {
    expectedProgram: {
      interactions: PROGRAM_INTERACTIONS.map((interaction) => ({
        contract: { ...interaction },
      })),
    },
    interactions: PROGRAM_INTERACTIONS.map((interaction) => ({
      interactionId: interaction.id,
      mode: "direct" as const,
      expectedContractDigest: DIGEST,
      inputArity: interaction.id === "todos.create" || interaction.id === "control.execute" || interaction.id === "needy.read"
        ? 1 as const
        : 0 as const,
    })),
  };
  const client = {
    inspect: () => Promise.resolve(handshake),
    call: (value: SurfaceHandle, input?: unknown) => {
      calls.push(value.interactionId);
      return Promise.resolve(respond(value.interactionId, input));
    },
  } as unknown as SurfaceClient;
  return { client, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useInteraction footprint invalidation", () => {
  it("refreshes only the reads whose footprint the change touches", async () => {
    const { client, calls } = stubClient(() => []);
    const todos = renderHook(() =>
      useInteraction(client, handle("todos.list", 0)),
    );
    const notes = renderHook(() =>
      useInteraction(client, handle("notes.list", 0)),
    );
    await waitFor(() => expect(todos.result.current.isPending).toBe(false));
    await waitFor(() => expect(notes.result.current.isPending).toBe(false));
    expect(calls).toEqual(["todos.list", "notes.list"]);

    const create = renderHook(() =>
      useInteraction(client, handle("todos.create", 1)),
    );
    await act(async () => {
      await create.result.current.call({ title: "one" } as never);
    });

    expect(calls.filter((id) => id === "todos.list")).toHaveLength(2);
    expect(calls.filter((id) => id === "notes.list")).toHaveLength(1);
  });

  it("keeps invalidation client-local by default", async () => {
    const screen = stubClient(() => []);
    const agent = stubClient(() => []);
    const screenList = renderHook(() =>
      useInteraction(screen.client, handle("todos.list", 0)),
    );
    const agentList = renderHook(() =>
      useInteraction(agent.client, handle("todos.list", 0)),
    );
    await waitFor(() => expect(screenList.result.current.isPending).toBe(false));
    await waitFor(() => expect(agentList.result.current.isPending).toBe(false));

    const create = renderHook(() =>
      useInteraction(agent.client, handle("todos.create", 1)),
    );
    await act(async () => {
      await create.result.current.call({ title: "one" } as never);
    });

    expect(screen.calls.filter((id) => id === "todos.list")).toHaveLength(1);
    expect(agent.calls.filter((id) => id === "todos.list")).toHaveLength(2);
  });

  it("shares invalidation only through an explicit cache scope", async () => {
    const screen = stubClient(() => []);
    const agent = stubClient(() => []);
    const scope = createInteractionCacheScope();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <InteractionCacheProvider scope={scope}>{children}</InteractionCacheProvider>
    );
    const screenList = renderHook(
      () => useInteraction(screen.client, handle("todos.list", 0)),
      { wrapper },
    );
    const agentList = renderHook(
      () => useInteraction(agent.client, handle("todos.list", 0)),
      { wrapper },
    );
    await waitFor(() => expect(screenList.result.current.isPending).toBe(false));
    await waitFor(() => expect(agentList.result.current.isPending).toBe(false));

    const create = renderHook(
      () => useInteraction(agent.client, handle("todos.create", 1)),
      { wrapper },
    );
    await act(async () => {
      await create.result.current.call({ title: "shared" } as never);
    });

    expect(screen.calls.filter((id) => id === "todos.list")).toHaveLength(2);
    expect(agent.calls.filter((id) => id === "todos.list")).toHaveLength(2);
  });

  it("stops refreshing a read after it unmounts", async () => {
    const { client, calls } = stubClient(() => []);
    const todos = renderHook(() =>
      useInteraction(client, handle("todos.list", 0)),
    );
    await waitFor(() => expect(todos.result.current.isPending).toBe(false));
    todos.unmount();

    await act(async () => {
      await invalidateReadsForChange(client, handle("todos.create", 1));
    });
    expect(calls.filter((id) => id === "todos.list")).toHaveLength(1);
  });

  it("releases and remounts the shared projector read cleanly in StrictMode", async () => {
    const { client, calls } = stubClient(() => []);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const todos = renderHook(
      () => useInteraction(client, handle("todos.list", 0)),
      { wrapper },
    );
    await waitFor(() => expect(todos.result.current.isPending).toBe(false));
    const mountedCalls = calls.filter((id) => id === "todos.list").length;

    await act(async () => {
      await invalidateReadsForChange(client, handle("todos.create", 1));
    });
    await waitFor(() =>
      expect(calls.filter((id) => id === "todos.list")).toHaveLength(mountedCalls + 1),
    );
    act(() => todos.unmount());

    await act(async () => {
      await invalidateReadsForChange(client, handle("todos.create", 1));
    });
    expect(calls.filter((id) => id === "todos.list")).toHaveLength(mountedCalls + 1);
  });

  it("requires an explicit completed change handle instead of inferring control completion", async () => {
    const { client, calls } = stubClient((interactionId) =>
      interactionId === "control.execute" ? { proposal: "proposal-1" } : {},
    );
    const snapshot = renderHook(() =>
      useInteraction(client, handle("releases.inspect", 0)),
    );
    await waitFor(() => expect(snapshot.result.current.isPending).toBe(false));

    const execute = renderHook(() =>
      useInteraction(client, handle("control.execute", 1)),
    );
    await act(async () => {
      await execute.result.current.call({ grantId: "grant-1" } as never);
    });

    expect(calls.filter((id) => id === "releases.inspect")).toHaveLength(1);
    await act(async () => {
      await invalidateReadsForChange(client, handle("releases.publish", 1));
    });
    expect(calls.filter((id) => id === "releases.inspect")).toHaveLength(2);
  });

  it("invalidates nothing for a change with an empty footprint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = stubClient(() => ({}));
    const todos = renderHook(() =>
      useInteraction(client, handle("todos.list", 0)),
    );
    await waitFor(() => expect(todos.result.current.isPending).toBe(false));

    const noop = renderHook(() =>
      useInteraction(client, handle("noop.change", 0)),
    );
    await act(async () => {
      await noop.result.current.call();
    });

    expect(calls.filter((id) => id === "todos.list")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the change interaction is not in the program", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = stubClient(() => ({}));
    const todos = renderHook(() =>
      useInteraction(client, handle("todos.list", 0)),
    );
    await waitFor(() => expect(todos.result.current.isPending).toBe(false));

    await invalidateReadsForChange(client, handle("ghost.change", 0));
    expect(warn).toHaveBeenCalledOnce();
    expect(calls.filter((id) => id === "todos.list")).toHaveLength(1);
  });
});

describe("useInteraction argument handling", () => {
  it("surfaces a missing-arguments read as an error instead of loading forever", async () => {
    const { client, calls } = stubClient(() => []);
    const needy = renderHook(() =>
      useInteraction(client, handle("needy.read", 1)),
    );
    await waitFor(() =>
      expect(needy.result.current.error).toBeInstanceOf(AdapterError),
    );
    expect(needy.result.current.isPending).toBe(false);
    expect((needy.result.current.error as AdapterError).code).toBe(
      "INVALID_REQUEST",
    );
    expect(calls).toHaveLength(0);
  });

  it("keeps refetch arguments for later invalidation refreshes", async () => {
    const inputs: unknown[] = [];
    const { client } = stubClient((interactionId, input) => {
      if (interactionId === "needy.read") inputs.push(input);
      return [];
    });
    const needy = renderHook(() =>
      useInteraction(client, handle("needy.read", 1), { page: 1 } as never),
    );
    await waitFor(() => expect(needy.result.current.isPending).toBe(false));
    await act(async () => {
      await needy.result.current.refetch({ page: 2 } as never);
    });
    await act(async () => {
      await invalidateReadsForChange(client, handle("needy.touch", 0));
    });
    await waitFor(() => expect(needy.result.current.isPending).toBe(false));
    expect(inputs).toEqual([{ page: 1 }, { page: 2 }, { page: 2 }]);
  });
});

describe("useInteraction declared errors", () => {
  it("narrows declared error codes and details through the projected handle", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      create: {
        interaction: fixture.compiled.handles.create,
        modes: ["direct"],
      },
    });
    const error: unknown = new RemoteDomainError(
      "todos.create",
      projection.handles.create.contractDigest,
      {
      code: "duplicate",
      details: { title: "duplicate" },
      },
    );

    expect(isDomainErrorFor(projection.handles.create, error)).toBe(true);
    if (isDomainErrorFor(projection.handles.create, error)) {
      error.value.code satisfies "duplicate";
      error.value.details.title satisfies string;
    }
    expect(describeInteractionError(error)).toMatchObject({ kind: "domain" });
  });

  it("classifies unknown remote consequence with reconciliation guidance", () => {
    const error = new RemoteInvocationError(
      "transport",
      "connection dropped after dispatch",
    );
    expect(describeInteractionError(error)).toEqual({
      kind: "unknown",
      message: "The interaction consequence is unknown. Reconcile before retrying.",
    });
  });

  it("evicts a rejected handshake so a later mount can inspect again", async () => {
    let inspections = 0;
    const { client } = stubClient(() => []);
    const retryingClient = {
      ...client,
      inspect() {
        inspections += 1;
        return inspections === 1
          ? Promise.reject(new Error("temporary handshake failure"))
          : client.inspect();
      },
    } as SurfaceClient;

    const first = renderHook(() =>
      useInteraction(retryingClient, handle("todos.list", 0)),
    );
    await waitFor(() => expect(first.result.current.error).toBeDefined());
    first.unmount();

    const second = renderHook(() =>
      useInteraction(retryingClient, handle("todos.list", 0)),
    );
    await waitFor(() => expect(second.result.current.isPending).toBe(false));
    expect(second.result.current.error).toBeUndefined();
    expect(inspections).toBe(2);
  });
});

describe("useInteraction shares headless mutation semantics", () => {
  it("rejects overlapping mutations without duplicating dispatch", async () => {
    let finish!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>((resolve) => { finish = resolve; });
    const fixture = stubClient(() => pending);
    const hook = renderHook(() => useInteraction(fixture.client, handle("todos.create", 1)));
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    let first!: Promise<JsonValue>;
    act(() => { first = hook.result.current.call({ title: "one" }); });
    await expect(hook.result.current.call({ title: "two" })).rejects.toThrow("in flight");
    expect(fixture.calls).toEqual(["todos.create"]);
    await act(async () => { finish({ id: "created" }); await first; });
    expect(hook.result.current.data).toEqual({ id: "created" });
    hook.unmount();
  });

  it("keeps mutation completion separate from a stalled read refresh", async () => {
    let finishRead!: () => void;
    const blocked = new Promise<void>((resolve) => { finishRead = resolve; });
    let reads = 0;
    const fixture = stubClient((id) => id === "todos.list" && ++reads > 1 ? blocked.then(() => []) : []);
    const read = renderHook(() => useInteraction(fixture.client, handle("todos.list", 0)));
    await waitFor(() => expect(read.result.current.isPending).toBe(false));
    const change = renderHook(() => useInteraction(fixture.client, handle("todos.create", 1)));
    await waitFor(() => expect(change.result.current.isPending).toBe(false));
    await act(async () => { await change.result.current.call({ title: "one" }); });
    expect(change.result.current.isPending).toBe(false);
    expect(change.result.current.error).toBeUndefined();
    await act(async () => { finishRead(); });
    read.unmount(); change.unmount();
  });
});

it("settles queued calls on unmount before inspection completes", async () => {
  const base = stubClient(() => []);
  let finish!: (value: Awaited<ReturnType<SurfaceClient["inspect"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<SurfaceClient["inspect"]>>>((resolve) => { finish = resolve; });
  const client = { ...base.client, inspect: () => pending } as SurfaceClient;
  const hook = renderHook(() => useInteraction(client, handle("todos.create", 1)));
  const queued = hook.result.current.call({ title: "queued" });
  hook.unmount();
  await expect(queued).rejects.toThrow("disposed or replaced");
  finish(await base.client.inspect());
  await Promise.resolve();
  expect(base.calls).toEqual([]);
});

it("rejects a retired view callback and waits for replacement classification", async () => {
  const first = stubClient(() => []);
  const second = stubClient(() => ({ saved: true }));
  let finish!: (value: Awaited<ReturnType<SurfaceClient["inspect"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<SurfaceClient["inspect"]>>>((resolve) => { finish = resolve; });
  const replacement = { ...second.client, inspect: () => pending } as SurfaceClient;
  const hook = renderHook(({ client }) => useInteraction(client, handle("todos.create", 1)), { initialProps: { client: first.client } });
  await waitFor(() => expect(hook.result.current.isPending).toBe(false));
  const retired = hook.result.current.call;
  hook.rerender({ client: replacement });
  await expect(retired({ title: "old" })).rejects.toThrow("replaced");
  let queued!: Promise<JsonValue>;
  act(() => { queued = hook.result.current.call({ title: "new" }); });
  expect(second.calls).toEqual([]);
  await act(async () => { finish(await second.client.inspect()); await queued; });
  expect(second.calls).toEqual(["todos.create"]);
  expect(first.calls).toEqual([]);
  hook.unmount();
});

it("rejects queued calls when initial read input is nonportable", async () => {
  const fixture = stubClient(() => []);
  const hook = renderHook(() => useInteraction(fixture.client, handle("needy.read", 1), { page: NaN } as never));
  const queued = hook.result.current.call({ page: NaN } as never);
  await expect(queued).rejects.toThrow();
  await waitFor(() => expect(hook.result.current.error).toBeDefined());
  expect(hook.result.current.isPending).toBe(false);
  expect(fixture.calls).toEqual([]);
  hook.unmount();
});

it("rejects invalid replacement input without disposing a valid read", async () => {
  const fixture = stubClient(() => []);
  const hook = renderHook(() => useInteraction(fixture.client, handle("needy.read", 1), { page: 1 } as never));
  await waitFor(() => expect(hook.result.current.isPending).toBe(false));
  await expect(hook.result.current.call({ page: NaN } as never)).rejects.toThrow();
  await act(async () => { await hook.result.current.call({ page: 2 } as never); });
  expect(hook.result.current.error).toBeUndefined();
  hook.unmount();
});

it("retires callbacks when the cache scope changes", async () => {
  const fixture = stubClient(() => []);
  let scope = createInteractionCacheScope();
  const wrapper = ({ children }: { children: ReactNode }) => <InteractionCacheProvider scope={scope}>{children}</InteractionCacheProvider>;
  const hook = renderHook(() => useInteraction(fixture.client, handle("todos.list", 0)), { wrapper });
  await waitFor(() => expect(hook.result.current.isPending).toBe(false));
  const retired = hook.result.current.call;
  scope = createInteractionCacheScope();
  hook.rerender();
  await expect(retired()).rejects.toThrow("replaced");
  await waitFor(() => expect(hook.result.current.isPending).toBe(false));
  hook.unmount();
});
