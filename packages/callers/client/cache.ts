import type {
  ProjectedInteractionHandle,
  ProjectionBindingManifest,
} from "@foxworth/boundary";
import type { ProjectionClient } from "./client";
import { normalizeJson, validateInvocationObservation, type JsonValue } from "@foxworth/boundary/program";
import { AdapterError, type RemoteInteractionError } from "@foxworth/boundary/remote";
import type { InteractionInput, InteractionOutput } from "@foxworth/boundary/remote";
import {
  snapshotProjectedHandle,
  type AnyProjectedInteractionHandle,
} from "@foxworth/boundary/remote";

export type InteractionFootprint = Readonly<{
  reads: readonly string[];
  changes: readonly string[];
}>;

export type FootprintSource = Readonly<{
  expectedProgram: Readonly<{
    interactions: readonly Readonly<{
      contract: Readonly<{
        id: string;
        reads: readonly string[];
        changes: readonly string[];
      }>;
    }>[];
  }>;
}>;

type MountedRead = Readonly<{
  client: ProjectionClient;
  interactionId: string;
  refresh: () => Promise<void>;
}>;

type ClientCache = {
  handshake: Promise<ProjectionBindingManifest>;
  footprints?: ReadonlyMap<string, InteractionFootprint>;
};

export type InteractionCacheScope = Readonly<{
  /** Opaque identity; create scopes with createInteractionCacheScope(). */
  readonly kind: "boundary-interaction-cache-scope";
}>;

type DirectHandle<Handle extends AnyProjectedInteractionHandle> = Handle &
  ("direct" extends Handle["modes"][number] ? unknown : never);

type WatchInteractionArguments<Handle extends AnyProjectedInteractionHandle> =
  Handle["inputArity"] extends 0
    ? readonly [options?: WatchInteractionOptions]
    : readonly [input: InteractionInput<Handle>, options?: WatchInteractionOptions];

export type WatchInteractionOptions = Readonly<{
  /** Share invalidation only with readers registered in this explicit scope. */
  scope?: InteractionCacheScope;
}>;

export type InteractionReadError<Handle extends AnyProjectedInteractionHandle> =
  | RemoteInteractionError<Handle>
  | Error;

export type InteractionReadSnapshot<Handle extends AnyProjectedInteractionHandle> = Readonly<{
  data: InteractionOutput<Handle> | undefined;
  error: InteractionReadError<Handle> | undefined;
  isPending: boolean;
}>;

/** A framework-neutral, lifecycle-owned read of one direct projected interaction. */
export type InteractionRead<Handle extends AnyProjectedInteractionHandle> = Readonly<{
  getSnapshot(): InteractionReadSnapshot<Handle>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<InteractionOutput<Handle>>;
  dispose(): void;
}>;

const caches = new WeakMap<ProjectionClient, ClientCache>();
const scopeReads = new WeakMap<InteractionCacheScope, Set<MountedRead>>();
const clientScopes = new WeakMap<ProjectionClient, InteractionCacheScope>();

export function createInteractionCacheScope(): InteractionCacheScope {
  const scope = Object.freeze({ kind: "boundary-interaction-cache-scope" as const });
  scopeReads.set(scope, new Set());
  return scope;
}

function scopeFor(
  client: ProjectionClient,
  scope?: InteractionCacheScope,
): InteractionCacheScope {
  if (scope) {
    if (!scopeReads.has(scope)) throw new TypeError("an authentic interaction cache scope is required");
    return scope;
  }
  const existing = clientScopes.get(client);
  if (existing) return existing;
  const created = createInteractionCacheScope();
  clientScopes.set(client, created);
  return created;
}

function cacheFor(client: ProjectionClient): ClientCache {
  const existing = caches.get(client);
  if (existing) return existing;
  const created = {} as ClientCache;
  created.handshake = Promise.resolve()
    .then(() => client.inspect())
    .catch((error: unknown) => {
      if (caches.get(client) === created) caches.delete(client);
      throw error;
    });
  caches.set(client, created);
  return created;
}

