import { bindProjection } from "./binding";
import { failHost } from "./errors";
import type { Admission, BindingController, InteractionInstallation, Projection, ProjectionBinding, ProjectionBindingManifest, ProjectionSelections, UnrealizedReport } from "./types";
import type { InvocationCoordinator } from "./coordination";
import type { InvocationObserver } from "./observation";

type BindOptions<Context> = Readonly<{ admit: Admission<Context>; observation?: InvocationObserver<Context>; coordinate?: InvocationCoordinator<Context> }>;
export type RebindProjectionResult<Handles extends Record<string, any>, Context> =
  | Readonly<{ status: "rebound"; binding: ProjectionBinding<Handles, Context>; controller: BindingController; previousBindingDigest: string; previousRevoked: boolean }>
  | Readonly<{ status: "unrealized"; report: UnrealizedReport; previousBindingDigest: string; previousPreserved: boolean }>;

export function rebindProjection<Selections extends ProjectionSelections, Context>(options: Readonly<{
  projection: Projection<Selections>; previousBinding: ProjectionBinding<any, Context>; previousController: BindingController;
  nextInstallation: InteractionInstallation<Context>; admit: Admission<Context>; observation?: InvocationObserver<Context>; coordinate?: InvocationCoordinator<Context>;
}>): RebindProjectionResult<Projection<Selections>["handles"], Context> {
  const { projection, previousBinding, previousController, nextInstallation, admit, observation, coordinate } = options;
  const previousBindingDigest = previousBinding.manifest.bindingDigest;
  const next = bindProjection(projection, nextInstallation, { admit, observation, coordinate });
  if (next.status === "unrealized") return Object.freeze({ status: "unrealized", report: next.report, previousBindingDigest, previousPreserved: !previousController.revoked });
  const previousRevoked = previousController.revoke();
  return Object.freeze({ status: "rebound", binding: next.binding, controller: next.controller, previousBindingDigest, previousRevoked });
}

export interface BindingSlot<Handles extends Record<string, any>, Context> {
  readonly current: ProjectionBinding<Handles, Context>;
  readonly projection: Projection<any>;
  readonly manifest: ProjectionBindingManifest;
  readonly revoked: boolean;
  revoke(): boolean;
  subscribe(listener: (slot: BindingSlot<Handles, Context>) => void): () => void;
  rebind(nextInstallation: InteractionInstallation<Context>, options: BindOptions<Context>): SlotRebindResult;
  rebindProjection(nextProjection: Projection<any>, nextInstallation: InteractionInstallation<Context>, options: BindOptions<Context>): SlotRebindResult;
}
export type SlotRebindResult =
  | Readonly<{ status: "rebound"; previousBindingDigest: string; nextBindingDigest: string; previousRevoked: boolean }>
  | Readonly<{ status: "unrealized"; report: UnrealizedReport }>;

export function createBindingSlot<Handles extends Record<string, any>, Context>(projection: Projection<any>, initialBound: Readonly<{ binding: ProjectionBinding<Handles, Context>; controller: BindingController }>): BindingSlot<Handles, Context> {
  let activeProjection = projection, activeBinding = initialBound.binding, activeController = initialBound.controller;
  const listeners = new Set<(slot: BindingSlot<Handles, Context>) => void>();
  const slot: BindingSlot<Handles, Context> = {
    get current() { return activeBinding; }, get projection() { return activeProjection; }, get manifest() { return activeBinding.manifest; }, get revoked() { return activeController.revoked; },
    revoke() { return activeController.revoke(); },
    subscribe(listener) { if (typeof listener !== "function") return failHost("INVALID_INSTALLATION", "BindingSlot.subscribe", "listener must be a function"); listeners.add(listener); return () => listeners.delete(listener); },
    rebind(installation, options) { return slot.rebindProjection(activeProjection, installation, options); },
    rebindProjection(nextProjection, installation, options) {
      const previousBindingDigest = activeBinding.manifest.bindingDigest;
      const next = bindProjection(nextProjection, installation, options);
      if (next.status === "unrealized") return Object.freeze({ status: "unrealized", report: next.report });
      const previousRevoked = activeController.revoke();
      activeProjection = nextProjection; activeBinding = next.binding as ProjectionBinding<Handles, Context>; activeController = next.controller;
      for (const listener of [...listeners]) listener(slot);
      return Object.freeze({ status: "rebound", previousBindingDigest, nextBindingDigest: next.binding.manifest.bindingDigest, previousRevoked });
    },
  };
  return Object.freeze(slot);
}
