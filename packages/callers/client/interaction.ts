import type {
  AnyInteractionDefinition,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  InteractionHandle,
  ProjectedInteractionHandle,
} from "@foxworth/boundary";
import type { ProjectionClient } from "./client";
import { AdapterError, type RemoteInteractionError } from "#remote";
import { invalidateReadsForChange, type InteractionCacheScope } from "./cache";
import { snapshotProjectedHandle, type AnyProjectedInteractionHandle } from "#remote";

type DefinitionOf<Handle> = Handle extends ProjectedInteractionHandle<
  InteractionHandle<infer Definition>,
  any
> ? Definition : AnyInteractionDefinition;
type HandleInput<Handle extends AnyProjectedInteractionHandle> = DefinitionInput<DefinitionOf<Handle>>;
type HandleOutput<Handle extends AnyProjectedInteractionHandle> = DefinitionOutput<DefinitionOf<Handle>>;
type HandleArity<Handle extends AnyProjectedInteractionHandle> = DefinitionArity<DefinitionOf<Handle>>;
type InteractionArguments<Handle extends AnyProjectedInteractionHandle> =
  HandleArity<Handle> extends 0 ? readonly [] : readonly [input: HandleInput<Handle>];
type HandleForMode<Handle extends AnyProjectedInteractionHandle, Mode extends "direct" | "request"> =
  Handle & (Mode extends Handle["modes"][number] ? unknown : never);
type InteractionOutput<Handle extends AnyProjectedInteractionHandle, Mode extends "direct" | "request"> =
  Mode extends "direct" ? HandleOutput<Handle> : Handle extends ProjectedInteractionHandle<any, any, infer RequestOutput>
    ? RequestOutput
    : never;

export type InteractionPhase = "idle" | "pending" | "succeeded" | "failed" | "uncertain" | "stale" | "disconnected" | "disposed";

/** Client-local state; it is not an authoritative host lifecycle record. */
export type InvocationStateSnapshot<
  Handle extends AnyProjectedInteractionHandle,
  Mode extends "direct" | "request",
> = Readonly<{
  /** Latest attempt evidence; connection changes do not overwrite it. */
  phase: InteractionPhase;
  /** Invocation gating, independent of the outcome of an existing attempt. */
  availability: "available" | "stale" | "disconnected" | "disposed";
  result: InteractionOutput<Handle, Mode> | undefined;
  error: RemoteInteractionError<Handle> | Error | undefined;
  isPending: boolean;
}>;

export type InvocationStateOptions = Readonly<{
  /** Share only completed direct-change invalidation with this explicit scope. */
  scope?: InteractionCacheScope;
}>;

/**
 * An inert, explicit invocation store. It neither invokes on creation nor
 * retries after a lost response. A stale or disconnected store stays blocked;
 * create a fresh store around a newly authorized client to continue.
 */
export type InvocationState<
  Handle extends AnyProjectedInteractionHandle,
  Mode extends "direct" | "request",
> = Readonly<{
  getSnapshot(): InvocationStateSnapshot<Handle, Mode>;
  subscribe(listener: () => void): () => void;
  invoke(...args: InteractionArguments<Handle>): Promise<InteractionOutput<Handle, Mode>>;
  markStale(): void;
  disconnect(): void;
  dispose(): void;
}>;

function snapshot<Handle extends AnyProjectedInteractionHandle, Mode extends "direct" | "request">(
  phase: InteractionPhase,
  result: InteractionOutput<Handle, Mode> | undefined,
  error: RemoteInteractionError<Handle> | Error | undefined,
  availability: InvocationStateSnapshot<Handle, Mode>["availability"] = "available",
): InvocationStateSnapshot<Handle, Mode> {
  return Object.freeze({ phase, availability, result, error, isPending: phase === "pending" });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createInvocationState<
  Handle extends AnyProjectedInteractionHandle,
  Mode extends "direct" | "request",
>(
  client: ProjectionClient,
  handleValue: HandleForMode<Handle, Mode>,
  mode: Mode,
  options: InvocationStateOptions = {},
): InvocationState<Handle, Mode> {
  const handle = snapshotProjectedHandle(handleValue, "createInvocationState.handle") as Handle;
  if (!handle.modes.includes(mode)) {
    throw new AdapterError("INTERACTION_NOT_EXPOSED", handle.interactionId, `${mode} is absent from the projected handle`);
  }
  let current = snapshot<Handle, Mode>("idle", undefined, undefined);
  let active = false;
  const listeners = new Set<() => void>();

  const publish = (next: InvocationStateSnapshot<Handle, Mode>) => {
    current = next;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Subscribers cannot revise invocation truth. */ }
    }
  };
  const blocked = () => {
    if (current.availability !== "available") return current.availability;
    return undefined;
  };

  return Object.freeze({
    getSnapshot: () => current,
    subscribe(listener) {
      if (current.availability === "disposed") throw new Error("interaction interaction was disposed");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async invoke(...args) {
      const state = blocked();
      if (state !== undefined) {
        return Promise.reject(new Error(`interaction interaction is ${state}; create a fresh interaction before invoking again`));
      }
      if (active) return Promise.reject(new Error("interaction interaction already has an invocation in flight"));
      active = true;
      publish(snapshot<Handle, Mode>("pending", current.result, undefined, current.availability));
      try {
        const value = (mode === "direct"
          ? await (client.call as (...callArgs: readonly unknown[]) => Promise<unknown>)(handle, ...args)
          : await (client.request as (...callArgs: readonly unknown[]) => Promise<unknown>)(handle, ...args)
        ) as InteractionOutput<Handle, Mode>;
        if (mode === "direct") {
          void invalidateReadsForChange(client, handle, options.scope).catch(() => {
            // A completed invocation remains completed if a later read refresh fails.
          });
        }
        // Settle this original attempt even if its view can no longer invoke.
        publish(snapshot<Handle, Mode>("succeeded", value, undefined, current.availability));
        return value;
      } catch (caught) {
        const error = asError(caught) as RemoteInteractionError<Handle> | Error;
        const phase = (error as { certainty?: unknown }).certainty === "unknown" ? "uncertain" : error instanceof AdapterError && (
          error.code === "STALE_BINDING" || error.code === "STALE_CONTRACT" || error.code === "STALE_REFERENCE"
        ) ? "stale" : "failed";
        const availability = phase === "stale" && current.availability === "available" ? "stale" : current.availability;
        publish(snapshot<Handle, Mode>(phase, current.result, error, availability));
        throw error;
      } finally {
        active = false;
      }
    },
    markStale() {
      if (current.availability !== "disposed") {
        publish(snapshot<Handle, Mode>(current.phase === "idle" ? "stale" : current.phase, current.result, current.error, "stale"));
      }
    },
    disconnect() {
      if (current.availability !== "disposed") {
        publish(snapshot<Handle, Mode>(current.phase === "idle" ? "disconnected" : current.phase, current.result, current.error, "disconnected"));
      }
    },
    dispose() {
      if (current.availability === "disposed") return;
      // Owners of dependent views observe retirement before listeners detach.
      publish(snapshot<Handle, Mode>(current.phase === "idle" ? "disposed" : current.phase, current.result, current.error, "disposed"));
      listeners.clear();
    },
  });
}

