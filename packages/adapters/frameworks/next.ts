import type {
  AnyInteractionDefinition,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  InteractionHandle,
  ProjectedInteractionHandle,
  ProjectionBinding,
} from "@foxworth/boundary";
import { AdapterError } from "#remote";
import { indexInteractionFootprints, isReadInteraction } from "@foxworth/boundary/client";
import type { HttpHandler } from "@foxworth/boundary/http";

type AnyProjectedInteractionHandle = ProjectedInteractionHandle<any, any, any>;
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
  HandleArity<Handle> extends 0 ? readonly [] : readonly [input: HandleInput<Handle>];
type DirectHandle<Handle extends AnyProjectedInteractionHandle> = Handle &
  ("direct" extends Handle["modes"][number] ? unknown : never);
type RequestHandle<Handle extends AnyProjectedInteractionHandle> = Handle &
  ("request" extends Handle["modes"][number] ? unknown : never);
type RequestOutput<Handle extends AnyProjectedInteractionHandle> =
  Handle extends ProjectedInteractionHandle<any, any, infer Output> ? Output : never;

/**
 * The exact completed direct invocation that a host may use to refresh its own
 * Next cache entries. Tags, paths, visibility scopes, and error reporting stay
 * host-owned: an interaction footprint alone is not permission to share a cache.
 */
export type NextActionCompletion<Context> = Readonly<{
  context: Context;
  interactionId: string;
  bindingDigest: string;
  installationId: string;
}>;

export type NextServerCallerOptions<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle<any, any, any>>>,
  Context,
> = Readonly<{
  /** A single already-bound, pinned host Binding; this helper never installs one. */
  binding: ProjectionBinding<Handles, Context>;
  /** Derive authenticated request/action context for every invocation. */
  context: () => Context | Promise<Context>;
  /**
   * Runs only after a direct action completed. Typical hosts call Next's
   * `updateTag` or `revalidateTag` here with tenant- and visibility-scoped tags.
   */
  afterAction?: (completion: NextActionCompletion<Context>) => void | Promise<void>;
  /** Observes cache-refresh failures without changing an already-completed action. */
  onCacheError?: (error: unknown, completion: NextActionCompletion<Context>) => void;
}>;

export type NextServerCaller<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle<any, any, any>>>,
> = Readonly<{
  /** Direct server read; it invokes the pinned Binding without a self-HTTP call. */
  read: Readonly<{
    call<Handle extends Handles[keyof Handles]>(
      handle: DirectHandle<Handle>,
      ...args: HandleArguments<Handle>
    ): Promise<HandleOutput<Handle>>;
  }>;
  /**
   * Direct mutation and proposal entry points for a Server Action or form.
   * Neither path retries an invocation. Only a completed direct call triggers
   * the optional host cache callback.
   */
  action: Readonly<{
    call<Handle extends Handles[keyof Handles]>(
      handle: DirectHandle<Handle>,
      ...args: HandleArguments<Handle>
    ): Promise<HandleOutput<Handle>>;
    request<Handle extends Handles[keyof Handles]>(
      handle: RequestHandle<Handle>,
      ...args: HandleArguments<Handle>
    ): Promise<RequestOutput<Handle>>;
  }>;
}>;

function assertOptions(value: unknown): asserts value is NextServerCallerOptions<any, any> {
  if (!value || typeof value !== "object") {
    throw new TypeError("createNextServerCaller requires options");
  }
  const options = value as Record<string, unknown>;
  if (!options.binding || typeof options.context !== "function") {
    throw new TypeError("createNextServerCaller requires a Binding and per-invocation context function");
  }
  if (options.afterAction !== undefined && typeof options.afterAction !== "function") {
    throw new TypeError("createNextServerCaller.afterAction must be a function");
  }
  if (options.onCacheError !== undefined && typeof options.onCacheError !== "function") {
    throw new TypeError("createNextServerCaller.onCacheError must be a function");
  }
}

/**
 * Adapt one existing Binding to Next server reads and Server Actions.
 *
 * The application owns installation lifetime and authentication. `context()`
 * deliberately runs for each call, so this helper cannot turn a selected
 * projection, module singleton, or prior request into authority.
 */
export function createNextServerCaller<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle<any, any, any>>>,
  Context,
