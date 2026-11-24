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
  compileProjectionResolution,
  modeForHandle,
  interactionKey,
  snapshotProjectedHandle,
  type AnyProjectedInteractionHandle,
  type BindingResolution,
  type ProjectionResolution,
  type ResolvedBindingInteraction,
  type ResolvedProjectionInteraction,
} from "./resolution";

export { validatePortableValue } from "./schema";