/** Index `reads` / `changes` from the Binding's pinned expected Program. */
export function indexInteractionFootprints(
  source: FootprintSource,
): ReadonlyMap<string, InteractionFootprint> {
  const footprints = new Map<string, InteractionFootprint>();
  for (const interaction of source.expectedProgram.interactions) {
    footprints.set(
      interaction.contract.id,
      Object.freeze({
        reads: Object.freeze([...interaction.contract.reads]),
        changes: Object.freeze([...interaction.contract.changes]),
      }),
    );
  }
  return footprints;
}

/** A completed change invalidates a mounted read when their footprints share a resource. */
export function readInvalidatedBy(
  footprints: ReadonlyMap<string, InteractionFootprint>,
  readInteractionId: string,
  changeInteractionId: string,
): boolean {
  const changed = footprints.get(changeInteractionId)?.changes ?? [];
  if (changed.length === 0) return false;
  const reads = footprints.get(readInteractionId)?.reads ?? [];
  return reads.some((resource) => changed.includes(resource));
}

export function isReadInteraction(
  footprints: ReadonlyMap<string, InteractionFootprint>,
  interactionId: string,
): boolean {
  return (footprints.get(interactionId)?.changes.length ?? -1) === 0;
}

export async function footprintsFor(
  client: ProjectionClient,
): Promise<ReadonlyMap<string, InteractionFootprint>> {
  const cache = cacheFor(client);
  if (!cache.footprints) {
    cache.footprints = indexInteractionFootprints(await cache.handshake);
  }
  return cache.footprints;
}

/** The footprint index, when the client's handshake has already resolved. */
export function peekFootprints(
  client: ProjectionClient,
): ReadonlyMap<string, InteractionFootprint> | undefined {
  return caches.get(client)?.footprints;
}

export function mountRead(
  client: ProjectionClient,
  interactionId: string,
  refresh: () => Promise<void>,
  scope?: InteractionCacheScope,
): () => void {
  const entry: MountedRead = { client, interactionId, refresh };
  cacheFor(client);
  const mountedReads = scopeReads.get(scopeFor(client, scope))!;
  mountedReads.add(entry);
  return () => {
    mountedReads.delete(entry);
  };
}

function interactionError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

function abortError(): Error {
  const error = new Error("interaction read was disposed");
  error.name = "AbortError";
  return error;
}

function snapshotFor<Handle extends AnyProjectedInteractionHandle>(
  data: InteractionOutput<Handle> | undefined,
  error: InteractionReadError<Handle> | undefined,
  isPending: boolean,
): InteractionReadSnapshot<Handle> {
  return Object.freeze({ data, error, isPending });
}

function watchOptions(value: unknown): WatchInteractionOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("watchInteraction options must be an object");
  }
  return value as WatchInteractionOptions;
}

type ActiveRead<Output> = {
  phase: "preparing" | "dispatched";
  trailing: boolean;
  readonly promise: Promise<Output>;
  readonly resolve: (value: Output) => void;
  readonly reject: (error: unknown) => void;
};

/**
 * Read one direct interaction as a small external store. It never invokes a
 * change: the pinned Binding and declared footprint are checked before every
 * transport call. Invalidation is deliberately scoped to mounted readers.
 */
