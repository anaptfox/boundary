"use client";

import type {
  AnyInteractionDefinition,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  InteractionHandle,
  ProjectedInteractionHandle,
} from "@foxworth/boundary";
import type { ProjectionClient } from "@foxworth/boundary/client";
import {
  AdapterError,
  RemoteDomainError,
  RemoteExecutionError,
  RemoteInvocationError,
  RemoteProtocolError,
} from "#remote";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  footprintsFor,
  isReadInteraction,
  watchInteraction,
  type InteractionRead,
  type InteractionReadError,
  type InteractionReadSnapshot,
} from "@foxworth/boundary/client";
import { useInteractionCacheScope } from "./cache-scope";
import { useInvocationState } from "./use-invocation-state";

type AnyProjectedInteractionHandle = ProjectedInteractionHandle<any, any>;
type DefinitionOf<Handle> = Handle extends ProjectedInteractionHandle<
  InteractionHandle<infer Definition>,
  any
>
  ? Definition
  : AnyInteractionDefinition;
type HandleInput<Handle extends AnyProjectedInteractionHandle> = DefinitionInput<
  DefinitionOf<Handle>
>;
type HandleOutput<Handle extends AnyProjectedInteractionHandle> = DefinitionOutput<
  DefinitionOf<Handle>
>;
type HandleArity<Handle extends AnyProjectedInteractionHandle> = DefinitionArity<
  DefinitionOf<Handle>
>;
type HandleArguments<Handle extends AnyProjectedInteractionHandle> =
  HandleArity<Handle> extends 0
    ? readonly []
    : readonly [input: HandleInput<Handle>];
type CallArguments<Handle extends AnyProjectedInteractionHandle> =
  | readonly []
  | HandleArguments<Handle>;
type DirectHandle<Handle extends AnyProjectedInteractionHandle> = Handle &
  ("direct" extends Handle["modes"][number] ? unknown : never);

export type UseInteractionError<Value extends AnyProjectedInteractionHandle> =
  InteractionReadError<Value>;

export type UseInteractionResult<Value extends AnyProjectedInteractionHandle> = Readonly<{
  data: HandleOutput<Value> | undefined;
  error: UseInteractionError<Value> | undefined;
  isPending: boolean;
  refetch: (
    ...args: HandleArguments<Value>
  ) => Promise<HandleOutput<Value>>;
  call: (
    ...args: HandleArguments<Value>
  ) => Promise<HandleOutput<Value>>;
}>;

export type InteractionErrorKind = "domain" | "protocol" | "execution" | "unknown";

export type DescribedInteractionError = Readonly<{
  kind: InteractionErrorKind;
  message: string;
}>;

/** Distinguish declared domain errors from sanitized protocol failures. */
export function describeInteractionError(error: unknown): DescribedInteractionError {
  if (
    (error instanceof RemoteInvocationError || error instanceof RemoteExecutionError || error instanceof RemoteProtocolError)
    && error.certainty === "unknown"
  ) {
    return {
      kind: "unknown",
      message: "The interaction consequence is unknown. Reconcile before retrying.",
    };
  }
  if (error instanceof RemoteDomainError) {
    return {
      kind: "domain",
      message: `Declared domain error: ${JSON.stringify(error.value)}`,
    };
  }
  if (error instanceof RemoteProtocolError || error instanceof AdapterError) {
    return { kind: "protocol", message: error.message };
  }
  if (error instanceof RemoteExecutionError) {
    return { kind: "execution", message: error.message };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "The interaction failed.",
  };
}

function asInteractionError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

