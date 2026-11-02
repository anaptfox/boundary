import { metadataForCompiled } from "./compile";
import { failHost } from "./errors";
import type { NativeDispatchOutcome } from "./native-outcome";
import type {
  CompiledInteractions, InteractionDefinitions, MaybePromise,
  NativeDispatchRequest, NativeInteractionBinding,
} from "./types";

export type NativeDispatchers<Definitions extends InteractionDefinitions, Targets, Context> = {
  readonly [Alias in keyof Definitions]: (
    request: NativeDispatchRequest<Definitions[Alias], Targets[Alias & keyof Targets], Context>,
  ) => MaybePromise<NativeDispatchOutcome<Definitions[Alias]>>;
};

/** Correlate each compiled alias with its native target and dispatch types. */
export function bindNativeInteractions<
  Definitions extends InteractionDefinitions,
  Targets extends { readonly [Alias in keyof Definitions]: unknown },
  Context = void,
>(
  compiled: CompiledInteractions<Definitions>,
  targets: Targets,
  dispatchers: NativeDispatchers<Definitions, Targets, Context>,
): readonly {
  [Alias in keyof Definitions]: NativeInteractionBinding<Definitions[Alias], Targets[Alias], Context>
}[keyof Definitions][] {
  metadataForCompiled(compiled);
  const aliases = Object.keys(compiled.handles);
  function properties(record: unknown, path: string): void {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      failHost("INVALID_INSTALLATION", path, "native binding maps must be closed records");
    }
    const keys = Reflect.ownKeys(record as object);
    if (keys.length !== aliases.length || keys.some(key => {
      const property = Object.getOwnPropertyDescriptor(record, key)!;
      return typeof key !== "string" || !aliases.includes(key) || !property.enumerable || !("value" in property);
    })) {
      failHost("INVALID_INSTALLATION", path, "native binding maps must contain exactly the compiled aliases as data properties");
    }
  }
  properties(targets, "targets");
  properties(dispatchers, "dispatchers");
  function entry<Alias extends keyof Definitions>(alias: Alias) {
    const dispatch = dispatchers[alias];
    if (typeof dispatch !== "function") {
      failHost("INVALID_INSTALLATION", `dispatchers.${String(alias)}`, "native dispatch must be a function");
    }
    return Object.freeze({ interaction: compiled.handles[alias], target: targets[alias], dispatch });
  }
  return Object.freeze(aliases.map(alias => entry(alias as keyof Definitions)));
}
