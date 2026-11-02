import type { Catalog } from "./catalog";
import type { JsonSchema, JsonValue, Sha256Digest } from "./json";
import type { Program } from "./program";

export type InteractionMode = "direct" | "request";
export type InputArity = 0 | 1;
export type InstallationId = string;
export type RealizationId = string;

/** Version 1 live-installation identity. Implementation code stays off this value. */
export interface InstallationManifest {
  readonly version: 1;
  readonly installationId: InstallationId;
  readonly program: Program;
  readonly catalog: Catalog;
  readonly installationDigest: Sha256Digest;
}

export interface SurfaceInteraction {
  readonly alias: string;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly inputArity: InputArity;
  readonly modes: readonly InteractionMode[];
}

/** Version 1 desired caller surface. Realizations are not required. */
export interface SurfaceManifest {
  readonly version: 1;
  readonly program: Program;
  readonly interactions: readonly SurfaceInteraction[];
  readonly projectionDigest: Sha256Digest;
}

export interface BindingInteraction {
  readonly alias: string;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly inputArity: InputArity;
  readonly mode: InteractionMode;
  readonly realizationId: RealizationId;
  readonly request?: Readonly<{
    readonly controlDigest: Sha256Digest;
    readonly previewSchema: JsonSchema;
  }>;
}

/** Version 1 handshake published by one successful Binding. */
export interface BindingManifest {
  readonly version: 1;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: InstallationId;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly expectedProgram: Program;
  readonly actualProgram: Program;
  readonly actualCatalog: Catalog;
  readonly interactions: readonly BindingInteraction[];
}

export type RawInvocationResult =
  | Readonly<{ kind: "returned"; value: JsonValue }>
  | Readonly<{
      kind: "declared-error";
      code: string;
      details: JsonValue;
    }>
  | Readonly<{ kind: "proposed"; proposal: JsonValue }>
  | Readonly<{ kind: "denied"; code: string }>
  | Readonly<{ kind: "fault"; cause: string }>;

/** Version 1 identity-bearing outcome before Handoff sanitizes the wire envelope. */
/**
 * What is known about one invocation's consequence. One vocabulary for the
 * whole model: Binding outcomes, Handoff outcomes, native dispatch faults,
 * and guest faults all report in these four words.
 *
 * - `not-started`: the effect provably never began;
 * - `not-completed`: the effect began and the dispatcher proved it did not
 *   reach its declared completion (this does not prove no partial effect);
 * - `completed`: a validated return or declared error;
 * - `unknown`: the effect may have started and nothing proves either way.
 *
 * Neither `not-completed` nor `unknown` is permission to retry. Control's
 * durable `uncertain` is the persisted form of `unknown`.
 */
export type InvocationCertainty =
  | "not-started"
  | "not-completed"
  | "completed"
  | "unknown";

export interface RawInvocationOutcome {
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: InstallationId;
  readonly installationDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly mode: InteractionMode;
  readonly realizationId: RealizationId;
  readonly certainty: InvocationCertainty;
  readonly result: RawInvocationResult;
}
