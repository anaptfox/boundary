export {
  DeclaredInteractionError,
  declaredInteractionError,
  defineInteraction,
  isDeclaredInteractionError,
} from "./definitions";
export { surface } from "./surface";
export { install, ConnectError } from "./installation";
export { admitAll, admitWhen } from "./admission";
export { HostError, InteractionFault } from "./errors";

export type {
  AnySurface,
  ReservedCallerKey,
  Surface,
  SurfaceAlias,
  SurfaceSelection,
} from "./surface";
export type {
  AnyCaller,
  CallArguments,
  CallMethod,
  CallMethods,
  Caller,
  CallerFor,
  ConnectOptions,
  ConnectResult,
  ContextFromHandlers,
  HandlerInstallOptions,
  HandoffSeam,
  InstallOptions,
  Installation,
  NativeDispatch,
  NativeDispatchers,
  NativeInstallOptions,
  ProposeMethod,
  ProposeMethods,
  SurfaceFits,
} from "./facade-types";

// The explicit pipeline stays exported from the root until Phase 3 moves it
// to `@foxworth/boundary/pipeline`, where it is already available.
export {
  compileInteractions,
  composeCompiledInteractions,
  diffCompiledInteractions,
} from "./compile";
export { implementInteractions } from "./implement";
export { installInteractions } from "./install";
export { pickProjection, projectAllDirect, projectInteractions } from "./projection";
export { direct, directRealizationIds } from "./direct";
export { bindProjection, restrictBinding } from "./binding";

export type {
  Admission,
  AdmissionDecision,
  AdmissionInteractionView,
  AdmissionRequest,
  AnyInteractionDefinition,
  BindResult,
  BindingInvocation,
  AuthoringSchema,
  CompileInteractionsOptions,
  CompiledInteractions,
  DefinitionArity,
  DefinitionErrors,
  DefinitionInput,
  DefinitionOutput,
  DirectInteractionCaller,
  ErrorSchemas,
  ErrorValues,
  HandlesOf,
  ImplementationMap,
  InputArity,
  InstallationId,
  InstallationManifest,
  InstalledInteractions,
  InstallationController,
  MaybePromise,
  NativeDispatchRequest,
  NativeInteractionBinding,
  InteractionCaller,
  InteractionDefinition,
  InteractionDefinitions,
  InteractionHandle,
  InteractionImplementations,
  InteractionInstallation,
  InteractionLowering,
  InteractionMode,
  ProjectedHandles,
  ProjectedInteractionHandle,
  Projection,
  ProjectionBinding,
  BindingController,
  ProjectionBindingManifest,
  ProjectionBindingInteraction,
  ProjectionManifest,
  ProjectionInteraction,
  ProjectionSelection,
  ProjectionSelections,
  RawInvocationOutcome,
  RawInvocationResult,
  RealizationId,
  RealizationIds,
  RequestInvocationPolicy,
  RequestInteractionCaller,
  SchemaAdapter,
  SchemaValue,
  StandardSchema,
  ResolvedBindingMode,
  ResolvedBindingInteraction,
  UnrealizedIssue,
  UnrealizedReason,
  UnrealizedReport,
} from "./types";

export type { NativeDispatchOutcome, NativeDispatchOutcomes } from "./native-outcome";

export type {
  HostDiagnosticCode,
  InteractionFaultCause,
  InteractionFaultCertainty,
} from "./errors";

export type { InstallInteractionsOptions } from "./install";
export type { DirectRealizationIds } from "./direct";
export type { DirectProjectionSelections } from "./projection";
export type { AliasProjectionSelections } from "./projection";

export type { InvocationObserver } from "./observation";

export {
  publishExecutionEvidence,
  type ExecutionEvidencePublication,
  type ExecutionEvidencePublisher,
} from "./evidence";

export { presentProjection } from "./presentation";

export { assessProjection, type ProjectionAssessment } from "./assessment";
export { describeBinding } from "./description";
export type { InvocationCoordinator, CoordinatedInvocation, InvocationPolicy } from "./coordination";
