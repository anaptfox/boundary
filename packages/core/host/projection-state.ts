import { metadataForHandle } from "./compiled-state";
import { failHost } from "./errors";
import type { ProjectedInteractionHandle, ProjectionInteraction } from "./types";

export const PROJECTION_DOMAIN = "boundary.projection/v1";

export type ProjectionMetadata = Readonly<{
  compiled: object;
  aliases: ReadonlyMap<
    string,
    Readonly<{
      alias: string;
      handle: ProjectedInteractionHandle;
      interaction: ProjectionInteraction;
    }>
  >;
}>;

export const projectionMetadata = new WeakMap<object, ProjectionMetadata>();
export const projectedHandleMetadata = new WeakMap<
  object,
  Readonly<{
    projection: object;
    alias: string;
    source: object;
  }>
>();

export function metadataForProjection(value: unknown): ProjectionMetadata {
  if (value === null || typeof value !== "object") {
    return failHost(
      "INVALID_PROJECTION",
      "projection",
      "an authentic Projection value is required",
    );
  }
  const metadata = projectionMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_PROJECTION",
      "projection",
      "an authentic Projection value is required",
    );
  }
  return metadata;
}

export function metadataForProjectedHandle(value: unknown) {
  if (value === null || typeof value !== "object") return undefined;
  return projectedHandleMetadata.get(value);
}

export function registerProjectionAlgebraResult(
  projection: object,
  aliases: ReadonlyMap<
    string,
    {
      alias: string;
      handle: ProjectedInteractionHandle;
      interaction: ProjectionInteraction;
    }
  >,
  sources: readonly { alias: string; source: object }[],
): void {
  const first = sources[0] && metadataForHandle(sources[0].source);
  projectionMetadata.set(projection, { compiled: first?.compiled ?? {}, aliases });
  for (const { alias, source } of sources) {
    const handle = aliases.get(alias)!.handle;
    projectedHandleMetadata.set(handle, { projection, alias, source });
  }
}
