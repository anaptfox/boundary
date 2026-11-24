export { BoundaryErrorBase } from "./errors";

export {
  JsonError,
  canonicalJson,
  cloneJson,
  hashJson,
  isSha256Digest,
  normalizeJson,
  sha256,
  type DomainHasher,
  type JsonArray,
  type JsonDiagnosticCode,
  type JsonObject,
  type JsonPrimitive,
  type JsonSchema,
  type JsonValue,
  type Sha256Digest,
} from "./json";

export {
  jsonEquals,
  type SnapshotFailure,
} from "./snapshot";

export {
  SchemaAdapterError,
  type SchemaAdapter,
  type SchemaAdapterDiagnosticCode,
  type SchemaCompilation,
  type SchemaCompilationContext,
  type SchemaRole,
} from "./schema";

export {
  PortableSchemaError,
  isPortableSchema,
  portableSchema,
  validatePortableSchema,
  type PortableSchema,
  type PortableSchemaDiagnosticCode,
  type PortableSchemaValue,
  type SchemaValueIssue,
} from "./validation";

export { validateSchemaValue } from "./schema-value";
export {
  b,
  type ArraySchemaOptions,
  type InferSchema,
  type NumberSchemaOptions,
  type OptionalPortableSchema,
  type StringSchemaOptions,
} from "./schema-builder";

export {
  contractCompatibility,
  type ContractCompatibility,
} from "./compatibility";

export {
  contractChanges,
  type ChangeKind,
  type ContractChange,
  type ContractDelta,
} from "./delta";

export {
  INTERACTION_CONTRACT_DOMAIN,
  INTERACTION_ID_PATTERN,
  PROGRAM_DOMAIN,
  ProgramError,
  composePrograms,
  createInteractionDescriptor,
  createProgram,
  diffPrograms,
  digestInteractionContract,
  digestProgram,
  isInteractionId,
  interactionContractIdentity,
  programIdentity,
  validateProgram,
  type InteractionContract,
  type InteractionContractIdentity,
  type InteractionIdentity,
  type InteractionDescriptor,
  type InteractionDescriptorSource,
  type InteractionDocumentation,
  type Program,
  type ProgramDiagnosticCode,
  type ProgramDiff,
} from "./program";

export {
  CatalogError,
  createCatalog,
  validateCatalog,
  type Catalog,
  type CatalogDirectMode,
  type CatalogDiagnosticCode,
  type CatalogEntry,
  type CatalogRequestMode,
  type CatalogSource,
} from "./catalog";

export {
  DraftError,
  INTERACTION_DRAFT_DOMAIN,
  createDraft,
  isValidDraftTimestamp,
  verifyDraft,
  type Draft,
  type DraftDiagnosticCode,
  type DraftSource,
} from "./draft";

export type {
  InputArity,
  InstallationId,
  InstallationManifest,
  InteractionMode,
  ProjectionBindingManifest,
  ProjectionBindingInteraction,
  ProjectionManifest,
  ProjectionInteraction,
  InvocationCertainty,
  RawInvocationOutcome,
  RawInvocationResult,
  RealizationId,
} from "./artifacts";

export { validateInvocationObservation, type InvocationObservation } from "./observation";

export {
  ExecutionEvidenceError,
  validateExecutionEvidence,
  type EvidenceReference,
  type EvidenceReferenceKind,
  type EvidenceSubjectState,
  type ExecutionEvidence,
  type ExecutionEvidenceDiagnosticCode,
} from "./evidence";

export type { ProjectionPresentation, PresentedInteraction, InteractionPresentationOverride } from "./presentation";
export { bindingDescriptions, type BindingInteractionDescription } from "./binding-description";
export { isInvocationFaultLegal } from "./invocation-fault";
