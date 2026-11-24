import { createProgram, hashJson, type JsonObject } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import {
  metadataForCompiled,
  metadataForHandle,
} from "./compile";
import { direct } from "./direct";
import { failHost } from "./errors";
import type {
  CompiledInteractions,
  HandlesOf,
  InteractionDefinitions,
  InteractionMode,
  ProjectedInteractionHandle,
  Projection,
  ProjectionManifest,
  ProjectionInteraction,
  ProjectionSelection,
  ProjectionSelections,
} from "./types";
import type { ProjectionAlgebraMethods } from "./projection-algebra";
import { intersectProjections, omitProjection, unionProjections, pickProjectionAlgebra } from "./projection-algebra";

export type FluentProjection<Selections extends ProjectionSelections = ProjectionSelections> = Projection<Selections> & ProjectionAlgebraMethods;

export const PROJECTION_DOMAIN = "boundary.projection/v1";

type ProjectionMetadata = Readonly<{
  compiled: object;
  aliases: ReadonlyMap<
    string,
    Readonly<{
      alias: string;
      handle: ProjectedInteractionHandle;
      interaction: ProjectionInteraction;
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

export type AliasProjectionSelections<
  Definitions extends InteractionDefinitions,
  Selections extends Readonly<Record<string, InteractionMode | ProjectionSelection>>,
> = {
  readonly [Alias in keyof Selections]: Selections[Alias] extends InteractionMode
    ? Alias extends keyof Definitions
      ? ProjectionSelection<HandlesOf<Definitions>[Alias], readonly [Selections[Alias]]>
      : never
    : Selections[Alias] extends ProjectionSelection ? Selections[Alias] : never;
};

export function projectInteractions<
  Definitions extends InteractionDefinitions,
  const Selections extends ProjectionSelections,
>(compiled: CompiledInteractions<Definitions>, selections: Selections): FluentProjection<Selections>;
export function projectInteractions<
  Definitions extends InteractionDefinitions,
  const Selections extends Readonly<Record<string, InteractionMode | ProjectionSelection>>,
>(
  compiled: CompiledInteractions<Definitions>,
  selections: Selections & {
    readonly [Alias in keyof Selections]: Selections[Alias] extends InteractionMode
      ? Alias extends keyof Definitions ? Selections[Alias] : never
      : Selections[Alias];
  },
): FluentProjection<AliasProjectionSelections<Definitions, Selections>>;
export function projectInteractions(
  compiled: CompiledInteractions<any>,
  selections: Readonly<Record<string, InteractionMode | ProjectionSelection>>,
): FluentProjection<any> {
  metadataForCompiled(compiled);
  if (selections === null || typeof selections !== "object" || Array.isArray(selections)) {
    return failHost("INVALID_PROJECTION", "selections", "projection selections must be a closed record");
  }
  const lowered: Record<string, ProjectionSelection> = Object.create(null);
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
      lowered[alias] = value as ProjectionSelection;
    }
  }
  return projectExplicit(compiled, lowered);
}

function projectExplicit<
  Definitions extends InteractionDefinitions,
  const Selections extends ProjectionSelections,
>(
  compiled: CompiledInteractions<Definitions>,
  selections: Selections,
): FluentProjection<Selections> {
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

  const handles: Record<string, ProjectedInteractionHandle> = {};
  const byAlias = new Map<
    string,
    {
      alias: string;
      handle: ProjectedInteractionHandle;
      interaction: ProjectionInteraction;
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
    const source = selection.interaction as ProjectedInteractionHandle;
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
        "one Projection may select an interaction only once",
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
    }) as ProjectedInteractionHandle;
    const interaction: ProjectionInteraction = Object.freeze({
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
  const program = createProgram(descriptors);
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
  const projectionDigest = hashJson(
    PROJECTION_DOMAIN,
    identity as unknown as JsonObject,
  );
  const manifest: ProjectionManifest = Object.freeze({
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
    pick: (...keys: readonly string[]) => pickProjectionAlgebra(projection as Projection<any>, ...keys),
    omit: (...keys: readonly string[]) => omitProjection(projection as Projection<any>, ...keys),
    union: (other: Projection<any>) => unionProjections(projection as Projection<any>, other),
    intersect: (other: Projection<any>) => intersectProjections(projection as Projection<any>, other),
  }) as Projection<Selections> & ProjectionAlgebraMethods;
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

export function metadataForProjection(value: unknown): ProjectionMetadata {
  if (value === null || typeof value !== "object") {
    return failHost(
      "INVALID_PROJECTION",
      "projection",
      "an authentic Projection value is required",
    );
  }
  const metadata = projectionMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_PROJECTION",
      "projection",
      "an authentic Projection value is required",
    );
  }
  return metadata;
}

export function registerProjectionAlgebraResult(
  projection: object,
  aliases: ReadonlyMap<string, { alias: string; handle: ProjectedInteractionHandle; interaction: ProjectionInteraction }>,
  sources: readonly { alias: string; source: object }[],
): void {
  const first = sources[0] && metadataForHandle(sources[0].source);
  projectionMetadata.set(projection, { compiled: first?.compiled ?? {}, aliases });
  for (const { alias, source } of sources) {
    const handle = aliases.get(alias)!.handle;
    projectedHandleMetadata.set(handle, { projection, alias, source });
  }
}

export function metadataForProjectedHandle(value: unknown) {
  if (value === null || typeof value !== "object") return undefined;
  return projectedHandleMetadata.get(value);
}

export type DirectProjectionSelections<Definitions extends InteractionDefinitions> =
  {
    readonly [Alias in keyof Definitions]: ProjectionSelection<
      HandlesOf<Definitions>[Alias],
      readonly ["direct"]
    >;
  };

/** Project every compiled handle in direct mode. */
export function projectAllDirect<Definitions extends InteractionDefinitions>(
  compiled: CompiledInteractions<Definitions>,
): FluentProjection<DirectProjectionSelections<Definitions>> {
  metadataForCompiled(compiled);
  const selections = Object.fromEntries(
    Object.entries(compiled.handles).map(([alias, handle]) => [
      alias,
      direct(handle),
    ]),
  ) as DirectProjectionSelections<Definitions>;
  return projectInteractions(compiled, selections);
}

/**
 * Re-project a named subset of an existing Projection.
 * Keys resolve as aliases first, then as interaction ids.
 * The result is a new Projection with its own digest.
 */
export function pickProjection<
  Selections extends ProjectionSelections,
  const Keys extends readonly (keyof Selections & string)[],
>(
  projection: Projection<Selections>,
  ...keys: Keys
): FluentProjection<Pick<Selections, Keys[number]>>;
export function pickProjection<Selections extends ProjectionSelections>(
  projection: Projection<Selections>,
  ...keys: readonly string[]
): FluentProjection<Selections>;
export function pickProjection(
  projection: Projection<ProjectionSelections>,
  ...keys: readonly string[]
): FluentProjection<ProjectionSelections> {
  return pickProjectionAlgebra(projection, ...keys) as FluentProjection<ProjectionSelections>;
}
