import { restoreDeclaredInteractionError } from "./definitions";
import { InteractionFault } from "./errors";
import { metadataForProjectedHandle } from "./projection";
import type { ProjectedInteractionHandle, ProjectionBinding, RawInvocationOutcome, ResolvedBindingInteraction } from "./types";
import { BindingMetadata, bindingMetadata } from "./binding-state";
import { rawInvoke } from "./dispatch";

function outcomeRecord(raw: RawInvocationOutcome) {
  const result = raw.result;
  if (result.kind === "returned") return Object.freeze({ kind: "ok", value: result.value, certainty: "completed" });
  if (result.kind === "proposed") return Object.freeze({ kind: "ok", proposal: result.proposal, certainty: "completed" });
  if (result.kind === "declared-error") return Object.freeze({ ...result, certainty: "completed" });
  if (result.kind === "denied") return Object.freeze({ kind: "denied", certainty: "not-started" });
  return Object.freeze({ kind: "fault", cause: result.cause, certainty: raw.certainty === "completed" ? "unknown" : raw.certainty, message: "interaction invocation failed" });
}

function throwTyped(outcome: RawInvocationOutcome): never {
  if (outcome.result.kind === "declared-error") {
    throw restoreDeclaredInteractionError(
      outcome.interactionId,
      outcome.expectedContractDigest,
      outcome.result.code,
      outcome.result.details,
    );
  }
  if (outcome.result.kind === "denied") {
    throw new InteractionFault(
      "denied",
      "not-started",
      "interaction admission was denied",
    );
  }
  const rawCause = outcome.result.kind === "fault"
    ? outcome.result.cause
    : "invalid-invocation";
  const cause = rawCause === "admission-failed"
    || rawCause === "invalid-realization-outcome"
    || rawCause === "revoked"
    || rawCause === "invalid-input"
    || rawCause === "request-failed"
    || rawCause === "realization-failed"
    || rawCause === "invalid-invocation"
    ? rawCause
    : "realization-failed";
  // A fault's certainty passes through unchanged. Collapsing `not-completed`
  // into `not-started` would claim the effect never began when the
  // dispatcher proved only that it did not finish.
  throw new InteractionFault(
    cause,
    outcome.certainty === "completed" ? "unknown" : outcome.certainty,
    "interaction invocation failed",
  );
}

function argsForTyped(
  handle: ProjectedInteractionHandle,
  args: readonly unknown[],
): { input: unknown; context: unknown } {
  if (handle.inputArity === 0) {
    return { input: null, context: args[0] };
  }
  return { input: args[0], context: args[1] };
}

