import { bindingDescriptions, type BindingInteractionDescription } from "@foxworth/boundary/program";
import { assertProjectionBinding } from "./binding";
import type { ProjectionBinding } from "./types";

/** Snapshot only the selected public contracts of an authentic native Binding. */
export function describeBinding<Context>(binding: ProjectionBinding<any, Context>): readonly BindingInteractionDescription[] {
  assertProjectionBinding(binding);
  return bindingDescriptions(binding.manifest);
}
