import type {
  InstallationId,
  InstallationManifest,
  InputArity,
  JsonObject,
  JsonSchema,
  JsonValue,
  InteractionContract,
  InteractionDescriptor,
  InteractionMode,
  PortableSchema,
  PortableSchemaValue,
  Program,
  ProjectionBindingManifest,
  ProjectionBindingInteraction,
  ProjectionManifest,
  ProjectionInteraction,
  RawInvocationOutcome,
  RawInvocationResult,
  RealizationId,
  SchemaAdapter as ProgramSchemaAdapter,
  Sha256Digest,
} from "@foxworth/boundary/program";
import type { NativeDispatchOutcome, NativeDispatchOutcomes } from "./native-outcome";

export type {
  InstallationId,
  InstallationManifest,
  InputArity,
  InteractionMode,
  ProjectionBindingManifest,
  ProjectionBindingInteraction,
  ProjectionManifest,
  ProjectionInteraction,
  RawInvocationOutcome,
  RawInvocationResult,
  RealizationId,
};

export type MaybePromise<Value> = Value | PromiseLike<Value>;

export type ErrorSchemas = Readonly<Record<string, PortableSchema>>;
export type ErrorValues<Schemas extends ErrorSchemas> = {
  readonly [Code in keyof Schemas]: PortableSchemaValue<Schemas[Code]>;
};

/** Minimal Standard Schema type carrier used for authoring-time inference. */
export interface StandardSchema<Output extends JsonValue = JsonValue> {
  readonly "~standard": {
    readonly types?: {
      readonly output: Output;
    };
  };
}

/** Schema families may vary, but their inferred wire value must stay JSON. */
export type AuthoringSchema =
  | PortableSchema<any>
  | StandardSchema<any>;

export type SchemaValue<Schema> = Schema extends PortableSchema<infer Value>
  ? Value
  : Schema extends {
        readonly "~standard": {
          readonly types?: { readonly output: infer Output };
        };
      }
    ? Extract<Output, JsonValue>
    : never;

/** Host-selectable adapter from one authoring schema family to Program data. */
export interface SchemaAdapter<Schema = unknown>
  extends ProgramSchemaAdapter<Schema> {
  supports(value: unknown): value is Schema;
}

export interface CompileInteractionsOptions {
  readonly schemas?: readonly SchemaAdapter<any>[];
}

declare const definitionTypes: unique symbol;
declare const handleTypes: unique symbol;
declare const implementationTypes: unique symbol;
declare const projectionHandleTypes: unique symbol;
declare const installationContextTypes: unique symbol;
declare const bindingContextTypes: unique symbol;

export interface InteractionDefinition<
  Id extends string = string,
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
  Errors extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
  Arity extends InputArity = InputArity,
> {
  readonly id: Id;
  readonly input: AuthoringSchema;
  readonly output: AuthoringSchema;
  readonly errors: Readonly<Record<keyof Errors & string, AuthoringSchema>>;
  readonly reads: readonly string[];
  readonly changes: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly annotations?: JsonObject;
  readonly inputArity: Arity;
  readonly [definitionTypes]?: {
    readonly input: Input;
    readonly output: Output;
    readonly errors: Errors;
    readonly arity: Arity;
  };
}

export type AnyInteractionDefinition = InteractionDefinition<
  string,
  any,
  any,
  any,
  InputArity
>;

export type InteractionDefinitions = Readonly<
  Record<string, AnyInteractionDefinition>
>;

export type DefinitionInput<Value> = Value extends InteractionDefinition<
  string,
  infer Input,
  any,
  any,
  any
>
  ? Input
  : never;

export type DefinitionOutput<Value> = Value extends InteractionDefinition<
  string,
  any,
  infer Output,
  any,
  any
>
  ? Output
  : never;

export type DefinitionErrors<Value> = Value extends InteractionDefinition<
  string,
  any,
  any,
  infer Errors,
  any
>
  ? Errors
  : never;

