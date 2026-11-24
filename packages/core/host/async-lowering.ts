import type { InteractionDefinitions, MaybePromise } from "./types";

/** Lower host-native declarations asynchronously before compiling a snapshot. */
export interface AsyncInteractionLowering<
  Native extends Readonly<Record<string, unknown>>,
  Definitions extends InteractionDefinitions,
> {
  lower<Alias extends keyof Native & string>(
    value: Native[Alias],
    context: Readonly<{ alias: Alias }>,
  ): MaybePromise<Definitions[Alias]>;
}
