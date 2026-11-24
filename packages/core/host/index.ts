export { b, type InferSchema } from "@foxworth/boundary/program";
export type { AsyncInteractionLowering } from "./async-lowering";
export {
  DeclaredInteractionError,
  declaredInteractionError,
  defineInteraction,
  isDeclaredInteractionError,
} from "./definitions";
export {
  compileInteractions,
  compileInteractionsAsync,
  composeCompiledInteractions,
  diffCompiledInteractions,
} from "./compile";
export { implementInteractions } from "./implement";
export { bindNativeInteractions, type NativeDispatchers } from "./native-bindings";
export { createHost, CreateHostError } from "./bind-interactions";
export { bindAuthorizedProjection, type AuthorizedAdmission, type AuthorizedAdmissionDecision } from "./authorized";
export { unwrapOutcome, type DeclaredErrorOutcome, type DirectOutcome, type RequestOutcome } from "./caller-outcomes";
export type {
  CreateHostCallerConfig,
  CreateHostCallers,
  CreateHostOptions,
  CreateHostResult,
  CreateHostIssue,
  NamedCallArguments,
  NamedCallerMethods,
  NamedCallers,
  NamedInteractionMethod,
  NamedTryCallers,
} from "./bind-interactions-types";
export { installInteractions } from "./install";
export { pickProjection, projectAllDirect, projectInteractions } from "./projection";
export { omitProjection, unionProjections, intersectProjections } from "./projection-algebra";
export type { FluentProjection, ProjectionAlgebraMethods } from "./projection-algebra";
export { realizeDirect, realizeRequest } from "./realizations";
export type { DirectRealization, RequestRealization, RealizationEntry, RealizationMap, CoLocatedInstallOptions } from "./realizations";
export type { ControlRequestContributions } from "./request-contributions";
export { rebindProjection, createBindingSlot } from "./rebind";
export type { RebindProjectionResult, BindingSlot, SlotRebindResult } from "./rebind";
export { direct, directRealizationIds } from "./direct";
export { admitAll, admitWhen } from "./admission";
export { bindProjection, restrictBinding } from "./binding";
export { HostError, InteractionFault } from "./errors";

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