export type DefinitionArity<Value> = Value extends InteractionDefinition<
  string,
  any,
  any,
  any,
  infer Arity
>
  ? Arity
  : never;

export interface InteractionHandle<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
> {
  readonly interactionId: Definition["id"];
  readonly contractDigest: Sha256Digest;
  readonly inputArity: DefinitionArity<Definition>;
  readonly [handleTypes]?: Definition;
}

export type HandleDefinition<Value> = Value extends InteractionHandle<
  infer Definition
>
  ? Definition
  : never;

export type HandlesOf<Definitions extends InteractionDefinitions> = {
  readonly [Alias in keyof Definitions]: InteractionHandle<Definitions[Alias]>;
};

export interface CompiledInteractions<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
> {
  readonly program: Program;
  readonly handles: HandlesOf<Definitions>;
}

export interface InteractionLowering<
  Native extends Readonly<Record<string, unknown>>,
  Definitions extends InteractionDefinitions,
> {
  lower<Alias extends keyof Native & string>(
    value: Native[Alias],
    context: Readonly<{ alias: Alias }>,
  ): MaybePromise<Definitions[Alias]>;
}

type ContextualImplementation<
  Definition extends AnyInteractionDefinition,
  Context,
> = DefinitionArity<Definition> extends 0
  ? [Context] extends [void]
    ? () => MaybePromise<DefinitionOutput<Definition>>
    : (context: Context) => MaybePromise<DefinitionOutput<Definition>>
  : [Context] extends [void]
    ? (
        input: DefinitionInput<Definition>,
      ) => MaybePromise<DefinitionOutput<Definition>>
    : (
        input: DefinitionInput<Definition>,
        context: Context,
      ) => MaybePromise<DefinitionOutput<Definition>>;

export type ImplementationMap<
  Definitions extends InteractionDefinitions,
  Context,
> = {
  readonly [Alias in keyof Definitions]: ContextualImplementation<
    Definitions[Alias],
    Context
  >;
};

export interface InteractionImplementations<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
  Context = void,
> {
  readonly [implementationTypes]?: {
    readonly definitions: Definitions;
    readonly context: Context;
  };
}

export interface NativeDispatchRequest<
  Definition extends AnyInteractionDefinition,
  Target,
  Context,
> {
  readonly interaction: InteractionHandle<Definition>;
  readonly target: Target;
  readonly input: DefinitionInput<Definition>;
  readonly context: Context;
  /** Issues authenticated outcomes for this exact native dispatch. */
  readonly outcomes: NativeDispatchOutcomes<Definition>;
}

export interface NativeInteractionBinding<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
  Target = unknown,
  Context = unknown,
> {
  readonly interaction: InteractionHandle<Definition>;
  readonly target: Target;
  dispatch(
    request: NativeDispatchRequest<Definition, Target, Context>,
  ): MaybePromise<NativeDispatchOutcome<Definition>>;
}

/** Immutable runtime identity supplied by Host to one request realization. */
export interface RequestInvocationPolicy {
  readonly mode: "request";
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: InstallationId;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly installationProgramDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly realizationId: RealizationId;
}

export type RealizationIds = Readonly<
  Record<
    string,
    Readonly<{
      direct?: RealizationId;
      request?: RealizationId;
    }>
  >
>;

export interface InteractionInstallation<Context = unknown> {
  readonly handles: Readonly<Record<string, InteractionHandle>>;
  readonly manifest: InstallationManifest;
  readonly installationId: InstallationId;
  readonly [installationContextTypes]?: (context: Context) => Context;
}

export interface InstallationController {
  readonly revoked: boolean;
  revoke(): boolean;
}

export interface InstalledInteractions<Context = unknown> {
  readonly installation: InteractionInstallation<Context>;
  readonly controller: InstallationController;
}

export interface ProjectionSelection<
  Handle extends InteractionHandle = InteractionHandle,
  Modes extends readonly InteractionMode[] = readonly InteractionMode[],
> {
  readonly interaction: Handle;
  readonly modes: Modes;
}

