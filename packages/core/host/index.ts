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
  CallerCallAliases,
  CallerContext,
  CallerDefinitions,
  CallerFor,
  CallerOfBinding,
  CallerProposeAliases,
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

export type {
  Admission,
  AdmissionDecision,
  AdmissionInteractionView,
  AdmissionRequest,
  AnyInteractionDefinition,
  AuthoringSchema,
  BindingInteraction,
  BindingManifest,
  DefinitionArity,
  DefinitionErrors,
  DefinitionInput,
  DefinitionOutput,
  ErrorSchemas,
  ErrorValues,
  InputArity,
  InstallationId,
  InstallationManifest,
  InteractionDefinition,
  InteractionDefinitions,
  InteractionMode,
  MaybePromise,
  RealizationId,
  SchemaAdapter,
  SchemaValue,
  StandardSchema,
  UnrealizedIssue,
  UnrealizedReason,
  UnrealizedReport,
} from "./types";

export type {
  HostDiagnosticCode,
  InteractionFaultCause,
  InteractionFaultCertainty,
} from "./errors";
