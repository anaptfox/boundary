import type {
  AnyCaller,
  CallerCallAliases,
  CallerDefinitions,
  CallerProposeAliases,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
} from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";
import { AdapterError } from "@foxworth/boundary/remote";
import { indexInteractionFootprints, isReadInteraction } from "@foxworth/boundary/client/cache";
import type { HttpHandler } from "@foxworth/boundary/http";

type ServerArguments<Definition> = DefinitionArity<Definition> extends 0
  ? readonly []
  : readonly [input: DefinitionInput<Definition>];

type ServerMethods<Definitions, Aliases extends string, Output> = Readonly<{
  [Alias in Aliases]: (
    ...args: ServerArguments<Alias extends keyof Definitions ? Definitions[Alias] : never>
  ) => Promise<Output extends "declared" ? DefinitionOutput<Alias extends keyof Definitions ? Definitions[Alias] : never> : JsonValue>;
}>;

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

export type NextServerCallerOptions<C extends AnyCaller<any>, Context> = Readonly<{
  /** A connected caller; this helper never installs or widens one. */
  caller: C;
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

export type NextServerCaller<C> = Readonly<{
  /** Direct server reads, one per call alias with no declared changes; they invoke the caller without a self-HTTP call. */
  read: ServerMethods<CallerDefinitions<C>, CallerCallAliases<C>, "declared">;
  /**
   * Direct mutation and proposal entry points for a Server Action or form.
   * Neither path retries an invocation. Only a completed direct call triggers
   * the optional host cache callback.
   */
  action: ServerMethods<CallerDefinitions<C>, CallerCallAliases<C>, "declared"> & Readonly<{
    propose: ServerMethods<CallerDefinitions<C>, CallerProposeAliases<C>, "proposal">;
  }>;
}>;

function assertOptions(value: unknown): asserts value is NextServerCallerOptions<AnyCaller, unknown> {
  if (!value || typeof value !== "object") {
    throw new TypeError("createNextServerCaller requires options");
  }
  const options = value as Record<string, unknown>;
  const caller = options.caller as Record<string, unknown> | undefined;
  if (!caller || typeof caller !== "object" || !("handoff" in caller) || !("manifest" in caller) || typeof options.context !== "function") {
    throw new TypeError("createNextServerCaller requires a connected caller and a per-invocation context function");
  }
  if (options.afterAction !== undefined && typeof options.afterAction !== "function") {
    throw new TypeError("createNextServerCaller.afterAction must be a function");
  }
  if (options.onCacheError !== undefined && typeof options.onCacheError !== "function") {
    throw new TypeError("createNextServerCaller.onCacheError must be a function");
  }
}

function define(record: object, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: false, writable: false });
}

/**
 * Adapt one connected caller to Next server reads and Server Actions.
 *
 * The application owns installation lifetime and authentication. `context()`
 * deliberately runs for each call, so this helper cannot turn a selected
 * surface, module singleton, or prior request into authority.
 */
export function createNextServerCaller<C extends AnyCaller<any>, Context>(
  options: NextServerCallerOptions<C, Context>,
): NextServerCaller<C> {
  assertOptions(options);
  const caller = options.caller as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const propose = options.caller.propose as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const manifest = options.caller.manifest;
  const footprints = indexInteractionFootprints(manifest);
  const interactionIds = new Map<string, string>();
  const arities = new Map<string, 0 | 1>();
  for (const entry of manifest.interactions) {
    interactionIds.set(entry.alias, entry.interactionId);
    arities.set(entry.alias, entry.inputArity);
  }

  async function invoke(
    method: (...args: unknown[]) => Promise<unknown>,
    alias: string,
    args: readonly unknown[],
    context: Context,
  ): Promise<unknown> {
    return arities.get(alias) === 0 ? method(context) : method(args[0], context);
  }

  const read: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const action: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const proposals: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const alias of Object.keys(caller)) {
    const method = caller[alias]!;
    const interactionId = interactionIds.get(alias)!;
    define(read, alias, async (...args: readonly unknown[]) => {
      if (!isReadInteraction(footprints, interactionId)) {
        throw new AdapterError(
          "INVALID_DECLARATION",
          `${interactionId}.reads`,
          "Next server reads require a selected interaction with no declared changes; use action instead",
        );
      }
      return invoke(method, alias, args, await options.context());
    });
    define(action, alias, async (...args: readonly unknown[]) => {
      const context = await options.context();
      const value = await invoke(method, alias, args, context);
      const completion: NextActionCompletion<Context> = Object.freeze({
        context,
        interactionId,
        bindingDigest: manifest.bindingDigest,
        installationId: manifest.installationId,
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
    });
  }
  for (const alias of Object.keys(propose)) {
    const method = propose[alias]!;
    define(proposals, alias, async (...args: readonly unknown[]) => invoke(method, alias, args, await options.context()));
  }
  define(action, "propose", Object.freeze(proposals));
  return Object.freeze({ read: Object.freeze(read), action: Object.freeze(action) }) as unknown as NextServerCaller<C>;
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
 * Bind one explicit HTTP handler to Next App Router method exports.
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
