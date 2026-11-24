import { createHandoffInvocation, type HandoffFaultCause, type HandoffInvocation, type HandoffOutcome } from "@foxworth/boundary/handoff";
import type { ClientInvokeFraming } from "@foxworth/boundary/client";
import { RemoteInvocationError } from "#remote";
import type { JsonValue } from "@foxworth/boundary/program";
import type { WebMcpContextRequest, WebMcpFrame } from "./types";
import { PreparedTool } from "./catalog";

const NEVER_ABORTED = new AbortController().signal;

export type LiveTool<Context> = {
  prepared: PreparedTool<Context>;
  controller: AbortController;
};

function failureOutcome(
  prepared: PreparedTool<any>,
  certainty: "not-started" | "unknown",
  cause: HandoffFaultCause,
): HandoffOutcome {
  return Object.freeze({
    version: 1,
    bindingDigest: prepared.manifest.bindingDigest,
    installationId: prepared.manifest.installationId,
    interactionId: prepared.resolution.binding.interactionId,
    expectedContractDigest:
      prepared.resolution.binding.expectedContractDigest,
    actualContractDigest: prepared.resolution.binding.actualContractDigest,
    mode: prepared.resolution.binding.mode,
    realizationId: prepared.resolution.binding.realizationId,
    certainty,
    result: Object.freeze({ kind: "fault", cause }),
  });
}

export async function executeTool<Context>(
  live: LiveTool<Context>,
  context:
    | ((request: WebMcpContextRequest) => Context | Promise<Context>)
    | undefined,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  frame: WebMcpFrame | undefined,
  claims: WebMcpContextRequest["claims"],
): Promise<HandoffOutcome> {
  const invocationSignal = signal ?? NEVER_ABORTED;
  const prepared = live.prepared;
  if (invocationSignal.aborted) {
    return failureOutcome(prepared, "not-started", "invalid-invocation");
  }
  let invocation;
  try {
    invocation = await createHandoffInvocation(
      prepared.manifest,
      prepared.interactionId,
      prepared.mode,
      prepared.inputArity === 0
        ? null
        : (input as unknown as JsonValue),
    );
  } catch {
    return failureOutcome(prepared, "not-started", "invalid-input");
  }
  const request: WebMcpContextRequest = Object.freeze({
    interactionId: prepared.interactionId,
    mode: prepared.mode,
    signal: invocationSignal,
    ...(claims === undefined ? {} : { claims }),
  });
  let resolvedContext: Context | undefined;
  if (context) {
    try {
      resolvedContext = await context(request);
    } catch {
      return failureOutcome(prepared, "not-started", "invalid-invocation");
    }
  }
  let framing: ClientInvokeFraming | undefined;
  if (frame) {
    try {
      framing = await frame(request);
    } catch {
      return failureOutcome(prepared, "not-started", "invalid-invocation");
    }
  }
  if (invocationSignal.aborted) {
    return failureOutcome(prepared, "not-started", "invalid-invocation");
  }
  try {
    // One exact attempt. Abort after this point cannot roll back or authorize a
    // second attempt, so the checked outcome is allowed to finish unchanged.
    const invoke = prepared.handoff.invoke as (
      invocation: HandoffInvocation,
      context: Context,
      framing?: ClientInvokeFraming,
    ) => Promise<HandoffOutcome>;
    return await invoke(invocation, resolvedContext as Context, framing);
  } catch (error) {
    // Request-mode wire faults only describe proven pre-execution failures.
    // Missing remote evidence is a client failure, not a fabricated server fault.
    if (prepared.mode === "request") {
      throw error instanceof RemoteInvocationError
        ? error
        : new RemoteInvocationError("transport", "the request outcome is unknown");
    }
    return failureOutcome(prepared, "unknown", "realization-failed");
  }
}
