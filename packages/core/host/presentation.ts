import { hashJson, normalizeJson, type JsonObject, type InteractionPresentationOverride, type ProjectionPresentation } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { metadataForProjection } from "./projection";
import { failHost } from "./errors";
import type { Projection, ProjectionSelections } from "./types";

/** Derive schemas from the selected contract; presentation overrides cannot change execution facts. */
export function presentProjection<Selections extends ProjectionSelections>(
  projection: Projection<Selections>,
  overrides?: Readonly<Partial<Record<keyof Selections & string, InteractionPresentationOverride>>>,
): ProjectionPresentation {
  metadataForProjection(projection);
  const presentation = normalizeJson(overrides ?? {}, "presentation.overrides") as Record<string, InteractionPresentationOverride>;
  if (!presentation || Array.isArray(presentation) || typeof presentation !== "object") return failHost("INVALID_ARTIFACT", "presentation.overrides", "overrides must be a record");
  for (const [alias, override] of Object.entries(presentation)) {
    if (!projection.manifest.interactions.some((interaction) => interaction.alias === alias)) return failHost("INVALID_ARTIFACT", alias, "presentation alias is not selected");
    if (!override || typeof override !== "object" || Array.isArray(override) || Object.entries(override).some(([key, value]) => !["title", "description"].includes(key) || typeof value !== "string")) return failHost("INVALID_ARTIFACT", alias, "only title and description may be overridden");
  }
  const descriptors = new Map(projection.program.interactions.map((descriptor) => [descriptor.contract.id, descriptor]));
  const interactions = [...projection.manifest.interactions].sort((left, right) => compareUtf8(left.alias, right.alias)).map((selected) => {
    const descriptor = descriptors.get(selected.interactionId)!;
    const { contract } = descriptor;
    return {
      alias: selected.alias, interactionId: selected.interactionId, contractDigest: selected.expectedContractDigest,
      inputArity: selected.inputArity, modes: selected.modes,
      title: presentation[selected.alias]?.title ?? descriptor.docs.summary ?? selected.alias,
      description: presentation[selected.alias]?.description ?? descriptor.docs.description ?? "",
      inputSchema: contract.inputSchema,
      ...(selected.modes.includes("direct") ? { directOutputSchema: contract.outputSchema } : {}),
      ...(selected.modes.includes("direct") && contract.errorSchema !== undefined ? { errorSchema: contract.errorSchema } : {}),
      reads: contract.reads, changes: contract.changes,
    };
  });
  const identity = normalizeJson({ version: 1, projectionDigest: projection.projectionDigest, interactions }) as JsonObject;
  const presentationDigest = hashJson("boundary.projection-presentation/v1", identity);
  return Object.freeze({ ...identity, presentationDigest }) as unknown as ProjectionPresentation;
}
