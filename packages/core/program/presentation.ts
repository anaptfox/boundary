import type { InputArity, InteractionMode } from "./artifacts";
import type { JsonSchema, Sha256Digest } from "./json";

/** An agent-facing view of declared interactions, carrying no availability or authority. */
export interface ProjectionPresentation {
  readonly version: 1;
  readonly projectionDigest: Sha256Digest;
  readonly presentationDigest: Sha256Digest;
  readonly interactions: readonly PresentedInteraction[];
}

export interface PresentedInteraction {
  readonly alias: string;
  readonly interactionId: string;
  readonly contractDigest: Sha256Digest;
  readonly inputArity: InputArity;
  readonly modes: readonly InteractionMode[];
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly directOutputSchema?: JsonSchema;
  readonly errorSchema?: JsonSchema;
  readonly reads: readonly string[];
  readonly changes: readonly string[];
}

export interface InteractionPresentationOverride {
  readonly title?: string;
  readonly description?: string;
}
