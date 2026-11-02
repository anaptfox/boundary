import type { AnyCaller, AnyInteractionDefinition, CallerCallAliases, CallerDefinitions, CallerProposeAliases, DefinitionArity, DefinitionInput, DefinitionOutput, InteractionMode, BindingManifest } from "@foxworth/boundary";
import type { HandleDefinition, CompiledSurface, HandleSelections } from "@foxworth/boundary/pipeline";
import { AdapterError } from "./errors";
import { snapshotSurfaceHandle, type AnySurfaceHandle } from "./resolution";

/** Method verbs an adapter declaration uses; they map onto the wire modes `direct` and `request`. */
export type InteractionVerb = "call" | "propose";

/**
 * Where an adapter declaration selects an interaction from: a connected caller
 * (its Binding manifest), a remote Binding manifest a browser client
 * inspected, or, for offline description, a CompiledSurface artifact.
 */
export type InteractionSource = AnyCaller | CompiledSurface<any> | BindingManifest;

type ProjectionAliases<S> = S extends CompiledSurface<infer Selections extends HandleSelections>
  ? keyof Selections & string
  : never;
type ProjectionDefinition<S, Alias extends string> = S extends CompiledSurface<infer Selections extends HandleSelections>
  ? Alias extends keyof Selections ? HandleDefinition<Selections[Alias]["interaction"]> : never
  : never;
type ProjectionVerbs<S, Alias extends string> = S extends CompiledSurface<infer Selections extends HandleSelections>
  ? Alias extends keyof Selections
    ? Selections[Alias]["modes"][number] extends infer Mode
      ? Mode extends "direct" ? "call" : Mode extends "request" ? "propose" : never
      : never
    : never
  : never;

type IsManifest<S> = S extends BindingManifest ? (S extends AnyCaller ? false : true) : false;

/** Aliases a source can select; a remote manifest knows them only as strings. */
export type SourceAliases<S> = IsManifest<S> extends true
  ? string
  : S extends CompiledSurface<any>
    ? ProjectionAliases<S>
    : CallerCallAliases<S> | CallerProposeAliases<S>;

/** The declaration behind one alias of a source. */
export type SourceDefinition<S, Alias extends string> = IsManifest<S> extends true
  ? AnyInteractionDefinition
  : S extends CompiledSurface<any>
    ? ProjectionDefinition<S, Alias>
    : Alias extends keyof CallerDefinitions<S> ? CallerDefinitions<S>[Alias] : never;

/** The verbs one alias of a source supports. */
export type SourceVerbs<S, Alias extends string> = IsManifest<S> extends true
  ? InteractionVerb
  : S extends CompiledSurface<any>
    ? ProjectionVerbs<S, Alias>
    : (Alias extends CallerCallAliases<S> ? "call" : never) | (Alias extends CallerProposeAliases<S> ? "propose" : never);

export type SourceInput<S, Alias extends string> = DefinitionInput<SourceDefinition<S, Alias>>;
export type SourceOutput<S, Alias extends string> = DefinitionOutput<SourceDefinition<S, Alias>>;
export type SourceHasInput<S, Alias extends string> = DefinitionArity<SourceDefinition<S, Alias>> extends 0 ? false : true;

export type ResolvedSelection = Readonly<{
  alias: string;
  handle: AnySurfaceHandle;
  mode: InteractionMode;
}>;

export function modeForVerb(verb: InteractionVerb): InteractionMode {
  return verb === "propose" ? "request" : "direct";
}

export function verbForMode(mode: InteractionMode): InteractionVerb {
  return mode === "request" ? "propose" : "call";
}

function fail(path: string, message: string): never {
  throw new AdapterError("INVALID_DECLARATION", path, message);
}

function isCaller(value: unknown): value is AnyCaller {
  return value !== null && typeof value === "object" && "handoff" in value && "manifest" in value;
}

function isProjection(value: unknown): value is CompiledSurface<any> {
  return value !== null && typeof value === "object" && "handles" in value && "projectionDigest" in value;
}

function isManifest(value: unknown): value is BindingManifest {
  return value !== null && typeof value === "object" && "bindingDigest" in value && "interactions" in value && !("handoff" in value);
}

function manifestEntries(source: AnyCaller | BindingManifest): BindingManifest["interactions"] {
  return isCaller(source) ? source.manifest.interactions : source.interactions;
}

