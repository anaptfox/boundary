import { composePrograms, createInteractionDescriptor, createProgram, diffPrograms, portableSchema, type JsonObject, type InteractionDescriptor, type PortableSchema, type Program } from "@foxworth/boundary/program";
import { declaredErrorSchema, isInteractionDefinition } from "./definitions";
import { failHost } from "./errors";
import type { AnyInteractionDefinition, CompileInteractionsOptions, CompiledInteractions, InteractionDefinitions, InteractionHandle, InteractionLowering, SchemaAdapter } from "./types";
import type { AsyncInteractionLowering } from "./async-lowering";
import { dataEntries, descriptorAnnotations, snapshotDefinitions } from "./definition-snapshot";
import { compileAuthoringSchema, schemaAdapters } from "./schema-adapters";
import { projectAllCompiled, projectCompiled } from "./projection-algebra";

type CompiledMetadata = Readonly<{
  definitions: Readonly<Record<string, AnyInteractionDefinition>>;
  descriptors: ReadonlyMap<string, InteractionDescriptor>;
  aliasesByDefinition: ReadonlyMap<AnyInteractionDefinition, string>;
  handlesByDefinition: ReadonlyMap<AnyInteractionDefinition, InteractionHandle>;
  nativeTargets: ReadonlyMap<string, unknown>;
  errorSchemas: ReadonlyMap<
    string,
    Readonly<Record<string, PortableSchema>>
  >;
}>;

const compiledMetadata = new WeakMap<object, CompiledMetadata>();

const handleMetadata = new WeakMap<
  object,
  Readonly<{
    compiled: object;
    alias: string;
    definition: AnyInteractionDefinition;
    descriptor: InteractionDescriptor;
  }>
>();

function compileSnapshot<Definitions extends InteractionDefinitions>(
  definitions: Definitions,
  nativeTargets: ReadonlyMap<string, unknown>,
  adapters: readonly SchemaAdapter<any>[],
): CompiledInteractions<Definitions> {
  const aliases = Object.keys(definitions);
  const compiledDefinitions = aliases.map((alias) => {
      const definition = definitions[alias]!;
      const input = compileAuthoringSchema(
        adapters,
        definition.input,
        "input",
        `${definition.id}.input`,
      );
      const output = compileAuthoringSchema(
        adapters,
        definition.output,
        "output",
        `${definition.id}.output`,
      );
      const errors: Record<string, PortableSchema> = {};
      const errorAnnotations: Record<string, JsonObject> = {};
      for (const [code, source] of Object.entries(definition.errors)) {
        const compiled = compileAuthoringSchema(
          adapters,
          source,
          "error",
          `${definition.id}.errors.${code}`,
        );
        errors[code] = portableSchema(
          compiled.contract,
          `${definition.id}.errors.${code}`,
        );
        if (Object.keys(compiled.annotations).length > 0) {
          errorAnnotations[code] = compiled.annotations;
        }
      }
      const errorSchemas = Object.freeze(errors);
      const annotations = descriptorAnnotations(definition, {
        input: input.annotations,
        output: output.annotations,
        errors: Object.freeze(errorAnnotations),
      });
      const traits = definition as AnyInteractionDefinition & {
        readonly idempotencyKey?: string;
        readonly compensates?: string;
      };
      const descriptor = createInteractionDescriptor({
        contract: {
          version: 1,
          id: definition.id,
          inputSchema: input.contract,
          outputSchema: output.contract,
          ...(Object.keys(errorSchemas).length === 0
            ? {}
            : {
                errorSchema: declaredErrorSchema(
                  definition.id,
                  errorSchemas,
                )!,
              }),
          reads: definition.reads,
          changes: definition.changes,
          ...(traits.idempotencyKey === undefined ? {} : { idempotencyKey: traits.idempotencyKey }),
          ...(traits.compensates === undefined ? {} : { compensates: traits.compensates }),
        },
        ...(definition.summary === undefined &&
        definition.description === undefined
          ? {}
          : {
              docs: {
                ...(definition.summary === undefined
                  ? {}
                  : { summary: definition.summary }),
                ...(definition.description === undefined
                  ? {}
                  : { description: definition.description }),
              },
            }),
        ...(annotations === undefined
          ? {}
          : { annotations }),
      });
      return Object.freeze({ descriptor, errorSchemas });
    });
  const descriptors = compiledDefinitions.map((entry) => entry.descriptor);
  const errorSchemas = new Map(
    compiledDefinitions.map((entry) => [
      entry.descriptor.contract.id,
      entry.errorSchemas,
    ]),
  );
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.contract.id)) {
      failHost(
        "DUPLICATE_INTERACTION_ID",
        `interactions.${descriptor.contract.id}`,
        `duplicate interaction id: ${descriptor.contract.id}`,
      );
    }
    ids.add(descriptor.contract.id);
  }
  const program = createProgram(descriptors);
  return assembleCompiled(definitions, nativeTargets, program, errorSchemas);
}

