import { bindingDescriptions, type BindingInteractionDescription } from "@foxworth/boundary/program";
import { assertBinding } from "./binding";
import type { Binding } from "./types";

/** Snapshot only the selected public contracts of an authentic native Binding. */
export function describeBinding<Context>(binding: Binding<any, Context>): readonly BindingInteractionDescription[] {
  assertBinding(binding);
  return bindingDescriptions(binding.manifest);
}
