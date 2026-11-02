import type {
  InteractionMode,
  ProjectedInteractionHandle,
  Projection,
  ProjectionBindingManifest,
  ProjectionBindingInteraction,
} from "@foxworth/boundary";
import { type CheckedHandoff } from "@foxworth/boundary/handoff";
import { bindingDescriptions, isInteractionId, isSha256Digest, type JsonObject, type InteractionDescriptor } from "@foxworth/boundary/program";
import { snapshotJson } from "#program/internal";
import { AdapterError } from "./errors";

export type AnyProjectedInteractionHandle = ProjectedInteractionHandle<any, any, any>;

export type ResolvedBindingInteraction<
  Handle extends AnyProjectedInteractionHandle = AnyProjectedInteractionHandle,
> = Readonly<{
  handle: Handle;
  mode: InteractionMode;
  expected: InteractionDescriptor;
  actual: InteractionDescriptor;
  binding: ProjectionBindingInteraction;
}>;

export type BindingResolution = Readonly<{
  handoff: CheckedHandoff<any>;
  manifest: ProjectionBindingManifest;
  interactions: ReadonlyMap<string, ResolvedBindingInteraction>;
}>;

export type ResolvedProjectionInteraction<
  Handle extends AnyProjectedInteractionHandle = AnyProjectedInteractionHandle,
> = Readonly<{
  handle: Handle;
  mode: InteractionMode;
  descriptor: InteractionDescriptor;
}>;

export type ProjectionResolution = Readonly<{
  projection: Projection<any>;
  interactions: ReadonlyMap<string, ResolvedProjectionInteraction>;
}>;

function fail(
  code: ConstructorParameters<typeof AdapterError>[0],
  path: string,
  message: string,
): never {
  throw new AdapterError(code, path, message);
}

export function interactionKey(interactionId: string, mode: InteractionMode): string {
  return `${interactionId}\u0000${mode}`;
}

/** Snapshot the public data carried by a projected handle. */
const projectedHandles = new WeakSet<object>();

export function snapshotProjectedHandle<
  Handle extends AnyProjectedInteractionHandle,
>(value: Handle, path = "interaction"): Handle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_DECLARATION", path, "a projected interaction handle is required");
  }
  if (projectedHandles.has(value)) {
    return value;
  }
  const owned = snapshotJson(value, {
    path,
    fail: (failure) => fail("INVALID_DECLARATION", failure.path, failure.message),
  }) as JsonObject;
  const interactionId = owned.interactionId;
  const contractDigest = owned.contractDigest;
  const inputArity = owned.inputArity;
  const modes = owned.modes;
  if (!isInteractionId(interactionId)) {
    return fail("INVALID_DECLARATION", `${path}.interactionId`, "interactionId is invalid");
  }
  if (!isSha256Digest(contractDigest)) {
    return fail("INVALID_DECLARATION", `${path}.contractDigest`, "contractDigest is invalid");
  }
  if (inputArity !== 0 && inputArity !== 1) {
    return fail("INVALID_DECLARATION", `${path}.inputArity`, "inputArity must be 0 or 1");
  }
  if (
    !Array.isArray(modes) ||
    modes.length === 0 ||
    modes.some((mode) => mode !== "direct" && mode !== "request") ||
    new Set(modes).size !== modes.length
  ) {
    return fail("INVALID_DECLARATION", `${path}.modes`, "modes must be a non-empty unique direct/request list");
  }
  const snapshot = Object.freeze({
    interactionId,
    contractDigest,
    inputArity,
    modes: Object.freeze([...modes]),
  }) as unknown as Handle;
  projectedHandles.add(snapshot);
  return snapshot;
}

export function modeForHandle(
  handle: AnyProjectedInteractionHandle,
  requested: InteractionMode | undefined,
  path: string,
): InteractionMode {
  if (requested !== undefined) {
    if (!handle.modes.includes(requested)) {
      return fail("INTERACTION_NOT_EXPOSED", path, `${requested} mode is not selected by this handle`);
    }
    return requested;
  }
  if (handle.modes.length !== 1) {
    return fail("INVALID_DECLARATION", path, "mode is required when a handle exposes both direct and request");
  }
  return handle.modes[0]!;
}

export async function compileBindingResolution(
  handoff: CheckedHandoff<any>,
  selected: readonly Readonly<{
    handle: AnyProjectedInteractionHandle;
    mode: InteractionMode;
  }>[],
): Promise<BindingResolution> {
  const manifest = handoff.manifest;
  const descriptions = bindingDescriptions(manifest);
  const interactions = new Map<string, ResolvedBindingInteraction>();
  for (const [index, declaration] of selected.entries()) {
    const handle = snapshotProjectedHandle(declaration.handle, `interactions[${index}].handle`);
    if (!handle.modes.includes(declaration.mode)) {
      fail("INTERACTION_NOT_EXPOSED", `interactions[${index}].mode`, "mode is absent from the projected handle");
    }
    const description = descriptions.find(
      (candidate) => candidate.interactionId === handle.interactionId && candidate.mode === declaration.mode,
    );
    if (!description) {
      fail("INTERACTION_NOT_EXPOSED", `interactions[${index}]`, `${handle.interactionId} ${declaration.mode} is absent from this Binding`);
    }
    const { expected: expectedDescriptor, actual: actualDescriptor, ...binding } = description;
    if (
      handle.contractDigest !== binding.expectedContractDigest ||
      handle.inputArity !== binding.inputArity
    ) {
      fail("STALE_REFERENCE", `interactions[${index}]`, "projected handle does not match the Binding's expected contract and arity");
    }
    const key = interactionKey(handle.interactionId, declaration.mode);
    if (interactions.has(key)) {
      continue;
    }
    interactions.set(key, Object.freeze({
      handle,
      mode: declaration.mode,
      expected: expectedDescriptor,
      actual: actualDescriptor,
      binding,
    }));
  }
  return Object.freeze({ handoff, manifest, interactions });
}

export async function compileProjectionResolution(
  projection: Projection<any>,
  selected: readonly Readonly<{
    handle: AnyProjectedInteractionHandle;
    mode: InteractionMode;
  }>[],
): Promise<ProjectionResolution> {
  if (!projection || typeof projection !== "object" || !projection.manifest) {
    return fail("INVALID_DECLARATION", "projection", "an authentic Projection is required");
  }
  const descriptors = new Map(
    projection.program.interactions.map((descriptor) => [descriptor.contract.id, descriptor]),
  );
  const projectionInteractions = new Map(
    projection.interactions.map((interaction) => [interaction.interactionId, interaction]),
  );
  const interactions = new Map<string, ResolvedProjectionInteraction>();
  for (const [index, declaration] of selected.entries()) {
    const handle = snapshotProjectedHandle(declaration.handle, `interactions[${index}].handle`);
    const interaction = projectionInteractions.get(handle.interactionId);
    const descriptor = descriptors.get(handle.interactionId);
    if (
      !interaction ||
      !descriptor ||
      interaction.expectedContractDigest !== handle.contractDigest ||
      interaction.inputArity !== handle.inputArity ||
      !interaction.modes.includes(declaration.mode)
    ) {
      fail("INTERACTION_NOT_EXPOSED", `interactions[${index}]`, "handle and mode are absent from this Projection");
    }
    const key = interactionKey(handle.interactionId, declaration.mode);
    if (interactions.has(key)) {
      continue;
    }
    interactions.set(key, Object.freeze({ handle, mode: declaration.mode, descriptor }));
  }
  return Object.freeze({ projection, interactions });
}
