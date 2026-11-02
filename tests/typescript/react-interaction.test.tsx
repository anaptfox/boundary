// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StrictMode, type ReactNode } from "react";
import type { InteractionDefinition } from "@foxworth/boundary";
import type { InteractionHandle, SurfaceHandle } from "@foxworth/boundary/pipeline";
import type { JsonValue } from "@foxworth/boundary/program";
import type { SurfaceClient } from "@foxworth/boundary/client";
import { RemoteExecutionError, RemoteInvocationError } from "@foxworth/boundary/remote";
import { describeInteractionError, useInvocationState, useProposalInteraction } from "@foxworth/boundary/react";

const DIGEST = `sha256:${"c".repeat(64)}` as const;
type Definition = InteractionDefinition<string, JsonValue, JsonValue, Readonly<Record<string, JsonValue>>, 0>;
function handle<const Mode extends "direct" | "request">(mode: Mode) {
  return Object.freeze({
    interactionId: "drafts.publish",
    contractDigest: DIGEST,
    inputArity: 0,
    modes: Object.freeze([mode]),
  }) as SurfaceHandle<InteractionHandle<Definition>, readonly [Mode]>;
}

function client(callValue: JsonValue, requestValue: JsonValue, calls: string[]): SurfaceClient {
  const call: SurfaceClient["call"] = async () => {
    calls.push("call");
    return callValue as never;
  };
  const request: SurfaceClient["request"] = async () => {
    calls.push("request");
    return requestValue as never;
  };
  return {
    inspect: async () => { throw new Error("not mounted in this interaction test"); },
    call,
    request,
    callRaw: async () => callValue,
    requestRaw: async () => requestValue,
  };
}

describe("React interaction hooks", () => {
  it("does not invoke during render and exposes local explicit state", async () => {
    const calls: string[] = [];
    const projectionClient = client({ saved: true }, { id: "proposal-1" }, calls);
    const rendered = renderHook(() => useInvocationState(projectionClient, handle("direct"), "direct"));
    expect(rendered.result.current.phase).toBe("idle");
    expect(calls).toEqual([]);
    await act(async () => { await rendered.result.current.invoke(); });
    await waitFor(() => expect(rendered.result.current.phase).toBe("succeeded"));
    expect(calls).toEqual(["call"]);
  });

  it("shows uncertainty after disconnect without enabling another invocation", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<JsonValue>((_, no) => { reject = no; });
    const calls: string[] = [];
    const projectionClient: SurfaceClient = {
      ...client({}, {}, calls),
      call: async () => { calls.push("call"); return await pending as never; },
    };
    const rendered = renderHook(() => useInvocationState(projectionClient, handle("direct"), "direct"));
    const error = new RemoteInvocationError("transport", "reply lost after dispatch");
    let invoking!: Promise<JsonValue>;
    act(() => { invoking = rendered.result.current.invoke(); });
    const rejected = expect(invoking).rejects.toBe(error);
    act(() => { rendered.result.current.disconnect(); });
    expect(rendered.result.current).toMatchObject({ phase: "pending", availability: "disconnected" });
    await act(async () => { reject(error); await rejected; });
    expect(rendered.result.current).toMatchObject({ phase: "uncertain", availability: "disconnected", error });
    await expect(rendered.result.current.invoke()).rejects.toThrow("disconnected");
    expect(calls).toEqual(["call"]);
  });

  it("describes unknown execution faults with reconciliation guidance", () => {
    const unknown = new RemoteExecutionError("drafts.publish", "unknown", "realization-failed");
    expect(describeInteractionError(unknown)).toEqual({
      kind: "unknown", message: "The interaction consequence is unknown. Reconcile before retrying.",
    });
    const notStarted = new RemoteExecutionError("drafts.publish", "not-started", "revoked");
    expect(describeInteractionError(notStarted)).toMatchObject({ kind: "execution" });
  });

  it("keeps proposal status observation separate from submission", async () => {
    const projectionClient = client({}, { id: "proposal-1" }, []);
    const rendered = renderHook(() => useProposalInteraction(
      projectionClient,
      handle("request"),
      async () => ({ proposalId: "proposal-1", phase: "proposed" }),
    ));
    expect(rendered.result.current.status.status).toBeUndefined();
    let proposal!: JsonValue;
    await act(async () => { proposal = await rendered.result.current.request(); });
    expect(rendered.result.current.status.status).toBeUndefined();
    await act(async () => { await rendered.result.current.observe(proposal); });
    expect(rendered.result.current.status.status).toEqual({ proposalId: "proposal-1", phase: "proposed" });
  });

  it("survives StrictMode setup-cleanup-setup before explicit invocation", async () => {
    const calls: string[] = [];
    const projectionClient = client({ saved: true }, { id: "proposal-1" }, calls);
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const rendered = renderHook(() => useInvocationState(projectionClient, handle("direct"), "direct"), { wrapper });
    await act(async () => { await rendered.result.current.invoke(); });
    expect(rendered.result.current.phase).toBe("succeeded");
    expect(calls).toEqual(["call"]);
  });

  it("disposes the retired interaction store after a client replacement", async () => {
    const first = client({ saved: "first" }, { id: "first" }, []);
    const secondCalls: string[] = [];
    const second = client({ saved: "second" }, { id: "second" }, secondCalls);
    const rendered = renderHook(
      ({ projectionClient }) => useInvocationState(projectionClient, handle("direct"), "direct"),
      { initialProps: { projectionClient: first } },
    );
    const retired = rendered.result.current;
    rendered.rerender({ projectionClient: second });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(retired.invoke()).rejects.toThrow("disposed");
    await act(async () => { await rendered.result.current.invoke(); });
    expect(secondCalls).toEqual(["call"]);
  });

  it("disposes retired proposal state without carrying it to a replacement", async () => {
    const first = client({}, { id: "first" }, []);
    const second = client({}, { id: "second" }, []);
    const observe = async () => ({ phase: "proposed" });
    const rendered = renderHook(
      ({ projectionClient }) => useProposalInteraction(projectionClient, handle("request"), observe),
      { initialProps: { projectionClient: first } },
    );
    await act(async () => {
      const proposal = await rendered.result.current.request();
      await rendered.result.current.observe(proposal);
    });
    const retired = rendered.result.current;
    rendered.rerender({ projectionClient: second });
    expect(rendered.result.current.status.status).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(retired.request()).rejects.toThrow("disposed");
    await act(async () => { await rendered.result.current.request(); });
  });
});