>(options: NextServerCallerOptions<Handles, Context>): NextServerCaller<Handles> {
  assertOptions(options);
  const caller = options.binding.connect();
  const footprints = indexInteractionFootprints(options.binding.manifest);

  function assertDeclaredRead(handle: AnyProjectedInteractionHandle): void {
    if (!isReadInteraction(footprints, handle.interactionId)) {
      throw new AdapterError(
        "INVALID_DECLARATION",
        `${handle.interactionId}.reads`,
        "Next server reads require a selected interaction with no declared changes; use action.call instead",
      );
    }
  }

  async function direct<Handle extends Handles[keyof Handles]>(
    handle: DirectHandle<Handle>,
    args: HandleArguments<Handle>,
  ): Promise<HandleOutput<Handle>> {
    assertDeclaredRead(handle);
    const context = await options.context();
    const call = caller.call as (
      handle: AnyProjectedInteractionHandle,
      ...arguments_: readonly unknown[]
    ) => Promise<unknown>;
    return (handle.inputArity === 0
      ? await call(handle, context)
      : await call(handle, args[0], context)) as HandleOutput<Handle>;
  }

  async function afterCompletedAction<Handle extends Handles[keyof Handles]>(
    handle: DirectHandle<Handle>,
    args: HandleArguments<Handle>,
  ): Promise<HandleOutput<Handle>> {
    const context = await options.context();
    const call = caller.call as (
      handle: AnyProjectedInteractionHandle,
      ...arguments_: readonly unknown[]
    ) => Promise<unknown>;
    const value = (handle.inputArity === 0
      ? await call(handle, context)
      : await call(handle, args[0], context)) as HandleOutput<Handle>;
    const completion: NextActionCompletion<Context> = Object.freeze({
      context,
      interactionId: handle.interactionId,
      bindingDigest: options.binding.manifest.bindingDigest,
      installationId: options.binding.manifest.installationId,
    });
    if (options.afterAction) {
      try {
        await options.afterAction(completion);
      } catch (error) {
        try {
          options.onCacheError?.(error, completion);
        } catch {
          // Cache-error reporting cannot turn a completed effect into a failed one.
        }
      }
    }
    return value;
  }

  async function request<Handle extends Handles[keyof Handles]>(
    handle: RequestHandle<Handle>,
    args: HandleArguments<Handle>,
  ): Promise<RequestOutput<Handle>> {
    const context = await options.context();
    const requestCaller = caller as typeof caller & Readonly<{
      request: (
        handle: AnyProjectedInteractionHandle,
        ...arguments_: readonly unknown[]
      ) => Promise<unknown>;
    }>;
    return (handle.inputArity === 0
      ? await requestCaller.request(handle, context)
      : await requestCaller.request(handle, args[0], context)) as RequestOutput<Handle>;
  }

  const read: NextServerCaller<Handles>["read"] = Object.freeze({
    call: async <Handle extends Handles[keyof Handles]>(
      handle: DirectHandle<Handle>,
      ...args: HandleArguments<Handle>
    ) => direct(handle, args),
  });
  const action: NextServerCaller<Handles>["action"] = Object.freeze({
    call: async <Handle extends Handles[keyof Handles]>(
      handle: DirectHandle<Handle>,
      ...args: HandleArguments<Handle>
    ) => afterCompletedAction(handle, args),
    request: async <Handle extends Handles[keyof Handles]>(
      handle: RequestHandle<Handle>,
      ...args: HandleArguments<Handle>
    ) => request(handle, args),
  });
  return Object.freeze({ read, action });
}

export type ProjectionHandlers = Readonly<{
  GET: HttpHandler;
  POST: HttpHandler;
  PUT: HttpHandler;
  PATCH: HttpHandler;
  DELETE: HttpHandler;
  HEAD: HttpHandler;
  OPTIONS: HttpHandler;
}>;

/**
 * Bind one explicit HTTP projection to Next App Router method exports.
 * Route placement and segment config stay in the caller's `route.ts` file.
 */
export function createProjectionHandlers(
  handler: HttpHandler,
): ProjectionHandlers {
  return Object.freeze({
    GET: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
    HEAD: handler,
    OPTIONS: handler,
  });
}
