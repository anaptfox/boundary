import type {
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  InteractionDefinitions,
  ImplementationMap,
  HandlesOf,
  Projection,
  ProjectionSelection,
  ProjectedHandles,
  ProjectionBinding,
  MaybePromise,
} from "./types";

export type BindInteractionCallerConfig<Context, Alias extends string> = Readonly<{
  direct: readonly Alias[];
  admit: (actor: Context) => boolean | PromiseLike<boolean>;
}>;

export type BindInteractionCallers<
  Definitions extends InteractionDefinitions,
  Context,
> = Readonly<Record<string, BindInteractionCallerConfig<Context, keyof Definitions & string>>>;

export type NamedCallArguments<Definition, Context> = DefinitionArity<Definition> extends 0
  ? [Context] extends [void]
    ? readonly []
    : readonly [actor: Context]
  : [Context] extends [void]
    ? readonly [input: DefinitionInput<Definition>]
    : readonly [input: DefinitionInput<Definition>, actor: Context];

export type NamedInteractionMethod<Definition, Context> = (
  ...args: NamedCallArguments<Definition, Context>
) => Promise<DefinitionOutput<Definition>>;

export type NamedCallerMethods<
  Definitions extends InteractionDefinitions,
  Context,
  Aliases extends readonly (keyof Definitions & string)[],
> = Readonly<{
  [Alias in Aliases[number]]: NamedInteractionMethod<Definitions[Alias], Context>;
}>;

export type NamedCallers<
  Definitions extends InteractionDefinitions,
  Context,
  Callers extends Readonly<Record<string, { readonly direct: readonly (keyof Definitions & string)[] }>>,
> = Readonly<{
  [Name in keyof Callers]: Callers[Name] extends { readonly direct: infer Aliases extends readonly (keyof Definitions & string)[] }
    ? NamedCallerMethods<Definitions, Context, Aliases>
    : never;
}>;

export type CallerSelections<
  Definitions extends InteractionDefinitions,
  Aliases extends readonly (keyof Definitions & string)[],
> = Readonly<{
  [Alias in Aliases[number]]: ProjectionSelection<
    HandlesOf<Definitions>[Alias],
    readonly ["direct"]
  >;
}>;

export type CallerProjection<
  Definitions extends InteractionDefinitions,
  Aliases extends readonly (keyof Definitions & string)[],
> = Projection<CallerSelections<Definitions, Aliases>>;

export type BindInteractionsResult<
  Definitions extends InteractionDefinitions,
  Context,
  Callers extends Readonly<Record<string, { readonly direct: readonly (keyof Definitions & string)[] }>>,
> = Readonly<{
  compiled: import("./types").CompiledInteractions<Definitions>;
  installation: import("./types").InteractionInstallation<Context>;
  installationController: import("./types").InstallationController;
  projections: Readonly<{
    [Name in keyof Callers]: Callers[Name] extends { readonly direct: infer Aliases extends readonly (keyof Definitions & string)[] }
      ? CallerProjection<Definitions, Aliases>
      : never;
  }>;
  bindings: Readonly<{
    [Name in keyof Callers]: Callers[Name] extends { readonly direct: infer Aliases extends readonly (keyof Definitions & string)[] }
      ? ProjectionBinding<ProjectedHandles<CallerSelections<Definitions, Aliases>>, Context>
      : never;
  }>;
  bindingControllers: Readonly<Record<keyof Callers & string, import("./types").BindingController>>;
  callers: NamedCallers<Definitions, Context, Callers>;
}>;

export interface BindInteractionsIssue {
  readonly caller: string;
  readonly cause: unknown;
}

export interface BindInteractionsOptions<
  Definitions extends InteractionDefinitions,
  Context,
  Callers extends BindInteractionCallers<Definitions, Context> = BindInteractionCallers<Definitions, Context>,
> {
  readonly installationId: string;
  readonly realizationVersion: string;
  readonly handlers: ImplementationMap<Definitions, Context>;
  readonly callers: Callers;
}

export type ExactCallerAliases<
  Definitions extends InteractionDefinitions,
  Callers extends BindInteractionCallers<Definitions, any>,
> = {
  readonly [Name in keyof Callers]: Callers[Name] extends { readonly direct: infer Aliases extends readonly string[] }
    ? Exclude<Aliases[number], keyof Definitions> extends never ? unknown : never
    : never;
};

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
