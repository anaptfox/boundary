export {
  AdapterError,
  isDomainErrorFor,
  RemoteDomainError,
  RemoteInvocationError,
  RemoteProtocolRejection,
  RemoteExecutionError,
  RemoteProtocolError,
  type AdapterDiagnosticCode,
  type InteractionDeclaredError,
  type RemoteInteractionDomainError,
  type RemoteInteractionError,
} from "./errors";

export {
  compileExposure,
  compileHandoffExposure,
  executeExposedInteraction,
  invokePreparedInteraction,
  prepareExposedInteraction,
  executeSerializedInvocation,
  faultResult,
  sanitizedInternalResult,
  statusForRemoteResult,
  type ExposedInteraction,
  type Exposure,
  type InteractionHasInput,
  type InteractionInput,
  type InteractionOutput,
  type RemoteCallResult,
  type SerializedInvocation,
} from "./remote";

export {
  compileBindingResolution,
  compileSurfaceResolution,
  modeForHandle,
  interactionKey,
  snapshotSurfaceHandle,
  type AnySurfaceHandle,
  type BindingResolution,
  type SurfaceResolution,
  type ResolvedBindingInteraction,
  type ResolvedSurfaceInteraction,
} from "./resolution";

export { validatePortableValue } from "./schema";

export {
  modeForVerb,
  resolveSelection,
  seamOf,
  selectionsOf,
  verbForMode,
  type InteractionSource,
  type InteractionVerb,
  type ResolvedSelection,
  type SourceAliases,
  type SourceDefinition,
  type SourceHasInput,
  type SourceInput,
  type SourceOutput,
  type SourceVerbs,
} from "./source";

export { describeOutcome, outcomeText, type OutcomeDescription, type OutcomeKind } from "./describe";
