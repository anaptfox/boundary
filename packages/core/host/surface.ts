import { compileInteractions } from "./compile";
import { snapshotDefinitions } from "./definition-snapshot";
import { failHost } from "./errors";
import type { CompiledInteractions, InteractionDefinitions, SchemaAdapter } from "./types";

declare const surfaceTypes: unique symbol;

/**
 * Caller object keys that are not interaction methods. An interaction alias
 * with one of these names cannot be exposed on a caller, so `surface` refuses
 * it at both the type and the runtime level.
 */
export type ReservedCallerKey = "propose" | "manifest" | "handoff" | "then";

/** Aliases of a declaration record that may become caller methods. */
export type SurfaceAlias<Definitions extends InteractionDefinitions> =
  Exclude<keyof Definitions & string, ReservedCallerKey>;

/**
 * A Surface is the selection one caller is allowed to see: which interactions
 * it may `call` (wire mode `direct`) and which it may `propose` (wire mode
 * `request`). It is inert data over a declaration record. It names no
 * implementation, admission, or context, and it may stay unconnected forever.
 *
 * On the wire and in artifacts this selection is still called a `projection`;
 * see the mapping table in the glossary.
 */
export interface Surface<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
  Call extends SurfaceAlias<Definitions> = never,
  Propose extends SurfaceAlias<Definitions> = never,
> {
  readonly definitions: Definitions;
  /** Aliases callable in direct mode, in declaration order. */
  readonly call: readonly Call[];
  /** Aliases proposable in request mode, in declaration order. */
  readonly propose: readonly Propose[];
  readonly [surfaceTypes]?: {
    readonly definitions: Definitions;
    readonly call: Call;
    readonly propose: Propose;
  };
}

/** Any Surface, for adapter and facade signatures that accept every selection. */
export type AnySurface = Surface<InteractionDefinitions, any, any>;

export type SurfaceSelection<
  Definitions extends InteractionDefinitions,
  Call extends SurfaceAlias<Definitions>,
  Propose extends SurfaceAlias<Definitions>,
> = Readonly<{
  call?: readonly Call[];
  propose?: readonly Propose[];
}>;

const surfaces = new WeakSet<object>();
const compilations = new WeakMap<object, Promise<CompiledInteractions<InteractionDefinitions>>>();
const RESERVED: readonly string[] = ["propose", "manifest", "handoff", "then"];

function aliasList(
  value: unknown,
  path: string,
  aliases: readonly string[],
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    return failHost("INVALID_SURFACE", path,
      `expected an array of interaction aliases; found ${typeof value}; fix: write ${path} as ["alias", ...]`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const alias: unknown = descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
    if (typeof alias !== "string") {
      return failHost("INVALID_SURFACE", `${path}[${index}]`,
        `expected a string alias; found ${alias === undefined ? "a hole or accessor" : typeof alias}; fix: list only alias strings`);
    }
    if (!aliases.includes(alias)) {
      return failHost("INVALID_SURFACE", `${path}[${index}]`,
        `expected one of ${aliases.join(", ")}; found "${alias}"; fix: select an alias declared in the record passed to surface()`);
    }
    if (RESERVED.includes(alias)) {
      return failHost("INVALID_SURFACE", `${path}[${index}]`,
        `expected an alias that can be a caller method; found reserved name "${alias}"; fix: rename the alias in the declaration record`);
    }
    if (seen.has(alias)) {
      return failHost("INVALID_SURFACE", `${path}[${index}]`,
        `expected each alias once; found "${alias}" twice; fix: remove the duplicate`);
    }
    seen.add(alias);
    result.push(alias);
  }
  // Keep declaration order so method listings are stable across callers.
  return Object.freeze(aliases.filter((alias) => seen.has(alias)));
}

/**
 * Select what one caller may see from a declaration record.
 *
 * `call` lists the aliases the caller may invoke directly; `propose` lists the
 * aliases it may only propose, yielding a Proposal record for host review.
 * An alias may appear in both. Nothing is selected by default: an empty
 * selection is an empty surface, and `surface.all(record)` is how a host
 * spells out "every interaction, callable".
 */
export function surface<
  const Definitions extends InteractionDefinitions,
  const Call extends SurfaceAlias<Definitions> = never,
  const Propose extends SurfaceAlias<Definitions> = never,
>(
  definitions: Definitions,
  selection: SurfaceSelection<Definitions, Call, Propose>,
): Surface<Definitions, Call, Propose> {
  const snapshot = snapshotDefinitions(definitions) as Definitions;
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    return failHost("INVALID_SURFACE", "surface.selection",
      "expected { call?: [...], propose?: [...] }; found a non-object; fix: pass a selection record");
  }
  for (const key of Reflect.ownKeys(selection)) {
    if (key !== "call" && key !== "propose") {
      return failHost("INVALID_SURFACE", `surface.selection.${String(key)}`,
        `expected only call and propose; found "${String(key)}"; fix: remove it`);
    }
  }
  const aliases = Object.keys(snapshot);
  const call = aliasList(selection.call, "surface.selection.call", aliases) as readonly Call[];
  const propose = aliasList(selection.propose, "surface.selection.propose", aliases) as readonly Propose[];
  const value = Object.freeze({ definitions: snapshot, call, propose }) as Surface<Definitions, Call, Propose>;
  surfaces.add(value);
  return value;
}

/** Every interaction of the record, callable. Spelled out; never a default. */
surface.all = function all<const Definitions extends InteractionDefinitions>(
  definitions: Definitions,
): Surface<Definitions, SurfaceAlias<Definitions>> {
  const snapshot = snapshotDefinitions(definitions);
  const reserved = Object.keys(snapshot).filter((alias) => RESERVED.includes(alias));
  if (reserved.length > 0) {
    return failHost("INVALID_SURFACE", "surface.all",
      `expected aliases that can be caller methods; found reserved ${reserved.join(", ")}; fix: rename them or select explicitly`);
  }
  return surface(definitions, { call: Object.keys(snapshot) as SurfaceAlias<Definitions>[] });
};

/** Refuse a structural look-alike: only values minted by `surface` connect. */
export function requireSurface(value: unknown, path: string): AnySurface {
  if (value === null || typeof value !== "object" || !surfaces.has(value)) {
    return failHost("INVALID_SURFACE", path,
      "expected a Surface created by surface(); found another value; fix: pass the value surface() returned");
  }
  return value as AnySurface;
}

/**
 * The Surface's own compilation: the expected side of a Binding. It is derived
 * from the Surface's declarations, never from the Installation it connects to,
 * so a changed installed contract is refused rather than silently adopted.
 */
export function compiledSurface(
  value: AnySurface,
  schemas: readonly SchemaAdapter<any>[] | undefined,
): Promise<CompiledInteractions<InteractionDefinitions>> {
  if (schemas !== undefined) return compileInteractions(value.definitions, { schemas });
  let pending = compilations.get(value);
  if (pending === undefined) {
    pending = compileInteractions(value.definitions);
    compilations.set(value, pending);
  }
  return pending;
}