export function watchInteraction<Handle extends AnyProjectedInteractionHandle>(
  client: ProjectionClient,
  handleValue: DirectHandle<Handle>,
  ...args: WatchInteractionArguments<Handle>
): InteractionRead<Handle> {
  const handle = snapshotProjectedHandle(handleValue, "watchInteraction.handle");
  const supplied = args as readonly unknown[];
  let input: JsonValue | undefined;
  let options: WatchInteractionOptions | undefined;
  if (handle.inputArity === 0) {
    if (supplied.length > 1) {
      throw new AdapterError("INVALID_REQUEST", `${handle.interactionId}.arguments`, "this interaction accepts no input");
    }
    options = watchOptions(supplied[0]);
  } else {
    if (supplied.length < 1 || supplied.length > 2) {
      throw new AdapterError("INVALID_REQUEST", `${handle.interactionId}.arguments`, "this interaction requires one input");
    }
    try {
      input = normalizeJson(supplied[0], `${handle.interactionId}.input`);
    } catch {
      throw new AdapterError("SCHEMA_MISMATCH", `${handle.interactionId}.input`, "input is not portable JSON");
    }
    options = watchOptions(supplied[1]);
  }

  let snapshot = snapshotFor<Handle>(undefined, undefined, false);
  let active: ActiveRead<InteractionOutput<Handle>> | undefined;
  let unmount: (() => void) | undefined;
  let refreshedSinceMount = false;
  let disposed = false;
  const listeners = new Set<() => void>();

  const publish = (
    data: InteractionOutput<Handle> | undefined,
    error: InteractionReadError<Handle> | undefined,
    isPending: boolean,
  ) => {
    if (disposed) return;
    snapshot = snapshotFor(data, error, isPending);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Subscribers cannot change read completion. */ }
    }
  };

  const assertReadable = async () => {
    if (!handle.modes.includes("direct")) {
      throw new AdapterError("INTERACTION_NOT_EXPOSED", handle.interactionId, "watchInteraction requires a direct projected interaction");
    }
    const cache = cacheFor(client);
    const [manifest, footprints] = await Promise.all([
      cache.handshake,
      footprintsFor(client),
    ]);
    const binding = manifest.interactions.find((candidate) => (
      candidate.interactionId === handle.interactionId && candidate.mode === "direct"
    ));
    if (!binding) {
      throw new AdapterError("INTERACTION_NOT_EXPOSED", handle.interactionId, "the direct interaction is absent from the pinned Binding");
    }
    if (
      binding.expectedContractDigest !== handle.contractDigest
      || binding.inputArity !== handle.inputArity
    ) {
      throw new AdapterError("STALE_REFERENCE", handle.interactionId, "projected handle does not match the pinned Binding");
    }
    const footprint = footprints.get(handle.interactionId);
    if (!footprint) {
      throw new AdapterError("INTERACTION_NOT_EXPOSED", handle.interactionId, "the interaction is absent from the pinned Program");
    }
    if (footprint.changes.length > 0) {
      throw new AdapterError("INVALID_REQUEST", handle.interactionId, "watchInteraction accepts declared reads only");
    }
  };

  const invoke = async (run: ActiveRead<InteractionOutput<Handle>>) => {
    if (disposed) throw abortError();
    publish(snapshot.data, undefined, true);
    run.phase = "preparing";
    await assertReadable();
    if (disposed) throw abortError();
    run.phase = "dispatched";
    const call = client.call as (
      value: AnyProjectedInteractionHandle,
      ...callArgs: readonly JsonValue[]
    ) => Promise<InteractionOutput<Handle>>;
    const value = handle.inputArity === 0
      ? await call(handle)
      : await call(handle, input!);
    if (disposed) throw abortError();
    publish(value, undefined, false);
    return value;
  };

  const start = (): Promise<InteractionOutput<Handle>> => {
    if (disposed) return Promise.reject(abortError());
    refreshedSinceMount = true;
    if (active) {
      if (active.phase === "dispatched") active.trailing = true;
      return active.promise;
    }
    let resolve!: (value: InteractionOutput<Handle>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<InteractionOutput<Handle>>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const run: ActiveRead<InteractionOutput<Handle>> = {
      phase: "preparing",
      trailing: false,
      promise,
      resolve,
      reject,
    };
    active = run;
    void (async () => {
      let value: InteractionOutput<Handle> | undefined;
      let failure: unknown;
      do {
        run.trailing = false;
        failure = undefined;
        try {
          value = await invoke(run);
        } catch (caught) {
          failure = caught;
          if (!disposed) publish(snapshot.data, interactionError(caught), false);
        }
      } while (run.trailing && !disposed);
      if (active === run) active = undefined;
      if (disposed) return;
      if (failure !== undefined) run.reject(failure);
      else run.resolve(value!);
    })();
    return promise;
  };

  const refresh = () => start();

  const subscribe = (listener: () => void) => {
    if (disposed) throw abortError();
    listeners.add(listener);
    if (listeners.size === 1) {
      unmount = mountRead(
        client,
        handle.interactionId,
        async () => { await refresh(); },
        options?.scope,
      );
      if (!refreshedSinceMount) void refresh().catch(() => {});
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        unmount?.();
        unmount = undefined;
        refreshedSinceMount = false;
      }
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unmount?.();
    unmount = undefined;
    listeners.clear();
    active?.reject(abortError());
    active = undefined;
    snapshot = snapshotFor<Handle>(undefined, undefined, false);
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe,
    refresh,
    dispose,
  });
}

