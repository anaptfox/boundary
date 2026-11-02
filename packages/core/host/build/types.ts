import type { Program } from "@foxworth/boundary/program";
import type {
  CompiledInteractions,
  MaybePromise,
  InteractionDefinitions,
  InteractionInstallation,
  CompiledSurface,
  Binding,
} from "../types";

export type InteractionModuleLoader = (entry: URL) => MaybePromise<unknown>;

export interface LoadInteractionsEntryOptions {
  readonly entry: string | URL;
  readonly loadModule?: InteractionModuleLoader;
}

export interface LoadedInteractions<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
> {
  readonly interactions: Definitions;
}

export interface NamedHostArtifact<Value> {
  readonly name: string;
  readonly value: Value;
}

/** One explicit exported type used by a generated reference module. */
export interface HostArtifactTypeSource {
  readonly module: string;
  readonly export: string;
}

/** Runtime-authenticated interactions plus their trusted type-only module name. */
export interface HostArtifactInteractionSource extends HostArtifactTypeSource {
  readonly compiled: CompiledInteractions<any>;
}

/** Source/type facts for one durable Surface alias. */
export interface HostArtifactReferenceMember {
  /** Member of the exported interaction-definition record. */
  readonly definition: string;
  /** Full public request result type; required for Binding requests, forbidden for offline Surface requests. */
  readonly requestOutput?: HostArtifactTypeSource;
}

/**
 * Explicit metadata for one structural typed-reference module.
 *
 * Declaration facts come from a CompiledSurface; request preview types require a Binding. TypeScript source
 * locations are supplied by the caller and are never inferred from values.
 */
export type HostArtifactReferenceModule = {
  readonly source: HostArtifactInteractionSource;
  readonly exportName: string;
  readonly members: Readonly<
    Record<string, HostArtifactReferenceMember>
  >;
} & (
  | { readonly projection: CompiledSurface<any>; readonly binding?: never }
  | { readonly binding: Binding<any, any>; readonly projection?: never }
);

export interface RenderHostArtifactsOptions {
  readonly program?: NamedHostArtifact<Program>;
  readonly projections?: Readonly<
    Record<string, NamedHostArtifact<CompiledSurface<any>>>
  >;
  readonly installations?: Readonly<
    Record<string, NamedHostArtifact<InteractionInstallation<any>>>
  >;
  readonly bindings?: Readonly<
    Record<string, NamedHostArtifact<Binding<any, any>>>
  >;
  readonly references?: Readonly<
    Record<string, NamedHostArtifact<HostArtifactReferenceModule>>
  >;
}

export interface HostArtifactFile {
  readonly path: string;
  readonly bytes: readonly number[];
}

export interface HostArtifactInventory {
  readonly version: 1;
  readonly path: ".boundary-core-host-inventory.json";
  readonly files: readonly string[];
}

export interface HostArtifactSet {
  readonly version: 1;
  readonly files: readonly HostArtifactFile[];
  readonly inventory: HostArtifactInventory;
}

export interface HostArtifactDestinationOptions {
  readonly destination: string | URL;
}

export interface HostArtifactWriteResult {
  readonly written: readonly string[];
  readonly removed: readonly string[];
  readonly inventory: string;
}

export interface HostArtifactCheckResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly changed: readonly string[];
  readonly stale: readonly string[];
}