/** A host-issued public-read function, narrowed to observation only. */
export type AuthorizedStatusReader<Proposal, Status> = (proposal: Proposal) => Promise<Status>;

export type ProposalStatusSnapshot<Proposal, Status> = Readonly<{
  proposal: Proposal | undefined;
  status: Status | undefined;
  error: Error | undefined;
  isPending: boolean;
}>;

export type ProposalInteraction<Handle extends AnyProjectedInteractionHandle, Status> = Readonly<{
  invocation: InvocationState<Handle, "request">;
  getStatusSnapshot(): ProposalStatusSnapshot<InteractionOutput<Handle, "request">, Status>;
  subscribeStatus(listener: () => void): () => void;
  observe(proposal: InteractionOutput<Handle, "request">): Promise<Status>;
  markStale(): void;
  disconnect(): void;
  dispose(): void;
}>;

/**
 * Explicit proposal submission plus observation through a host-authorized
 * public reader. Its function type does not establish authorization or
 * redaction; the host must supply an authenticated public-only reader.
 */
export function createProposalInteraction<
  Handle extends AnyProjectedInteractionHandle,
  Status = unknown,
>(
  client: ProjectionClient,
  handle: HandleForMode<Handle, "request">,
  observeStatus: AuthorizedStatusReader<InteractionOutput<Handle, "request">, Status>,
): ProposalInteraction<Handle, Status> {
  if (typeof observeStatus !== "function") throw new TypeError("a public status reader function is required");
  const invocation = createInvocationState(client, handle, "request");
  let disposed = false;
  let generation = 0;
  let current: ProposalStatusSnapshot<InteractionOutput<Handle, "request">, Status> = Object.freeze({ proposal: undefined, status: undefined, error: undefined, isPending: false });
  const listeners = new Set<() => void>();
  const publish = (next: ProposalStatusSnapshot<InteractionOutput<Handle, "request">, Status>) => {
    if (disposed) return;
    current = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A view cannot revise observed evidence. */ }
    }
  };
  const stopRetirement = invocation.subscribe(() => {
    const availability = invocation.getSnapshot().availability;
    if (availability === "available") return;
    generation += 1;
    if (current.proposal !== undefined || current.status !== undefined || current.error !== undefined || current.isPending) {
      publish({ proposal: undefined, status: undefined, error: undefined, isPending: false });
    }
    if (availability === "disposed") {
      disposed = true;
      listeners.clear();
      stopRetirement();
    }
  });
  return Object.freeze({
    invocation,
    getStatusSnapshot: () => current,
    subscribeStatus(listener) {
      if (disposed) throw new Error("proposal interaction was disposed");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async observe(proposal) {
      if (disposed) return Promise.reject(new Error("proposal interaction was disposed"));
      const availability = invocation.getSnapshot().availability;
      if (availability !== "available") {
        return Promise.reject(new Error(`proposal interaction is ${availability}; create a fresh interaction before observing again`));
      }
      const mine = ++generation;
      publish({ proposal, status: undefined, error: undefined, isPending: true });
      try {
        const status = await observeStatus(proposal);
        if (!disposed && mine === generation && invocation.getSnapshot().availability === "available") publish({ proposal, status, error: undefined, isPending: false });
        return status;
      } catch (caught) {
        const error = asError(caught);
        if (!disposed && mine === generation && invocation.getSnapshot().availability === "available") publish({ proposal, status: undefined, error, isPending: false });
        throw error;
      }
    },
    markStale() { invocation.markStale(); },
    disconnect() { invocation.disconnect(); },
    dispose() { invocation.dispose(); },
  });
}
