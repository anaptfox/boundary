import type { JsonValue, Program } from "@foxworth/boundary/program";
import type { ControlRequestContributions } from "./request-contributions";
import type { NativeDispatchOutcome } from "./native-outcome";
import type { InvocationCoordinator } from "./coordination";
import type { InvocationObserver } from "./observation";
import type { Surface, SurfaceAlias } from "./surface";
import type {
  Admission,
  CompiledInteractions,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  ImplementationMap,
  InstallationId,
  InstallationManifest,
  InteractionDefinitions,
  InteractionInstallation,
  MaybePromise,
  NativeDispatchRequest,
  ProjectionBinding,
  ProjectionBindingManifest,
  RawInvocationOutcome,
  ResolvedBindingInteraction,
  SchemaAdapter,
  UnrealizedReport,
} from "./types";

// ---------------------------------------------------------------------------
// Handler context inference. One Installation has one Context type; it is read
// from the handlers' annotated actor parameters so a host never names it twice.
// ---------------------------------------------------------------------------

type ExplicitHandlerContext<Definition, Handler> = DefinitionArity<Definition> extends 0
  ? Parameters<Extract<Handler, (...args: any[]) => unknown>> extends readonly [infer Context, ...unknown[]]
    ? Context
    : never
  : Parameters<Extract<Handler, (...args: any[]) => unknown>> extends readonly [unknown, infer Context, ...unknown[]]
    ? Context
    : never;

type HandlerContext<Definition, Handler> = [ExplicitHandlerContext<Definition, Handler>] extends [never]
  ? void
  : ExplicitHandlerContext<Definition, Handler>;

export type ContextFromHandlers<
  Definitions extends InteractionDefinitions,
  Handlers extends Readonly<Record<keyof Definitions & string, (...args: any[]) => unknown>>,
> = Exclude<{
  [Alias in keyof Definitions]: HandlerContext<Definitions[Alias], Handlers[Alias & keyof Handlers]>;
}[keyof Definitions], void> extends infer Context
  ? [Context] extends [never] ? void : Context
  : void;

type CompatibleContext<Definition, Handler, Context> =
  [ExplicitHandlerContext<Definition, Handler>] extends [never]
    ? unknown
    : [Context] extends [ExplicitHandlerContext<Definition, Handler>]
      ? unknown
      : never;

export type CompatibleHandlerContexts<
  Definitions extends InteractionDefinitions,
  Handlers extends Readonly<Record<keyof Definitions & string, (...args: any[]) => unknown>>,
> = {
  readonly [Alias in keyof Definitions]: CompatibleContext<
    Definitions[Alias],
    Handlers[Alias & keyof Handlers],
    ContextFromHandlers<Definitions, Handlers>
  >;
};

type ContextInferringHandler<Definition> = DefinitionArity<Definition> extends 0
  ? (actor: any) => MaybePromise<DefinitionOutput<Definition>>
  : (input: DefinitionInput<Definition>, actor: any) => MaybePromise<DefinitionOutput<Definition>>;

export type ContextInferringHandlers<Definitions extends InteractionDefinitions> = {
  readonly [Alias in keyof Definitions]: ContextInferringHandler<Definitions[Alias]>;
};

// ---------------------------------------------------------------------------
// install()
// ---------------------------------------------------------------------------

/** Native dispatchers keyed by alias; each receives its own target and typed input. */
export type NativeDispatchers<Definitions extends InteractionDefinitions, Targets, Context> = {
  readonly [Alias in keyof Definitions]: (
    request: NativeDispatchRequest<Definitions[Alias], Targets[Alias & keyof Targets], Context>,
  ) => MaybePromise<NativeDispatchOutcome<Definitions[Alias]>>;
};

/** `install(..., { dispatch })`: one native target and one dispatcher per alias. */
export type NativeDispatch<Definitions extends InteractionDefinitions, Targets, Context> = Readonly<{
  targets: Targets;
  dispatchers: NativeDispatchers<Definitions, Targets, Context>;
}>;

type CommonInstallOptions<Definitions extends InteractionDefinitions, Context> = Readonly<{
  /**
   * Host-owned release label for the installed realizations. It is required and
   * never derived from code: change it when executable behaviour changes.
   * Realization ids are `<interactionId>:direct:<version>` and, for request
   * contributions, `<interactionId>:request:<version>`.
   */
  version: string;
  /**
   * Installation id. Optional: the default is a visibly generated
   * `generated:...` token. A host that publishes Reach records, persists
   * Control state, or replaces an installation deliberately passes its own.
   */
  id?: InstallationId;
  /** Optional Control request contributions, built from this compilation. */
  requests?: (compiled: CompiledInteractions<Definitions>) => ControlRequestContributions<Definitions, Context>;
  /** Additional authoring-schema adapters for compilation. */
  schemas?: readonly SchemaAdapter<any>[];
}>;

export type HandlerInstallOptions<Definitions extends InteractionDefinitions, Context> =
  CommonInstallOptions<Definitions, Context> & Readonly<{
    handlers: ImplementationMap<Definitions, Context>;
    dispatch?: never;
  }>;

export type NativeInstallOptions<Definitions extends InteractionDefinitions, Targets, Context> =
  CommonInstallOptions<Definitions, Context> & Readonly<{
    dispatch: NativeDispatch<Definitions, Targets, Context>;
    handlers?: never;
  }>;

export type InstallOptions<Definitions extends InteractionDefinitions, Context, Targets = unknown> =
  | HandlerInstallOptions<Definitions, Context>
  | NativeInstallOptions<Definitions, Targets, Context>;

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