export function useInteraction<Value extends AnyProjectedInteractionHandle>(
  client: ProjectionClient,
  handle: DirectHandle<Value>,
  ...args: [] | HandleArguments<Value>
): UseInteractionResult<Value> {
  const cacheScope = useInteractionCacheScope();
  const handleKey = `${handle.interactionId}\n${handle.contractDigest}\n${handle.inputArity}\n${handle.modes.join(",")}`;
  const lifetime = useMemo(() => ({ active: true }), [client, handleKey, cacheScope]);
  const argsRef = useRef<CallArguments<Value>>(args);
  const readRef = useRef<InteractionRead<Value> | undefined>(undefined);
  const routeRef = useRef<"unknown" | "read" | "change" | "failed">("unknown");
  const pendingCalls = useRef<Array<{
    args: CallArguments<Value>;
    resolve: (value: HandleOutput<Value>) => void;
    reject: (error: unknown) => void;
  }>>([]);
  const [route, setRoute] = useState<"unknown" | "read" | "change" | "failed">("unknown");
  const [read, setRead] = useState<InteractionRead<Value> | undefined>(undefined);
  const [routeError, setRouteError] = useState<UseInteractionError<Value> | undefined>(undefined);
  const mutation = useInvocationState<Value, "direct">(client, handle, "direct");

  const argKey = JSON.stringify(args[0] ?? null);
  const lastArgKey = useRef(argKey);

  useEffect(() => {
    if (lastArgKey.current !== argKey) {
      lastArgKey.current = argKey;
      argsRef.current = args;
    }
  });

  const createRead = useCallback((callArgs: CallArguments<Value>) => {
    const watch = watchInteraction as (
      client: ProjectionClient,
      handle: DirectHandle<Value>,
      ...input: readonly unknown[]
    ) => InteractionRead<Value>;
    return handle.inputArity === 0
      ? watch(client, handle, { scope: cacheScope })
      : watch(client, handle, callArgs[0], { scope: cacheScope });
  }, [client, handleKey, cacheScope]);

  const invokeMutation = mutation.invoke;
  const invokeChange = useCallback((callArgs: CallArguments<Value>) => {
    const invoke = invokeMutation as (...args: CallArguments<Value>) => Promise<HandleOutput<Value>>;
    return invoke(...callArgs);
  }, [invokeMutation]);

  const emptyReadSnapshot = useMemo<InteractionReadSnapshot<Value>>(
    () => Object.freeze({ data: undefined, error: undefined, isPending: false }),
    [],
  );
  const subscribe = useCallback(
    (listener: () => void) => read?.subscribe(listener) ?? (() => {}),
    [read],
  );
  const getReadSnapshot = useCallback(
    () => read?.getSnapshot() ?? emptyReadSnapshot,
    [read, emptyReadSnapshot],
  );
  const watched = useSyncExternalStore(subscribe, getReadSnapshot, getReadSnapshot);

  const flushPendingCalls = useCallback((nextRoute: "read" | "change") => {
    const calls = pendingCalls.current.splice(0);
    for (const pending of calls) {
      try {
        const outcome = nextRoute === "read"
          ? (() => {
              const current = readRef.current;
              if (!current) return Promise.reject(new Error("interaction read was not initialized"));
              if (pending.args.length > 0) {
                argsRef.current = pending.args;
                const replacement = createRead(pending.args);
                current.dispose();
                readRef.current = replacement;
                setRead(replacement);
                return replacement.refresh();
              }
              return current.refresh();
            })()
          : invokeChange(pending.args);
        void outcome.then(pending.resolve, pending.reject);
      } catch (error) {
        pending.reject(error);
      }
    }
  }, [createRead, invokeChange]);

  useEffect(() => {
    lifetime.active = true;
    routeRef.current = "unknown";
    setRoute("unknown");
    setRouteError(undefined);
    let cancelled = false;
    let created: InteractionRead<Value> | undefined;
    void footprintsFor(client).then((footprints) => {
      if (cancelled) return;
      if (!isReadInteraction(footprints, handle.interactionId)) {
        readRef.current?.dispose();
        readRef.current = undefined;
        setRead(undefined);
        routeRef.current = "change";
        setRoute("change");
        setRouteError(undefined);
        flushPendingCalls("change");
        return;
      }
      if (argsRef.current.length !== handle.inputArity) {
        routeRef.current = "failed";
        setRoute("failed");
        const error =
          new AdapterError(
            "INVALID_REQUEST",
            `${handle.interactionId}.args`,
            "this read requires arguments; pass them to useInteraction",
          );
        setRouteError(error);
        for (const pending of pendingCalls.current.splice(0)) pending.reject(error);
        return;
      }
      created = createRead(argsRef.current);
      readRef.current?.dispose();
      readRef.current = created;
      setRead(created);
      routeRef.current = "read";
      setRoute("read");
      setRouteError(undefined);
      flushPendingCalls("read");
    }).catch((caught: unknown) => {
      if (!cancelled) {
        const error = asInteractionError(caught);
        routeRef.current = "failed";
        setRoute("failed");
        setRouteError(error);
        for (const pending of pendingCalls.current.splice(0)) pending.reject(error);
      }
    });

    return () => {
      cancelled = true;
      lifetime.active = false;
      routeRef.current = "unknown";
      const error = new Error("interaction view was disposed or replaced before invocation");
      for (const pending of pendingCalls.current.splice(0)) pending.reject(error);
      if (readRef.current === created) {
        created?.dispose();
        readRef.current = undefined;
      }
    };
  }, [client, handleKey, argKey, createRead, flushPendingCalls, lifetime]);

  useEffect(() => () => {
    readRef.current?.dispose();
    readRef.current = undefined;
  }, []);

  const refetch = useCallback(async (...callArgs: CallArguments<Value>) => {
    if (!lifetime.active) return Promise.reject(new Error("interaction view was disposed or replaced"));
    if (callArgs.length > 0) argsRef.current = callArgs;
    const next: CallArguments<Value> = callArgs.length > 0 || handle.inputArity === 0
      ? callArgs
      : argsRef.current;
    if (routeRef.current === "read" && readRef.current) {
      if (callArgs.length === 0) return readRef.current.refresh();
      const replacement = createRead(next);
      readRef.current.dispose();
      readRef.current = replacement;
      setRead(replacement);
      return replacement.refresh();
    }
    if (routeRef.current === "change") return invokeChange(next);
    if (routeRef.current === "failed") return Promise.reject(routeError ?? new Error("interaction route failed"));
    return new Promise<HandleOutput<Value>>((resolve, reject) => {
      pendingCalls.current.push({ args: next, resolve, reject });
    });
  }, [createRead, handleKey, invokeChange, routeError, lifetime]);

  return {
    data: route === "read" ? watched.data : mutation.result,
    error: routeError ?? (route === "read" ? watched.error : mutation.error),
    isPending: route === "unknown"
      ? argsRef.current.length === handle.inputArity
      : route === "read" ? watched.isPending : mutation.isPending,
    refetch,
    call: refetch,
  };
}
