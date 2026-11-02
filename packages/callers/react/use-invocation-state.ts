"use client";

import type { AnyInteractionDefinition, DefinitionArity, DefinitionInput, DefinitionOutput } from "@foxworth/boundary";
import type { InteractionHandle, SurfaceHandle } from "@foxworth/boundary/pipeline";
import type { SurfaceClient } from "@foxworth/boundary/client";
import {
  createInvocationState,
  createProposalInteraction,
  type AuthorizedStatusReader,
  type InvocationStateSnapshot,
  type ProposalStatusSnapshot,
} from "@foxworth/boundary/client";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useInteractionCacheScope } from "./cache-scope";

type AnySurfaceHandle = SurfaceHandle<any, any, any>;
type DefinitionOf<Handle> = Handle extends SurfaceHandle<
  InteractionHandle<infer Definition>,
  any
> ? Definition : AnyInteractionDefinition;
type InteractionArguments<Handle extends AnySurfaceHandle> =
  DefinitionArity<DefinitionOf<Handle>> extends 0
    ? readonly []
    : readonly [input: DefinitionInput<DefinitionOf<Handle>>];
type InteractionOutput<Handle extends AnySurfaceHandle, Mode extends "direct" | "request"> =
  Mode extends "direct"
    ? DefinitionOutput<DefinitionOf<Handle>>
    : Handle extends SurfaceHandle<any, any, infer RequestOutput>
      ? RequestOutput
      : never;
type HandleForMode<Handle extends AnySurfaceHandle, Mode extends "direct" | "request"> =
  Handle & (Mode extends Handle["modes"][number] ? unknown : never);

function useDeferredDispose(dispose: () => void): void {
  const pending = useRef<Readonly<{
    dispose: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> | undefined>(undefined);
  useEffect(() => {
    if (pending.current?.dispose === dispose) {
      clearTimeout(pending.current.timer);
      pending.current = undefined;
    }
    return () => {
      const record = {
        dispose,
        timer: setTimeout(() => {
          if (pending.current === record) pending.current = undefined;
          dispose();
        }, 0),
      };
      pending.current = record;
    };
  }, [dispose]);
}

function keyFor(handle: AnySurfaceHandle): string {
  return `${handle.interactionId}\n${handle.contractDigest}\n${handle.inputArity}\n${handle.modes.join(",")}`;
}

/**
 * React adaptation of the framework-neutral explicit invocation store. It is
 * inert on mount; the application calls `invoke` from its own event handler.
 */
export function useInvocationState<
  Handle extends AnySurfaceHandle,
  Mode extends "direct" | "request",
>(
  client: SurfaceClient,
  handle: HandleForMode<Handle, Mode>,
  mode: Mode,
): InvocationStateSnapshot<Handle, Mode> & Readonly<{
  invoke: (...args: InteractionArguments<Handle>) => Promise<InteractionOutput<Handle, Mode>>;
  markStale(): void;
  disconnect(): void;
}> {
  const scope = useInteractionCacheScope();
  const handleKey = keyFor(handle);
  const interaction = useMemo(
    () => createInvocationState<Handle, Mode>(client, handle, mode, { scope }),
    [client, handleKey, mode, scope],
  );
  useDeferredDispose(interaction.dispose);
  const state = useSyncExternalStore(
    interaction.subscribe,
    interaction.getSnapshot,
    interaction.getSnapshot,
  );
  return Object.freeze({
    ...state,
    invoke: interaction.invoke,
    markStale: interaction.markStale,
    disconnect: interaction.disconnect,
  });
}

/**
 * Request-mode interaction with a caller-supplied, public-only status reader.
 * The hook does not create a Control client, expose records, or observe on its
 * own; call `observe` explicitly for a returned proposal.
 */
export function useProposalInteraction<
  Handle extends AnySurfaceHandle,
  Status,
>(
  client: SurfaceClient,
  handle: HandleForMode<Handle, "request">,
  observeStatus: AuthorizedStatusReader<InteractionOutput<Handle, "request">, Status>,
): Readonly<{
  invocation: InvocationStateSnapshot<Handle, "request">;
  status: ProposalStatusSnapshot<InteractionOutput<Handle, "request">, Status>;
  request: (...args: InteractionArguments<Handle>) => Promise<InteractionOutput<Handle, "request">>;
  observe(proposal: InteractionOutput<Handle, "request">): Promise<Status>;
  markStale(): void;
  disconnect(): void;
}> {
  const handleKey = keyFor(handle);
  const statusReader = useRef(observeStatus);
  statusReader.current = observeStatus;
  const interaction = useMemo(
    () => createProposalInteraction<Handle, Status>(
      client,
      handle,
      (proposal) => statusReader.current(proposal),
    ),
    [client, handleKey],
  );
  useDeferredDispose(interaction.dispose);
  const invocation = useSyncExternalStore(
    interaction.invocation.subscribe,
    interaction.invocation.getSnapshot,
    interaction.invocation.getSnapshot,
  );
  const status = useSyncExternalStore(
    interaction.subscribeStatus,
    interaction.getStatusSnapshot,
    interaction.getStatusSnapshot,
  );
  return Object.freeze({
    invocation,
    status,
    request: interaction.invocation.invoke,
    observe: interaction.observe,
    markStale: interaction.markStale,
    disconnect: interaction.disconnect,
  });
}