function assembleCompiled<Definitions extends InteractionDefinitions>(
  definitions: Definitions,
  nativeTargets: ReadonlyMap<string, unknown>,
  program: Program,
  errorSchemas: ReadonlyMap<
    string,
    Readonly<Record<string, PortableSchema>>
  >,
): CompiledInteractions<Definitions> {
  const aliases = Object.keys(definitions);
  const descriptorsById = new Map(
    program.interactions.map((descriptor) => [descriptor.contract.id, descriptor]),
  );
  const handles: Record<string, InteractionHandle> = {};
  const aliasesByDefinition = new Map<AnyInteractionDefinition, string>();
  const handlesByDefinition = new Map<AnyInteractionDefinition, InteractionHandle>();
  const compiled = {
    program,
    handles,
    project: (selections: any) => projectCompiled(compiled, selections),
    projectAll: (mode: "direct") => {
      if (mode !== "direct") throw new TypeError('projectAll currently supports only "direct" mode');
      return projectAllCompiled(compiled);
    },
  } as unknown as CompiledInteractions<Definitions>;
  for (const alias of aliases) {
    const definition = definitions[alias]!;
    const descriptor = descriptorsById.get(definition.id)!;
    const handle = Object.freeze({
      interactionId: definition.id,
      contractDigest: descriptor.contractDigest,
      inputArity: definition.inputArity,
    }) as InteractionHandle;
    Object.defineProperty(handles, alias, {
      value: handle,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    aliasesByDefinition.set(definition, alias);
    handlesByDefinition.set(definition, handle);
    handleMetadata.set(handle, {
      compiled,
      alias,
      definition,
      descriptor,
    });
  }
  Object.freeze(handles);
  Object.freeze(compiled);
  compiledMetadata.set(compiled, {
    definitions,
    descriptors: descriptorsById,
    aliasesByDefinition,
    handlesByDefinition,
    nativeTargets,
    errorSchemas,
  });
  return compiled;
}

type DefinitionsOf<Value> = Value extends CompiledInteractions<infer Definitions>
  ? Definitions
  : never;

type UnionToIntersection<Value> = (
  Value extends unknown ? (value: Value) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type ComposedDefinitions<
  Inputs extends readonly CompiledInteractions[],
> = UnionToIntersection<DefinitionsOf<Inputs[number]>> extends infer Definitions extends InteractionDefinitions
  ? Definitions
  : never;

export function compileInteractions<
  const Definitions extends InteractionDefinitions,
>(
  definitions: Definitions,
  options?: CompileInteractionsOptions,
): CompiledInteractions<Definitions>;
export function compileInteractions<
  const Native extends Readonly<Record<string, unknown>>,
  const Definitions extends InteractionDefinitions,
>(
  native: Native,
  lowering: InteractionLowering<Native, Definitions>,
  options?: CompileInteractionsOptions,
): CompiledInteractions<Definitions>;
export function compileInteractions(
  source: Readonly<Record<string, unknown>>,
  loweringOrOptions?:
    | InteractionLowering<any, any>
    | CompileInteractionsOptions,
  options?: CompileInteractionsOptions,
): CompiledInteractions<any> {
  const entries = dataEntries(source, "interactions");
  const lowering =
    loweringOrOptions !== undefined &&
    loweringOrOptions !== null &&
    typeof loweringOrOptions === "object" &&
    "lower" in loweringOrOptions &&
    typeof loweringOrOptions.lower === "function"
      ? loweringOrOptions as InteractionLowering<any, any>
      : undefined;
  if (lowering === undefined) {
    return compileSnapshot(
      snapshotDefinitions(source) as InteractionDefinitions,
      new Map(),
      schemaAdapters(loweringOrOptions as CompileInteractionsOptions | undefined),
    );
  }
  if (
    lowering === null ||
    typeof lowering !== "object" ||
    typeof lowering.lower !== "function"
  ) {
    failHost(
      "INVALID_DECLARATION",
      "lowering",
      "interaction lowering must expose a lower function",
    );
  }
  const definitions: Record<string, AnyInteractionDefinition> = {};
  const nativeTargets = new Map<string, unknown>();
  for (const [alias, native] of entries) {
    let definition: unknown;
    try {
      definition = lowering.lower(native, Object.freeze({ alias }));
      if (definition !== null && typeof definition === "object" && "then" in definition) {
        failHost("INVALID_DECLARATION", `lowering.${alias}`, "asynchronous lowering requires compileInteractionsAsync");
      }
    } catch (cause) {
      failHost(
        "INVALID_DECLARATION",
        `lowering.${alias}`,
        "native interaction lowering failed",
        cause,
      );
    }
    if (!isInteractionDefinition(definition)) {
      failHost(
        "FORGED_DEFINITION",
        `lowering.${alias}`,
        "interaction lowering must return an authentic interaction definition",
      );
    }
    definitions[alias] = definition;
    nativeTargets.set(alias, native);
  }
  return compileSnapshot(
    Object.freeze(definitions) as InteractionDefinitions,
    nativeTargets,
    schemaAdapters(options),
  );
}

export async function compileInteractionsAsync<
  const Native extends Readonly<Record<string, unknown>>,
  const Definitions extends InteractionDefinitions,
>(
  native: Native,
  lowering: AsyncInteractionLowering<Native, Definitions>,
  options?: CompileInteractionsOptions,
): Promise<CompiledInteractions<Definitions>> {
  const entries = dataEntries(native, "interactions");
  const definitions: Record<string, AnyInteractionDefinition> = {};
  const nativeTargets = new Map<string, unknown>();
  for (const [alias, value] of entries) {
    let definition: unknown;
    try {
      definition = await lowering.lower(value as Native[string], Object.freeze({ alias }));
    } catch (cause) {
      failHost("INVALID_DECLARATION", `lowering.${alias}`, "native interaction lowering failed", cause);
    }
    if (!isInteractionDefinition(definition)) {
      failHost("FORGED_DEFINITION", `lowering.${alias}`, "interaction lowering must return an authentic interaction definition");
    }
    definitions[alias] = definition;
    nativeTargets.set(alias, value);
  }
  return compileSnapshot(Object.freeze(definitions) as Definitions, nativeTargets, schemaAdapters(options));
}

/**
 * Compose already-compiled closed records without weakening their typed
 * handles. Alias collisions are rejected before Program composition; interaction
 * identity conflicts retain Program's structured diagnostics.
 */
export function composeCompiledInteractions<
  const Inputs extends readonly [
    CompiledInteractions,
    ...CompiledInteractions[],
  ],
>(...inputs: Inputs): CompiledInteractions<ComposedDefinitions<Inputs>> {
  const definitions: Record<string, AnyInteractionDefinition> = {};
  const nativeTargets = new Map<string, unknown>();
  const errorSchemas = new Map<
    string,
    Readonly<Record<string, PortableSchema>>
  >();
  for (const compiled of inputs) {
    const metadata = metadataForCompiled(compiled);
    for (const [alias, definition] of Object.entries(metadata.definitions)) {
      if (Object.hasOwn(definitions, alias)) {
        failHost(
          "DUPLICATE_INTERACTION_ALIAS",
          `interactions.${alias}`,
          `compiled interaction alias is duplicated: ${alias}`,
        );
      }
      definitions[alias] = definition;
      if (metadata.nativeTargets.has(alias)) {
        nativeTargets.set(alias, metadata.nativeTargets.get(alias));
      }
      errorSchemas.set(
        definition.id,
        metadata.errorSchemas.get(definition.id) ?? Object.freeze({}),
      );
    }
  }
  const program = composePrograms(inputs.map((input) => input.program));
  return assembleCompiled(
    Object.freeze(definitions) as ComposedDefinitions<Inputs>,
    nativeTargets,
    program,
    errorSchemas,
  );
}

/** Compare portable interaction identity without conflating docs or annotations. */
export function diffCompiledInteractions(
  previous: CompiledInteractions,
  next: CompiledInteractions,
) {
  metadataForCompiled(previous);
  metadataForCompiled(next);
  return diffPrograms(previous.program, next.program);
}

export function metadataForCompiled(value: unknown): CompiledMetadata {
  if (value === null || typeof value !== "object") {
    return failHost(
      "INVALID_INSTALLATION",
      "compiled",
      "an authentic CompiledInteractions value is required",
    );
  }
  const metadata = compiledMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_INSTALLATION",
      "compiled",
      "an authentic CompiledInteractions value is required",
    );
  }
  return metadata;
}

export function metadataForHandle(value: unknown) {
  if (value === null || typeof value !== "object") return undefined;
  return handleMetadata.get(value);
}

export function handleBelongsToCompiled(
  handle: unknown,
  compiled: object,
): boolean {
  return metadataForHandle(handle)?.compiled === compiled;
}