export type ProjectionSelections = Readonly<
  Record<string, ProjectionSelection>
>;

export interface ProjectedInteractionHandle<
  Handle extends InteractionHandle = InteractionHandle,
  Modes extends readonly InteractionMode[] = readonly InteractionMode[],
  RequestOutput extends JsonValue = JsonValue,
> extends InteractionHandle<HandleDefinition<Handle>> {
  readonly modes: Modes;
  readonly [projectionHandleTypes]?: {
    readonly handle: Handle;
    readonly modes: Modes[number];
    readonly requestOutput: RequestOutput;
  };
}

export type ProjectedHandles<Selections extends ProjectionSelections> = {
  readonly [Alias in keyof Selections]: ProjectedInteractionHandle<
    Selections[Alias]["interaction"],
    Selections[Alias]["modes"]
  >;
};

export interface Projection<
  Selections extends ProjectionSelections = ProjectionSelections,
> {
  readonly program: Program;
  readonly interactions: readonly ProjectionInteraction[];
  readonly projectionDigest: Sha256Digest;
  readonly handles: ProjectedHandles<Selections>;
  readonly manifest: ProjectionManifest;
}

export type AdmissionDecision =
  | Readonly<{ decision: "allow" }>
  | Readonly<{ decision: "deny"; reason: string }>;

export interface AdmissionInteractionView {
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly reads: readonly string[];
  readonly changes: readonly string[];
}

export interface AdmissionRequest<Context = unknown> {
  readonly context: Context;
  readonly handle: AdmissionInteractionView;
  readonly mode: InteractionMode;
  readonly input: JsonValue;
  readonly policy: Readonly<{
    readonly installationId: InstallationId;
    readonly realizationId: RealizationId;
  }>;
}

export type Admission<Context = unknown> = (
  request: AdmissionRequest<Context>,
) => MaybePromise<AdmissionDecision>;

export type UnrealizedReason =
  | "binding-revoked"
  | "interaction-not-selected"
  | "contract-not-selected"
  | "arity-not-selected"
  | "mode-not-selected"
  | "installation-revoked"
  | "missing-interaction"
  | "incompatible-contract"
  | "incompatible-arity"
  | "missing-direct"
  | "missing-request";

export interface UnrealizedIssue {
  readonly alias: string;
  readonly interactionId: string;
  readonly mode?: InteractionMode;
  readonly reason: UnrealizedReason;
  readonly message: string;
}

export interface UnrealizedReport {
  readonly projection: ProjectionManifest;
  readonly installationId: InstallationId;
  readonly issues: readonly UnrealizedIssue[];
}

export interface ResolvedBindingMode {
  readonly mode: InteractionMode;
  readonly realizationId: RealizationId;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly request?: Readonly<{
    readonly controlDigest: Sha256Digest;
    readonly previewSchema: JsonSchema;
  }>;
}

export interface ResolvedBindingInteraction {
  readonly interactionId: string;
  readonly inputArity: InputArity;
  readonly modes: readonly ResolvedBindingMode[];
}

type HandleInput<Handle extends InteractionHandle> = DefinitionInput<
  HandleDefinition<Handle>
>;
type HandleOutput<Handle extends InteractionHandle> = DefinitionOutput<
  HandleDefinition<Handle>
>;
type HandleArity<Handle extends InteractionHandle> = DefinitionArity<
  HandleDefinition<Handle>
>;
type HandleModes<Handle> = Handle extends ProjectedInteractionHandle<
  InteractionHandle,
  infer Modes,
  any
>
  ? Modes[number]
  : never;
type HandleRequestOutput<Handle> = Handle extends ProjectedInteractionHandle<
  InteractionHandle,
  readonly InteractionMode[],
  infer RequestOutput
>
  ? RequestOutput
  : JsonValue;

type InvocationArguments<Handle extends InteractionHandle, Context> =
  HandleArity<Handle> extends 0
    ? [Context] extends [void]
      ? readonly []
      : readonly [context: Context]
    : [Context] extends [void]
      ? readonly [input: HandleInput<Handle>]
      : readonly [input: HandleInput<Handle>, context: Context];

