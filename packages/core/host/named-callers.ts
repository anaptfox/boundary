import type {
  DirectInteractionCaller,
  InteractionDefinitions,
  Projection,
  ProjectionSelections,
} from "./types";
import type { NamedCallers, NamedTryCallers } from "./bind-interactions-types";

/** Build named methods over the authentic caller returned by a native Binding. */
export function namedCallers<
  Definitions extends InteractionDefinitions,
  Context,
  Callers extends Readonly<Record<string, { readonly direct: readonly (keyof Definitions & string)[] }>>,
>(
  selections: Callers,
  projections: Readonly<Record<string, Projection<ProjectionSelections>>>,
  bindings: Readonly<Record<string, import("./types").ProjectionBinding<any, Context>>>,
): NamedCallers<Definitions, Context, Callers> {
  const result: Record<string, object> = Object.create(null) as Record<string, object>;
  for (const name of Object.keys(selections)) {
    const methods: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
    const projection = projections[name]!;
    const caller = bindings[name]!.connect() as DirectInteractionCaller<any, Context>;
    for (const alias of selections[name]!.direct) {
      const handle = Object.getOwnPropertyDescriptor(projection.handles, alias)?.value;
      if (handle === undefined) throw new TypeError(`Projected handle missing for ${alias}`);
      Object.defineProperty(methods, alias, {
        enumerable: true,
        configurable: false,
        writable: false,
      value: (...args: readonly unknown[]) => caller.direct[alias]!(...args as never),
      });
    }
    result[name] = Object.freeze(methods);
  }
  return Object.freeze(result) as NamedCallers<Definitions, Context, Callers>;
}

export function namedTryCallers<Definitions extends InteractionDefinitions, Context, Callers extends Readonly<Record<string, { readonly direct: readonly (keyof Definitions & string)[] }>>>(
  selections: Callers,
  bindings: Readonly<Record<string, import("./types").ProjectionBinding<any, Context>>>,
): NamedTryCallers<Definitions, Context, Callers> {
  const result: Record<string, object> = Object.create(null) as Record<string, object>;
  for (const name of Object.keys(selections)) {
    const methods: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
    const caller = bindings[name]!.connect() as DirectInteractionCaller<any, Context>;
    for (const alias of selections[name]!.direct) Object.defineProperty(methods, alias, { enumerable: true, configurable: false, writable: false, value: (...args: readonly unknown[]) => caller.try[alias]!(...args as never) });
    result[name] = Object.freeze(methods);
  }
  return Object.freeze(result) as NamedTryCallers<Definitions, Context, Callers>;
}
