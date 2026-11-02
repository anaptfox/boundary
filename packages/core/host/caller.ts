import { restoreDeclaredInteractionError } from "./definitions";
import { InteractionFault, failHost } from "./errors";
import { metadataForProjectedHandle } from "./projection";
import type { CallerOfBinding } from "./facade-types";
import type { Projection, ProjectedInteractionHandle, ProjectionBinding, RawInvocationOutcome, ResolvedBindingInteraction } from "./types";
import { BindingMetadata, bindingMetadata } from "./binding-state";
import { rawInvoke } from "./dispatch";

const RESERVED_CALLER_KEYS: readonly string[] = ["propose", "manifest", "handoff", "then"];

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

/** The handle-based caller behind `binding.connect()`: `call(handle, ...)` and `request(handle, ...)`. */
export function createHandleCaller<Context>(binding: ProjectionBinding<any, Context>) {
  const metadata = bindingMetadata.get(binding)! as BindingMetadata<Context>;
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
  }
  return Object.freeze(caller);
}

function defineOwn(record: object, key: string, value: unknown, enumerable: boolean): void {
  Object.defineProperty(record, key, { value, enumerable, configurable: false, writable: false });
}

/**
 * The caller a host hands to adapters: one method per direct-mode alias,
 * `propose.<alias>` per request-mode alias, the read-only Binding manifest,
 * and the Handoff seam. It carries no controller. The short path's `connect`
 * returns exactly this value; pipeline users build it from their own Binding.
 */
export function createCaller<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle>>,
  Context,
>(binding: ProjectionBinding<Handles, Context>): CallerOfBinding<Handles, Context> {
  const metadata = bindingMetadata.get(binding) as BindingMetadata<Context> | undefined;
  if (metadata === undefined) {
    return failHost("INVALID_ARTIFACT", "createCaller.binding",
      "expected an authentic bound ProjectionBinding; found another value; fix: pass the binding returned by bindProjection or restrictBinding");
  }
  const low = createHandleCaller(binding) as Readonly<{
    call(handle: ProjectedInteractionHandle, ...args: readonly unknown[]): Promise<unknown>;
    request?(handle: ProjectedInteractionHandle, ...args: readonly unknown[]): Promise<unknown>;
  }>;
  const handles = (metadata.projection as Projection).handles;
  const caller = Object.create(null) as Record<string, unknown>;
  const propose = Object.create(null) as Record<string, unknown>;
  // Methods follow the Projection's declaration order, not the manifest's sorted order.
  for (const alias of Object.keys(handles)) {
    if (RESERVED_CALLER_KEYS.includes(alias)) {
      return failHost("INVALID_PROJECTION", `createCaller.${alias}`,
        `expected an alias that can be a caller method; found reserved name "${alias}"; fix: rename the alias in the Projection`);
    }
    const handle = Object.getOwnPropertyDescriptor(handles, alias)?.value as ProjectedInteractionHandle;
    for (const interaction of binding.manifest.interactions) {
      if (interaction.alias !== alias) continue;
      if (interaction.mode === "direct") {
        defineOwn(caller, alias, (...args: readonly unknown[]) => low.call(handle, ...args), true);
      } else {
        defineOwn(propose, alias, (...args: readonly unknown[]) => low.request!(handle, ...args), true);
      }
    }
  }
  // Non-enumerable, so Object.keys(caller) lists exactly the call aliases.
  defineOwn(caller, "propose", Object.freeze(propose), false);
  defineOwn(caller, "manifest", binding.manifest, false);
  defineOwn(caller, "handoff", Object.freeze({
    manifest: binding.manifest,
    resolve: (interactionId: string) => binding.resolve(interactionId),
    invoke: (invocation: never, context: Context) =>
      (binding.invoke as unknown as (...args: unknown[]) => Promise<RawInvocationOutcome>)(invocation, context),
  }), false);
  return Object.freeze(caller) as unknown as CallerOfBinding<Handles, Context>;
}