type RawArguments<Context> = [Context] extends [void]
  ? readonly [input: unknown]
  : readonly [input: unknown, context: Context];

export interface DirectInteractionCaller<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle>>,
  Context,
> {
  call<Handle extends Handles[keyof Handles]>(
    handle: Handle & ("direct" extends HandleModes<Handle> ? unknown : never),
    ...args: InvocationArguments<Handle, Context>
  ): Promise<HandleOutput<Handle>>;

  callRaw(
    interaction: ResolvedBindingInteraction,
    ...args: RawArguments<Context>
  ): Promise<RawInvocationOutcome>;
}

export interface RequestInteractionCaller<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle>>,
  Context,
> extends DirectInteractionCaller<Handles, Context> {
  request<Handle extends Handles[keyof Handles]>(
    handle: Handle & ("request" extends HandleModes<Handle> ? unknown : never),
    ...args: InvocationArguments<Handle, Context>
  ): Promise<HandleRequestOutput<Handle>>;

  requestRaw(
    interaction: ResolvedBindingInteraction,
    ...args: RawArguments<Context>
  ): Promise<RawInvocationOutcome>;
}

type HasRequest<Handles extends Readonly<Record<string, ProjectedInteractionHandle>>> =
  Extract<
    {
      [Alias in keyof Handles]: HandleModes<Handles[Alias]>;
    }[keyof Handles],
    "request"
  > extends never
    ? false
    : true;

export type InteractionCaller<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle>>,
  Context,
> = HasRequest<Handles> extends true
  ? RequestInteractionCaller<Handles, Context>
  : DirectInteractionCaller<Handles, Context>;

/** One Binding invocation. Handoff declares a structural copy (`HandoffBindingInvocation`) so it never imports Host; `tests/typescript/handoff-host-seam.test.ts` keeps them assignable. */
export interface BindingInvocation {
  readonly interaction: ResolvedBindingInteraction;
  readonly mode: InteractionMode;
  readonly input: unknown;
}

type InvokeArguments<Context> = [Context] extends [void]
  ? readonly [invocation: BindingInvocation]
  : readonly [invocation: BindingInvocation, context: Context];

export interface ProjectionBinding<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle>> = Readonly<
    Record<string, ProjectedInteractionHandle>
  >,
  Context = unknown,
> {
  readonly manifest: ProjectionBindingManifest;
  connect(): InteractionCaller<Handles, Context>;
  resolve(interactionId: string): ResolvedBindingInteraction | undefined;
  invoke(...args: InvokeArguments<Context>): Promise<RawInvocationOutcome>;
  readonly [bindingContextTypes]?: (context: Context) => Context;
}

export interface BindingController {
  readonly revoked: boolean;
  revoke(): boolean;
}

export type BindResult<
  Handles extends Readonly<Record<string, ProjectedInteractionHandle>>,
  Context,
> =
  | Readonly<{
      status: "bound";
      binding: ProjectionBinding<Handles, Context>;
      controller: BindingController;
    }>
  | Readonly<{
      status: "unrealized";
      report: UnrealizedReport;
    }>;

export interface ActualInteractionResolution<Context = unknown> {
  readonly alias: string;
  readonly definition: AnyInteractionDefinition;
  readonly descriptor: InteractionDescriptor;
  readonly contract: InteractionContract;
  readonly errorSchemas: Readonly<Record<string, PortableSchema>>;
  readonly inputArity: InputArity;
  readonly direct?: Readonly<{
    readonly realizationId: RealizationId;
    execute(input: JsonValue, context: Context): Promise<unknown>;
  }>;
  readonly request?: Readonly<{
    readonly realizationId: RealizationId;
    readonly controlDigest: Sha256Digest;
    readonly previewSchema: JsonSchema;
    execute(
      input: JsonValue,
      context: Context,
      policy: RequestInvocationPolicy,
    ): Promise<unknown>;
  }>;
}