/**
 * Resolve one alias of a source to the projected-handle snapshot and wire mode
 * an adapter declaration pins. A caller resolves from its Binding manifest; a
 * CompiledSurface from its own manifest. The verb is required when the alias was
 * selected in both modes.
 */
export function resolveSelection(
  source: unknown,
  alias: unknown,
  verb: InteractionVerb | undefined,
  path: string,
): ResolvedSelection {
  if (typeof alias !== "string" || !alias) {
    return fail(`${path}.alias`, "expected an interaction alias string; found none; fix: name the alias as selected on the caller or CompiledSurface");
  }
  if (verb !== undefined && verb !== "call" && verb !== "propose") {
    return fail(`${path}.mode`, `expected mode "call" or "propose"; found ${String(verb)}; fix: use the caller's verbs, not wire modes`);
  }
  let interactionId: string | undefined;
  let contractDigest: string | undefined;
  let inputArity: 0 | 1 | undefined;
  const modes: InteractionMode[] = [];
  if (isCaller(source) || isManifest(source)) {
    for (const entry of manifestEntries(source)) {
      if (entry.alias !== alias) continue;
      interactionId = entry.interactionId;
      contractDigest = entry.expectedContractDigest;
      inputArity = entry.inputArity;
      modes.push(entry.mode);
    }
  } else if (isProjection(source)) {
    for (const entry of source.manifest.interactions) {
      if (entry.alias !== alias) continue;
      interactionId = entry.interactionId;
      contractDigest = entry.expectedContractDigest;
      inputArity = entry.inputArity;
      modes.push(...entry.modes);
    }
  } else {
    return fail(path, "expected a connected caller, a Binding manifest, or a CompiledSurface; found another value; fix: pass the value connect(), inspect(), or projectInteractions() returned");
  }
  if (interactionId === undefined || contractDigest === undefined || inputArity === undefined || modes.length === 0) {
    return fail(`${path}.alias`, `expected an alias selected by this ${isCaller(source) ? "caller" : "CompiledSurface"}; found "${alias}"; fix: select it on the surface first`);
  }
  const handle = snapshotSurfaceHandle(
    { interactionId, contractDigest, inputArity, modes: Object.freeze([...modes].sort()) } as unknown as AnySurfaceHandle,
    path,
  );
  let mode: InteractionMode;
  if (verb === undefined) {
    if (modes.length !== 1) {
      return fail(`${path}.mode`, `expected mode "call" or "propose" because "${alias}" is selected in both; found none; fix: pass { mode }`);
    }
    mode = modes[0]!;
  } else {
    mode = modeForVerb(verb);
    if (!modes.includes(mode)) {
      throw new AdapterError("INTERACTION_NOT_EXPOSED", `${path}.mode`,
        `expected "${alias}" selected for ${verb}; found only ${modes.map(verbForMode).join(", ")}; fix: select it for ${verb} on the surface`);
    }
  }
  return Object.freeze({ alias, handle, mode });
}

/** Every (alias, mode) a source selects, in manifest order. */
export function selectionsOf(source: unknown, path: string): readonly ResolvedSelection[] {
  const seen = new Map<string, InteractionMode[]>();
  if (isCaller(source) || isManifest(source)) {
    for (const entry of manifestEntries(source)) {
      seen.set(entry.alias, [...(seen.get(entry.alias) ?? []), entry.mode]);
    }
  } else if (isProjection(source)) {
    for (const entry of source.manifest.interactions) {
      seen.set(entry.alias, [...entry.modes]);
    }
  } else {
    return fail(path, "expected a connected caller, a Binding manifest, or a CompiledSurface; found another value; fix: pass the value connect(), inspect(), or projectInteractions() returned");
  }
  const result: ResolvedSelection[] = [];
  for (const [alias, modes] of seen) {
    for (const mode of modes) result.push(resolveSelection(source, alias, verbForMode(mode), `${path}.${alias}`));
  }
  return Object.freeze(result);
}

/** The Handoff seam of a connected caller. */
export function seamOf<Context>(caller: AnyCaller<Context>, path: string): AnyCaller<Context>["handoff"] {
  if (!isCaller(caller)) {
    return fail(path, "expected a connected caller; found another value; fix: pass the value connect() or createCaller() returned");
  }
  return caller.handoff;
}
