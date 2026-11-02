import type { ProjectionBindingInteraction, ProjectionBindingManifest } from "./artifacts";
import type { InteractionDescriptor } from "./program";
import { normalizeJson } from "./json";

/** Public selected data. It conveys no liveness, permission, or implementation capability. */
export interface BindingInteractionDescription extends ProjectionBindingInteraction {
  readonly expected: InteractionDescriptor;
  readonly actual: InteractionDescriptor;
}

/** Join declared pins from a checked manifest; this function does not authenticate its source. */
export function bindingDescriptions(
  manifest: ProjectionBindingManifest,
): readonly BindingInteractionDescription[] {
  const expected = new Map(manifest.expectedProgram.interactions.map(entry => [entry.contract.id, entry]));
  const actual = new Map(manifest.actualProgram.interactions.map(entry => [entry.contract.id, entry]));
  return Object.freeze(manifest.interactions.map(selection => {
    const expectedDescriptor = expected.get(selection.interactionId);
    const actualDescriptor = actual.get(selection.interactionId);
    if (expectedDescriptor?.contractDigest !== selection.expectedContractDigest
      || actualDescriptor?.contractDigest !== selection.actualContractDigest) {
      throw new TypeError("Binding description requires matching selected contract pins");
    }
    return normalizeJson({ ...selection, expected: expectedDescriptor, actual: actualDescriptor }) as unknown as BindingInteractionDescription;
  }));
}
