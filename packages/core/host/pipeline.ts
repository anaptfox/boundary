/**
 * `@foxworth/boundary/pipeline`: the explicit host pipeline.
 *
 * The root export's `surface`, `install`, and `connect` compose these
 * functions and return their artifacts. Import this subpath when a host needs
 * a step the short path does not take: a CompiledSurface it persists or inspects
 * on its own, explicit realization ids, restriction of a live Binding, native
 * dispatch over its own targets, or inspection of candidate artifacts.
 */
export {
  compileInteractions,
  composeCompiledInteractions,
  diffCompiledInteractions,
} from "./compile";
export { implementInteractions } from "./implement";
export { bindNativeInteractions } from "./native-bindings";
export { installInteractions } from "./install";
export { projectInteractions, projectSurface } from "./projection";
export { realizationIdsFor } from "./realization-ids";
export { admitAll, admitWhen } from "./admission";
export { bindSurface, restrictBinding } from "./binding";
export { createCaller } from "./caller";
export { presentSurface } from "./presentation";
export { assessSurface, type SurfaceAssessment } from "./assessment";
export { describeBinding } from "./description";
export {
  publishExecutionEvidence,
  type ExecutionEvidencePublication,
  type ExecutionEvidencePublisher,
} from "./evidence";

export type { AnyCaller, Caller, CallerOfBinding, HandoffSeam, NativeDispatchers } from "./facade-types";
export type { InstallInteractionsOptions } from "./install";
export type { AliasHandleSelections } from "./projection";
export type { InvocationObserver } from "./observation";
export type { InvocationCoordinator, CoordinatedInvocation, InvocationPolicy } from "./coordination";
export type {
  Admission,
  AdmissionDecision,
  AdmissionInteractionView,
  AdmissionRequest,
  BindResult,
  BindingController,
  BindingInvocation,
  CompileInteractionsOptions,
  CompiledInteractions,
  DirectInteractionCaller,
  HandleDefinition,
  HandlesOf,
  ImplementationMap,
  InstallationController,
  InstallationId,
  InstallationManifest,
  InstalledInteractions,
  InteractionCaller,
  InteractionHandle,
  InteractionImplementations,
  InteractionInstallation,
  InteractionLowering,
  InteractionMode,
  NativeDispatchRequest,
  NativeInteractionBinding,
  SurfaceHandles,
  SurfaceHandle,
  CompiledSurface,
  Binding,
  BindingInteraction,
  BindingManifest,
  SurfaceInteraction,
  SurfaceManifest,
  HandleSelection,
  HandleSelections,
  RawInvocationOutcome,
  RawInvocationResult,
  RealizationId,
  RealizationIds,
  RequestInteractionCaller,
  RequestInvocationPolicy,
  ResolvedBindingInteraction,
  ResolvedBindingMode,
  UnrealizedIssue,
  UnrealizedReason,
  UnrealizedReport,
} from "./types";
export type { NativeDispatchOutcome, NativeDispatchOutcomes } from "./native-outcome";
