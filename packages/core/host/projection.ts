import { createProgram, hashJson, type JsonObject } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import {
  metadataForCompiled,
  metadataForHandle,
} from "./compile";
import { requireSurface, type AnySurface, type Surface, type SurfaceAlias } from "./surface";
import { failHost } from "./errors";
import type {
  CompiledInteractions,
  HandlesOf,
  InteractionDefinitions,
  InteractionMode,
  SurfaceHandle,
  CompiledSurface,
  SurfaceManifest,
  SurfaceInteraction,
  HandleSelection,
  HandleSelections,
} from "./types";

export const PROJECTION_DOMAIN = "boundary.projection/v1";

type ProjectionMetadata = Readonly<{
  compiled: object;
  aliases: ReadonlyMap<
    string,
    Readonly<{
      alias: string;
      handle: SurfaceHandle;
      interaction: SurfaceInteraction;
    }>
  >;
}>;

const projectionMetadata = new WeakMap<object, ProjectionMetadata>();
const projectedHandleMetadata = new WeakMap<
  object,
  Readonly<{
    projection: object;
    alias: string;
    source: object;
  }>
>();

function normalizeModes(
  value: unknown,
  path: string,
): readonly InteractionMode[] {
  if (!Array.isArray(value) || value.length === 0) {
    return failHost(
      "INVALID_PROJECTION",
      path,
      "projection modes must be a non-empty array",
    );
  }
  const modes = [...new Set(value)];
  if (
    modes.some((mode) => mode !== "direct" && mode !== "request")
  ) {
    return failHost(
      "INVALID_PROJECTION",
      path,
      'projection modes may contain only "direct" and "request"',
    );
  }
  return Object.freeze((modes as InteractionMode[]).sort(compareUtf8));
}

export type AliasHandleSelections<
  Definitions extends InteractionDefinitions,
  Selections extends Readonly<Record<string, InteractionMode | HandleSelection>>,
> = {
  readonly [Alias in keyof Selections]: Selections[Alias] extends InteractionMode
    ? Alias extends keyof Definitions
      ? HandleSelection<HandlesOf<Definitions>[Alias], readonly [Selections[Alias]]>
      : never
    : Selections[Alias] extends HandleSelection ? Selections[Alias] : never;
};

export function projectInteractions<
  Definitions extends InteractionDefinitions,
  const Selections extends HandleSelections,
>(compiled: CompiledInteractions<Definitions>, selections: Selections): Promise<CompiledSurface<Selections>>;
export function projectInteractions<
  Definitions extends InteractionDefinitions,
  const Selections extends Readonly<Record<string, InteractionMode | HandleSelection>>,
>(
  compiled: CompiledInteractions<Definitions>,
  selections: Selections & {
    readonly [Alias in keyof Selections]: Selections[Alias] extends InteractionMode
      ? Alias extends keyof Definitions ? Selections[Alias] : never
      : Selections[Alias];
  },
): Promise<CompiledSurface<AliasHandleSelections<Definitions, Selections>>>;
export async function projectInteractions(
  compiled: CompiledInteractions<any>,
  selections: Readonly<Record<string, InteractionMode | HandleSelection>>,
): Promise<CompiledSurface<any>> {
  metadataForCompiled(compiled);
  if (selections === null || typeof selections !== "object" || Array.isArray(selections)) {
    return failHost("INVALID_PROJECTION", "selections", "projection selections must be a closed record");
  }
  const lowered: Record<string, HandleSelection> = Object.create(null);
  for (const alias of Reflect.ownKeys(selections)) {
    const property = Object.getOwnPropertyDescriptor(selections, alias)!;
    if (typeof alias !== "string" || !property.enumerable || !("value" in property)) {
      return failHost("INVALID_PROJECTION", "selections", "selection aliases must be enumerable data properties");
    }
    const value: unknown = property.value;
    if (typeof value === "string") {
      const handle = Object.getOwnPropertyDescriptor(compiled.handles, alias)?.value;
      if (handle === undefined || (value !== "direct" && value !== "request")) {
        return failHost("INVALID_PROJECTION", `selections.${alias}`, "shorthand requires a compiled alias and an explicit mode");
      }
      lowered[alias] = Object.freeze({ interaction: handle, modes: Object.freeze([value] as const) });
    } else {
      lowered[alias] = value as HandleSelection;
    }
  }
  return projectExplicit(compiled, lowered);
}

async function projectExplicit<
  Definitions extends InteractionDefinitions,
  const Selections extends HandleSelections,