export function createCaller<Context>(binding: ProjectionBinding<any, Context>) {
  const metadata = bindingMetadata.get(binding)! as BindingMetadata<Context>;
  const handles = (metadata.projection as import("./types").Projection<any>).handles as Record<string, ProjectedInteractionHandle>;
  const caller: Record<string, unknown> = {
    async call(handle: ProjectedInteractionHandle, ...args: readonly unknown[]) {
      const projected = metadataForProjectedHandle(handle);
      if (!projected || projected.projection !== metadata.projection) {
        throw new InteractionFault(
          "invalid-invocation",
          "not-started",
          "caller requires a handle from its Projection",
        );
      }
      const { input, context } = argsForTyped(handle, args);
      const resolved = binding.resolve(handle.interactionId);
      if (!resolved) {
        throw new InteractionFault(
          "invalid-invocation",
          "not-started",
          "projected interaction is not bound",
        );
      }
      const outcome = await rawInvoke(
        binding,
        resolved,
        "direct",
        input,
        context as Context,
      );
      if (outcome.result.kind === "returned") return outcome.result.value;
      return throwTyped(outcome);
    },
    async callRaw(
      interaction: ResolvedBindingInteraction,
      input: unknown,
      context?: Context,
    ) {
      return rawInvoke(binding, interaction, "direct", input, context as Context);
    },
  };
  const direct: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
  const tryDirect: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
  for (const [alias, handle] of Object.entries(handles)) {
    if (!handle.modes.includes("direct")) continue;
    const resolved = binding.resolve(handle.interactionId);
    const zeroArity = handle.inputArity === 0;
    Object.defineProperty(direct, alias, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: async (...args: readonly unknown[]) => {
        if (!resolved) {
          throw new InteractionFault("invalid-invocation", "not-started", "projected interaction is not bound");
        }
        const input = zeroArity ? null : args[0];
        const context = (zeroArity ? args[0] : args[1]) as Context;
        const outcome = await rawInvoke(binding, resolved, "direct", input, context);
        if (outcome.result.kind === "returned") return outcome.result.value;
        return throwTyped(outcome);
      },
    });
    Object.defineProperty(tryDirect, alias, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: async (...args: readonly unknown[]) => {
        try {
          if (!resolved) throw new InteractionFault("invalid-invocation", "not-started", "projected interaction is not bound");
          const input = zeroArity ? null : args[0];
          const context = (zeroArity ? args[0] : args[1]) as Context;
          return outcomeRecord(await rawInvoke(binding, resolved, "direct", input, context));
        } catch (error) {
          const fault = error instanceof InteractionFault ? error : new InteractionFault("realization-failed", "unknown", "interaction invocation failed");
          return Object.freeze({ kind: "fault", cause: fault.cause, certainty: fault.certainty, message: fault.message });
        }
      },
    });
  }
  caller.direct = Object.freeze(direct);
  caller.try = Object.freeze(tryDirect);
  if (
    [...metadata.interactions.values()].some((interaction) =>
      interaction.byMode.has("request"),
    )
  ) {
    caller.request = async (
      handle: ProjectedInteractionHandle,
      ...args: readonly unknown[]
    ) => {
      const projected = metadataForProjectedHandle(handle);
      if (!projected || projected.projection !== metadata.projection) {
        throw new InteractionFault(
          "invalid-invocation",
          "not-started",
          "caller requires a handle from its Projection",
        );
      }
      const { input, context } = argsForTyped(handle, args);
      const resolved = binding.resolve(handle.interactionId)!;
      const outcome = await rawInvoke(
        binding,
        resolved,
        "request",
        input,
        context as Context,
      );
      if (outcome.result.kind === "proposed") return outcome.result.proposal;
      return throwTyped(outcome);
    };
    caller.requestRaw = async (
      interaction: ResolvedBindingInteraction,
      input: unknown,
      context?: Context,
    ) => rawInvoke(binding, interaction, "request", input, context as Context);
    const requests: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
    const tryRequests: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
    for (const [alias, handle] of Object.entries(handles)) {
      if (!handle.modes.includes("request")) continue;
      const resolved = binding.resolve(handle.interactionId);
      const zeroArity = handle.inputArity === 0;
      Object.defineProperty(requests, alias, {
        enumerable: true,
        configurable: false,
        writable: false,
        value: async (...args: readonly unknown[]) => {
          if (!resolved) {
            throw new InteractionFault("invalid-invocation", "not-started", "projected interaction is not bound");
          }
          const input = zeroArity ? null : args[0];
          const context = (zeroArity ? args[0] : args[1]) as Context;
          const outcome = await rawInvoke(binding, resolved, "request", input, context);
          if (outcome.result.kind === "proposed") return outcome.result.proposal;
          return throwTyped(outcome);
        },
      });
      Object.defineProperty(tryRequests, alias, {
        enumerable: true,
        configurable: false,
        writable: false,
        value: async (...args: readonly unknown[]) => {
          try {
            if (!resolved) throw new InteractionFault("invalid-invocation", "not-started", "projected interaction is not bound");
            const input = zeroArity ? null : args[0];
            const context = (zeroArity ? args[0] : args[1]) as Context;
            return outcomeRecord(await rawInvoke(binding, resolved, "request", input, context));
          } catch (error) {
            const fault = error instanceof InteractionFault ? error : new InteractionFault("request-failed", "unknown", "interaction request failed");
            return Object.freeze({ kind: "fault", cause: fault.cause, certainty: fault.certainty, message: fault.message });
          }
        },
      });
    }
    caller.requests = Object.freeze(requests);
    caller.tryRequest = Object.freeze(tryRequests);
  }
  return Object.freeze(caller);
}