function readInvalidatedByResources(
  changeFootprints: ReadonlyMap<string, InteractionFootprint>,
  readFootprints: ReadonlyMap<string, InteractionFootprint>,
  readInteractionId: string,
  changeInteractionId: string,
): boolean {
  const changed = changeFootprints.get(changeInteractionId)?.changes ?? [];
  if (changed.length === 0) return false;
  const reads = readFootprints.get(readInteractionId)?.reads ?? [];
  return reads.some((resource) => changed.includes(resource));
}

/**
 * Refresh every mounted read whose `reads` footprint intersects the change's
 * declared `changes` footprint. Reads are client-local by default. Pass the
 * same explicit scope to share invalidation across clients. Request proposals
 * do not imply completion and therefore do not invalidate reads.
 */
export async function invalidateReadsForChange(
  client: ProjectionClient,
  change: Pick<ProjectedInteractionHandle<any, any>, "interactionId">,
  scope?: InteractionCacheScope,
): Promise<void> {
  const changeFootprints = await footprintsFor(client);
  const changeInteractionId = change.interactionId;
  if (!changeFootprints.has(changeInteractionId)) {
    console.warn(
      `@foxworth/boundary/client: interaction "${changeInteractionId}" is not in this client's expected Program; no reads were invalidated for it`,
    );
  }
  const jobs: Promise<void>[] = [];
  for (const read of scopeReads.get(scopeFor(client, scope))!) {
    const readFootprints =
      read.client === client
        ? changeFootprints
        : await footprintsFor(read.client);
    if (
      readInvalidatedByResources(
        changeFootprints,
        readFootprints,
        read.interactionId,
        changeInteractionId,
      )
    ) {
      jobs.push(read.refresh());
    }
  }
  await Promise.all(jobs);
}

/** Refresh potentially affected reads after a host-published outcome. Never repeats the change. */
export async function invalidateReadsForObservation(value: unknown, scope: InteractionCacheScope): Promise<void> {
  const event = validateInvocationObservation(value);
  if (event.certainty === "not-started" || event.changes.length === 0) return;
  const mounted = scopeReads.get(scope);
  if (!mounted) throw new TypeError("an authentic interaction cache scope is required");
  await Promise.all([...mounted].map(async (read) => {
    const manifest = await cacheFor(read.client).handshake;
    if (manifest.installationId !== event.installationId || manifest.installationDigest !== event.installationDigest) return;
    const footprints = await footprintsFor(read.client);
    if (footprints.get(read.interactionId)?.reads.some((resource) => event.changes.includes(resource))) await read.refresh();
  }));
}

/** Refresh this installation's mounted reads after reconnect; never repeats changes. */
export async function refreshReadsForClient(client: ProjectionClient, scope: InteractionCacheScope): Promise<void> {
  const mounted = scopeReads.get(scope);
  if (!mounted) throw new TypeError("an authentic interaction cache scope is required");
  const expected = await cacheFor(client).handshake;
  await Promise.all([...mounted].map(async (read) => {
    const actual = await cacheFor(read.client).handshake;
    if (actual.installationId === expected.installationId && actual.installationDigest === expected.installationDigest) {
      await read.refresh();
    }
  }));
}