export type ConnectOptions<Context> = Readonly<{
  /**
   * Required. Decides every invocation after input validation and before
   * dispatch. Possession of a Surface or a caller is never authority;
   * `admitWhen(predicate, reason)` builds one from an actor predicate.
   */
  admit: Admission<Context>;
  observation?: InvocationObserver<Context>;
  coordinate?: InvocationCoordinator<Context>;
}>;

export type CallArguments<Definition, Context> = DefinitionArity<Definition> extends 0
  ? [Context] extends [void]
    ? readonly []
    : readonly [actor: Context]
  : [Context] extends [void]
    ? readonly [input: DefinitionInput<Definition>]
    : readonly [input: DefinitionInput<Definition>, actor: Context];

export type CallMethod<Definition, Context> = (
  ...args: CallArguments<Definition, Context>
) => Promise<DefinitionOutput<Definition>>;

/**
 * A proposal creates a Proposal record for host review and never runs the
 * effect. The record's shape is the realization's public proposal schema.
 */
export type ProposeMethod<Definition, Context> = (
  ...args: CallArguments<Definition, Context>
) => Promise<JsonValue>;

export type CallMethods<
  Definitions extends InteractionDefinitions,
  Call extends keyof Definitions & string,
  Context,
> = Readonly<{ [Alias in Call]: CallMethod<Definitions[Alias], Context> }>;

export type ProposeMethods<
  Definitions extends InteractionDefinitions,
  Propose extends keyof Definitions & string,
  Context,
> = Readonly<{ [Alias in Propose]: ProposeMethod<Definitions[Alias], Context> }>;

/**
 * The checked seam an adapter uses to validate serialized invocations into this
 * exact Binding. It carries the manifest, resolution, and raw invocation only:
 * no revocation, no broader selection, no second Binding.
 */
export type HandoffSeam<Context = unknown> = Readonly<{
  manifest: ProjectionBindingManifest;
  resolve(interactionId: string): ResolvedBindingInteraction | undefined;
  invoke(
    invocation: Readonly<{ interaction: ResolvedBindingInteraction; mode: "direct" | "request"; input: unknown }>,
    context: Context,
  ): Promise<RawInvocationOutcome>;
}>;

/**
 * What a caller holds: one method per `call` alias, `propose.<alias>` per
 * `propose` alias, the read-only Binding manifest, and the Handoff seam.
 * It carries no controller, so it is safe to hand to an adapter; revocation
 * stays on the host-held Installation.
 *
 * Method verbs map to wire modes: `call` is `direct`, `propose` is `request`.
 */
export type Caller<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
  Call extends SurfaceAlias<Definitions> = never,
  Propose extends SurfaceAlias<Definitions> = never,
  Context = unknown,
> = CallMethods<Definitions, Call, Context> & Readonly<{
  propose: ProposeMethods<Definitions, Propose, Context>;
  manifest: ProjectionBindingManifest;
  handoff: HandoffSeam<Context>;
}>;

/** Any caller, for adapters and facade methods that accept every selection. */
export type AnyCaller<Context = any> = Readonly<{
  propose: object;
  manifest: ProjectionBindingManifest;
  handoff: HandoffSeam<Context>;
}>;

export type CallerFor<S, Context> = S extends Surface<infer Definitions, infer Call, infer Propose>
  ? Caller<Definitions, Call, Propose, Context>
  : never;

/**
 * A Surface fits an Installation when every selected alias names the same
 * definition the Installation compiled. A Surface over another record, or one
 * selecting an alias this Installation does not declare, fails here.
 */
export type SurfaceFits<Definitions extends InteractionDefinitions, S> =
  S extends Surface<any, infer Call, infer Propose>
    ? Readonly<{ definitions: { readonly [Alias in Call | Propose]: Alias extends keyof Definitions ? Definitions[Alias] : never } }>
    : never;

export type ConnectResult<S, Context> =
  | Readonly<{ status: "connected"; caller: CallerFor<S, Context> }>
  | Readonly<{ status: "unrealized"; report: UnrealizedReport }>;

/**
 * A live Installation: the real compiled Program, installation artifact, and
 * manifest, plus the host-only controllers. Everything that holds authority
 * stays here; callers hold none.
 */
export interface Installation<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
  Context = unknown,
> {
  readonly id: InstallationId;
  readonly program: Program;
  readonly manifest: InstallationManifest;
  readonly compiled: CompiledInteractions<Definitions>;
  readonly installation: InteractionInstallation<Context>;
  readonly revoked: boolean;
  /** Bind a Surface and return its caller; throws `ConnectError` when unrealized. */
  connect<const S extends Surface<any, any, any>>(
    surface: S & SurfaceFits<Definitions, S>,
    options: ConnectOptions<Context>,
  ): Promise<CallerFor<S, Context>>;
  /**
   * Like `connect`, returning the exhaustive unrealized report instead of
   * throwing. It accepts a Surface over any declarations: a disagreement is
   * what the report is for, so the types do not insist on agreement here.
   */
  tryConnect<const S extends Surface<any, any, any>>(
    surface: S,
    options: ConnectOptions<Context>,
  ): Promise<ConnectResult<S, Context>>;
  /** Revoke one caller's Binding, or with no argument the whole Installation. */
  revoke(caller?: AnyCaller<Context>): boolean;
  /** The real Binding behind a caller, for inspection and Handoff tooling. */
  binding(caller: AnyCaller<Context>): ProjectionBinding<any, Context>;
}