>(
  compiled: CompiledInteractions<Definitions>,
  selections: Selections,
): Promise<CompiledSurface<Selections>> {
  const compiledMeta = metadataForCompiled(compiled);
  if (
    selections === null ||
    typeof selections !== "object" ||
    Array.isArray(selections)
  ) {
    return failHost(
      "INVALID_PROJECTION",
      "selections",
      "projection selections must be a closed record",
    );
  }
  const selectionKeys = Reflect.ownKeys(selections);

  const handles: Record<string, SurfaceHandle> = {};
  const byAlias = new Map<
    string,
    {
      alias: string;
      handle: SurfaceHandle;
      interaction: SurfaceInteraction;
    }
  >();
  const selectedIds = new Set<string>();
  for (const alias of selectionKeys) {
    if (typeof alias !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(alias)) {
      failHost(
        "INVALID_PROJECTION",
        `selections.${String(alias)}`,
        "projection aliases must be JavaScript identifier-like strings",
      );
    }
    const property = Object.getOwnPropertyDescriptor(selections, alias);
    if (!property || !("value" in property) || !property.enumerable) {
      failHost(
        "INVALID_PROJECTION",
        `selections.${alias}`,
        "projection selections must be enumerable data properties",
      );
    }
    const selection = property.value as Record<string, unknown>;
    if (
      selection === null ||
      typeof selection !== "object" ||
      Array.isArray(selection)
    ) {
      failHost(
        "INVALID_PROJECTION",
        `selections.${alias}`,
        "each projection selection must be an object",
      );
    }
    const source = selection.interaction as SurfaceHandle;
    const sourceMeta = metadataForHandle(source);
    if (!sourceMeta || sourceMeta.compiled !== compiled) {
      failHost(
        "FOREIGN_HANDLE",
        `selections.${alias}.interaction`,
        "projection selections require handles from this compilation",
      );
    }
    if (selectedIds.has(sourceMeta.definition.id)) {
      failHost(
        "DUPLICATE_PROJECTION_INTERACTION",
        `selections.${alias}.interaction`,
        "one CompiledSurface may select an interaction only once",
      );
    }
    selectedIds.add(sourceMeta.definition.id);
    const modes = normalizeModes(
      selection.modes,
      `selections.${alias}.modes`,
    );
    const handle = Object.freeze({
      interactionId: source.interactionId,
      contractDigest: source.contractDigest,
      inputArity: source.inputArity,
      modes,
    }) as SurfaceHandle;
    const interaction: SurfaceInteraction = Object.freeze({
      alias,
      interactionId: source.interactionId,
      expectedContractDigest: source.contractDigest,
      inputArity: source.inputArity,
      modes,
    });
    Object.defineProperty(handles, alias, {
      value: handle,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    byAlias.set(alias, { alias, handle, interaction });
  }
  const descriptors = [...selectedIds].map(
    (id) => compiledMeta.descriptors.get(id)!,
  );
  const program = await createProgram(descriptors);
  const interactions = Object.freeze(
    [...byAlias.values()]
      .map((entry) => entry.interaction)
      .sort((left, right) => compareUtf8(left.alias, right.alias)),
  );
  const identity = Object.freeze({
    program: program.programDigest,
    interactions: Object.freeze(
      interactions.map((interaction) =>
        Object.freeze({
          alias: interaction.alias,
          interaction: interaction.interactionId,
          contract: interaction.expectedContractDigest,
          arity: interaction.inputArity === 0 ? "zero" : "one",
          modes:
            interaction.modes.length === 2
              ? "direct-and-request"
              : interaction.modes[0],
        }),
      ),
    ),
  });
  const projectionDigest = await hashJson(
    PROJECTION_DOMAIN,
    identity as unknown as JsonObject,
  );
  const manifest: SurfaceManifest = Object.freeze({
    version: 1,
    program,
    interactions,
    projectionDigest,
  });
  Object.freeze(handles);
  const projection = Object.freeze({
    program,
    interactions,
    projectionDigest,
    handles,
    manifest,
  }) as CompiledSurface<Selections>;
  projectionMetadata.set(projection, {
    compiled,
    aliases: byAlias,
  });
  for (const entry of byAlias.values()) {
    projectedHandleMetadata.set(entry.handle, {
      projection,
      alias: entry.alias,
      source: selections[entry.alias]!.interaction,
    });
  }
  return projection;
}

export function metadataForCompiledSurface(value: unknown): ProjectionMetadata {
  if (value === null || typeof value !== "object") {
    return failHost(
      "INVALID_PROJECTION",
      "projection",
      "an authentic CompiledSurface value is required",
    );
  }
  const metadata = projectionMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_PROJECTION",
      "projection",
      "an authentic CompiledSurface value is required",
    );
  }
  return metadata;
}

export function metadataForSurfaceHandle(value: unknown) {
  if (value === null || typeof value !== "object") return undefined;
  return projectedHandleMetadata.get(value);
}

/**
 * Project a Surface over this compilation: the pipeline's way to select by
 * alias with `surface()` and `surface.all()`. Every selected alias must name
 * the definition this compilation compiled under that alias.
 */
export async function projectSurface<
  Definitions extends InteractionDefinitions,
  Call extends SurfaceAlias<Definitions>,
  Propose extends SurfaceAlias<Definitions>,
>(
  compiled: CompiledInteractions<Definitions>,
  selected: Surface<Definitions, Call, Propose>,
): Promise<CompiledSurface<{
  readonly [Alias in Call | Propose]: HandleSelection<
    HandlesOf<Definitions>[Alias],
    readonly (Alias extends Call ? (Alias extends Propose ? "direct" | "request" : "direct") : "request")[]
  >;
}>> {
  const compiledMeta = metadataForCompiled(compiled);
  const value: AnySurface = requireSurface(selected, "projectSurface.surface");
  const selections: Record<string, HandleSelection> = Object.create(null) as Record<string, HandleSelection>;
  for (const alias of new Set([...value.call, ...value.propose])) {
    const declared = Object.getOwnPropertyDescriptor(value.definitions, alias)?.value;
    if (declared === undefined || compiledMeta.definitions[alias] !== declared) {
      return failHost("FOREIGN_HANDLE", `projectSurface.surface.${alias}`,
        `expected the surface alias "${alias}" to name the definition compiled under that alias; found ${declared === undefined ? "no such alias" : "a different definition"}; fix: build the surface from the record you compiled`);
    }
    const modes: InteractionMode[] = [];
    if (value.call.includes(alias)) modes.push("direct");
    if (value.propose.includes(alias)) modes.push("request");
    Object.defineProperty(selections, alias, {
      value: Object.freeze({ interaction: compiled.handles[alias], modes: Object.freeze(modes) }),
      enumerable: true, configurable: false, writable: false,
    });
  }
  return projectExplicit(compiled, selections) as never;
}
