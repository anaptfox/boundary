import { type InvocationCoordinator } from "./coordination";
import { type InvocationObserver } from "./observation";
import { type InteractionDescriptor } from "@foxworth/boundary/program";
import type { ActualInteractionResolution, Admission, InteractionInstallation, InteractionMode, ProjectionBindingManifest, ProjectionBindingInteraction, RealizationId, ResolvedBindingInteraction } from "./types";

export type ModeResolution<Context> = Readonly<{
  manifest: ProjectionBindingInteraction;
  expected: InteractionDescriptor;
  actual: ActualInteractionResolution<Context>;
  sameContract: boolean;
}>;

export type InteractionResolution<Context> = Readonly<{
  public: ResolvedBindingInteraction;
  byMode: ReadonlyMap<InteractionMode, ModeResolution<Context>>;
}>;

export type BindingMetadata<Context> = Readonly<{
  projection: object;
  installation: InteractionInstallation<Context>;
  installationState: { revoked: boolean };
  manifest: ProjectionBindingManifest;
  admission: Admission<Context>;
  observer?: InvocationObserver<Context>;
  coordinator?: InvocationCoordinator<Context>;
  interactions: ReadonlyMap<string, InteractionResolution<Context>>;
  state: { revoked: boolean };
  parent?: BindingMetadata<Context>;
}>;

export type ModeEntry<Context> = Readonly<{
  alias: string;
  expected: InteractionDescriptor;
  actual: ActualInteractionResolution<Context>;
  mode: InteractionMode;
  realizationId: RealizationId;
}>;

export const bindingMetadata = new WeakMap<object, BindingMetadata<any>>();

export const resolvedMetadata = new WeakMap<
  object,
  Readonly<{ binding: object; interactionId: string }>
>();

export function bindingRevoked(metadata: BindingMetadata<any>): boolean {
  let current: BindingMetadata<any> | undefined = metadata;
  while (current !== undefined) {
    if (current.state.revoked || current.installationState.revoked) return true;
    current = current.parent;
  }
  return false;
}
