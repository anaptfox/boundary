import { failHost } from "./errors";
import { metadataForCompiled } from "./compiled-state";
import type {
  CompiledInteractions,
  InteractionDefinitions,
  InteractionHandle,
  ProjectionSelection,
  RealizationId,
  RealizationIds,
} from "./types";

/** Closed projection selection for one compiled handle in direct mode. */
export function direct<Handle extends InteractionHandle>(
  handle: Handle,
): ProjectionSelection<Handle, readonly ["direct"]> {
  return Object.freeze({
    interaction: handle,
    modes: Object.freeze(["direct"] as const),
  });
}

export type DirectRealizationIds<Definitions extends InteractionDefinitions> = {
  readonly [Alias in keyof Definitions]: Readonly<{
    readonly direct: RealizationId;
  }>;
};

/**
 * Host-owned direct realization IDs keyed by compiled alias and release revision.
 * The host still passes this record into `installInteractions`.
 */
export function directRealizationIds<
  Definitions extends InteractionDefinitions,
>(
  compiled: CompiledInteractions<Definitions>,
  revision: string,
): DirectRealizationIds<Definitions> {
  metadataForCompiled(compiled);
  if (typeof revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,127}$/u.test(revision)) {
    return failHost("INVALID_REALIZATION_ID", "revision", "an explicit host-issued realization revision is required");
  }
  const ids: Record<string, Readonly<{ direct: RealizationId }>> = {};
  for (const [alias, handle] of Object.entries(compiled.handles)) {
    const id = `${handle.interactionId}:direct:${revision}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(id)) {
      return failHost("INVALID_REALIZATION_ID", `realizationIds.${alias}`, "interaction and revision must form a valid realization ID; supply explicit IDs for other interaction names");
    }
    ids[alias] = Object.freeze({ direct: id });
  }
  return Object.freeze(ids) as DirectRealizationIds<Definitions> &
    RealizationIds;
}
