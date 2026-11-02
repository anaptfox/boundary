import {
  normalizeJson,
  portableSchema,
  type JsonObject,
  type JsonValue,
  type PortableSchema,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import { failHost } from "./errors";
import type {
  AnyInteractionDefinition,
  AuthoringSchema,
  InteractionHandle,
  InteractionDefinition,
  SchemaValue,
} from "./types";

const definitions = new WeakSet<object>();

const absentInputSchema = portableSchema<null>(
  Object.freeze({ type: "null" }),
  "defineInteraction.input",
);

type CommonDefinitionSource<
  Id extends string,
  OutputSchema extends AuthoringSchema,
  Errors extends AuthoringErrorSchemas,
> = Readonly<{
  id: Id;
  output: OutputSchema;
  errors?: Errors;
  reads?: readonly string[];
  changes?: readonly string[];
  summary?: string;
  description?: string;
  annotations?: JsonObject;
}>;

type InputDefinitionSource<
  Id extends string,
  InputSchema extends AuthoringSchema,
  OutputSchema extends AuthoringSchema,
  Errors extends AuthoringErrorSchemas,
> = CommonDefinitionSource<Id, OutputSchema, Errors> &
  Readonly<{ input: InputSchema }>;

type NoInputDefinitionSource<
  Id extends string,
  OutputSchema extends AuthoringSchema,
  Errors extends AuthoringErrorSchemas,
> = CommonDefinitionSource<Id, OutputSchema, Errors> &
  Readonly<{ input?: never }>;

function ownData(source: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch (cause) {
    return failHost(
      "INVALID_DECLARATION",
      `defineInteraction.${key}`,
      "interaction declaration could not be inspected",
      cause,
    );
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    return failHost(
      "INVALID_DECLARATION",
      `defineInteraction.${key}`,
      "interaction declaration fields must be enumerable data properties",
    );
  }
  return descriptor.value;
}

function stringList(value: unknown, path: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return failHost(
      "INVALID_DECLARATION",
      path,
      "interaction footprints must be arrays of strings",
    );
  }
  return Object.freeze([...value]);
}

type AuthoringErrorSchemas = Readonly<Record<string, AuthoringSchema>>;
type AuthoringErrorValues<Schemas extends AuthoringErrorSchemas> = {
  readonly [Code in keyof Schemas]: SchemaValue<Schemas[Code]>;
};

function errorSchemas(
  value: unknown,
): Readonly<Record<string, AuthoringSchema>> {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost(
      "INVALID_DECLARATION",
      "defineInteraction.errors",
      "declared errors must be a record of authoring schemas",
    );
  }
  const result: Record<string, AuthoringSchema> = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) {
      failHost(
        "INVALID_DECLARATION",
        `defineInteraction.errors.${key}`,
        "declared error codes must be stable ASCII tokens",
      );
    }
    const schema = ownData(value, key) as AuthoringSchema;
    Object.defineProperty(result, key, {
      value: schema,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(result);
}

function definitionAnnotations(explicit: unknown): JsonObject | undefined {
  if (explicit !== undefined) {
    const normalized = normalizeJson(explicit, "defineInteraction.annotations");
    if (
      normalized === null ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    ) {
      failHost(
        "INVALID_DECLARATION",
        "defineInteraction.annotations",
        "annotations must be a portable JSON object",
      );
    }
    const interaction = normalized as JsonObject;
    if (Object.hasOwn(interaction, "schemas")) {
      failHost(
        "INVALID_DECLARATION",
        "defineInteraction.annotations.schemas",
        "schemas is reserved for compiler-produced schema annotations",
      );
    }
    return interaction;
  }
  return undefined;
}

export function defineInteraction<
  const Id extends string,
  const InputSchema extends AuthoringSchema,
  const OutputSchema extends AuthoringSchema,
  const Errors extends AuthoringErrorSchemas = Readonly<Record<never, never>>,
>(
  source: InputDefinitionSource<Id, InputSchema, OutputSchema, Errors>,
): InteractionDefinition<
  Id,
  Extract<SchemaValue<InputSchema>, JsonValue>,
  Extract<SchemaValue<OutputSchema>, JsonValue>,
  Extract<AuthoringErrorValues<Errors>, Readonly<Record<string, JsonValue>>>,
  1
>;

export function defineInteraction<
  const Id extends string,
  const OutputSchema extends AuthoringSchema,
  const Errors extends AuthoringErrorSchemas = Readonly<Record<never, never>>,
>(
  source: NoInputDefinitionSource<Id, OutputSchema, Errors>,
): InteractionDefinition<
  Id,
  null,
  Extract<SchemaValue<OutputSchema>, JsonValue>,
  Extract<AuthoringErrorValues<Errors>, Readonly<Record<string, JsonValue>>>,
  0
>;

export function defineInteraction(
  source: Readonly<Record<string, unknown>>,
): AnyInteractionDefinition {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return failHost(
      "INVALID_DECLARATION",
      "defineInteraction",
      "interaction declaration must be an object",
    );
  }
  const allowed = new Set([
    "id",
    "input",
    "output",
    "errors",
    "reads",
    "changes",
    "summary",
    "description",
    "annotations",
  ]);
  const unexpected = Reflect.ownKeys(source).find(
    (key) => typeof key !== "string" || !allowed.has(key),
  );
  if (unexpected !== undefined) {
    failHost(
      "INVALID_DECLARATION",
      "defineInteraction",
      `unsupported interaction declaration field: ${String(unexpected)}`,
    );
  }
  const id = ownData(source, "id");
  const output = ownData(source, "output") as AuthoringSchema;
  const hasInput = Object.hasOwn(source, "input");
  const input = hasInput
    ? ownData(source, "input") as AuthoringSchema
    : absentInputSchema;
  if (typeof id !== "string") {
    failHost("INVALID_DECLARATION", "defineInteraction.id", "id must be a string");
  }
  const summary = ownData(source, "summary");
  const description = ownData(source, "description");
  const rawAnnotations = ownData(source, "annotations");
  const authoredErrors = errorSchemas(ownData(source, "errors"));
  if (summary !== undefined && typeof summary !== "string") {
    failHost(
      "INVALID_DECLARATION",
      "defineInteraction.summary",
      "summary must be a string",
    );
  }
  if (description !== undefined && typeof description !== "string") {
    failHost(
      "INVALID_DECLARATION",
      "defineInteraction.description",
      "description must be a string",
    );
  }
  const annotations = definitionAnnotations(rawAnnotations);
  const definition = Object.freeze({
    id,
    input,
    output,
    errors: authoredErrors,
    reads: stringList(ownData(source, "reads"), "defineInteraction.reads"),
    changes: stringList(
      ownData(source, "changes"),
      "defineInteraction.changes",
    ),
    ...(summary === undefined ? {} : { summary }),
    ...(description === undefined ? {} : { description }),
    ...(annotations === undefined ? {} : { annotations }),
    inputArity: hasInput ? 1 : 0,
  }) as AnyInteractionDefinition;
  definitions.add(definition);
  return definition;
}

export function isInteractionDefinition(
  value: unknown,
): value is AnyInteractionDefinition {
  return value !== null && typeof value === "object" && definitions.has(value);
}

export function declaredErrorSchema(
  interactionId: string,
  errorSchemas: Readonly<Record<string, PortableSchema>>,
): PortableSchema | undefined {
  const entries = Object.entries(errorSchemas);
  if (entries.length === 0) return undefined;
  const variants = entries.map(([code, schema]) => ({
    type: "object",
    properties: {
      code: { const: code },
      details: schema,
    },
    required: ["code", "details"],
    additionalProperties: false,
  }));
  return portableSchema(
    variants.length === 1 ? variants[0]! : { oneOf: variants },
    `${interactionId}.errors`,
  );
}

const declaredErrors = new WeakSet<object>();
const declaredErrorDefinitions = new WeakMap<object, AnyInteractionDefinition>();
const declaredErrorContractDigests = new WeakMap<object, Sha256Digest>();

export class DeclaredInteractionError<
  Details extends JsonValue = JsonValue,
> extends Error {
  readonly interactionId: string;
  readonly code: string;
  readonly details: Details;

  constructor(interactionId: string, code: string, details: Details) {
    super(`interaction returned declared error ${code}`);
    this.name = "DeclaredInteractionError";
    this.interactionId = interactionId;
    this.code = code;
    this.details = details;
    Object.freeze(this);
  }
}

export function declaredInteractionError<
  Definition extends AnyInteractionDefinition,
  Code extends keyof DefinitionErrorsFor<Definition> & string,
>(
  definition: Definition,
  code: Code,
  details: DefinitionErrorsFor<Definition>[Code],
): DeclaredInteractionError<DefinitionErrorsFor<Definition>[Code]> {
  if (!isInteractionDefinition(definition)) {
    return failHost(
      "FORGED_DEFINITION",
      "declaredInteractionError.definition",
      "declared errors require an authentic interaction definition",
    );
  }
  if (!Object.hasOwn(definition.errors, code)) {
    return failHost(
      "INVALID_DECLARED_ERROR",
      `declaredInteractionError.${definition.id}.${code}`,
      "the interaction does not declare this error code",
    );
  }
  let portable: JsonValue;
  try {
    portable = normalizeJson(details, `${definition.id}.errors.${code}`);
  } catch (cause) {
    return failHost(
      "INVALID_DECLARED_ERROR",
      `${definition.id}.errors.${code}`,
      "declared error details must be portable JSON",
      cause,
    );
  }
  const error = new DeclaredInteractionError(definition.id, code, portable);
  declaredErrors.add(error);
  declaredErrorDefinitions.set(error, definition);
  return error as never;
}

/** Reconstructs a validated declared error for a typed local caller. */
export function restoreDeclaredInteractionError(
  interactionId: string,
  contractDigest: Sha256Digest,
  code: string,
  details: JsonValue,
): DeclaredInteractionError {
  const error = new DeclaredInteractionError(interactionId, code, details);
  declaredErrors.add(error);
  declaredErrorContractDigests.set(error, contractDigest);
  return error;
}

type DefinitionErrorsFor<Value> = Value extends InteractionDefinition<
  string,
  any,
  any,
  infer Errors,
  any
>
  ? Errors
  : never;

type DefinitionForHandle<Handle extends InteractionHandle> =
  Handle extends InteractionHandle<infer Definition> ? Definition : never;

type ErrorsForHandle<Handle extends InteractionHandle> = DefinitionErrorsFor<
  DefinitionForHandle<Handle>
>;

export function isDeclaredInteractionError<
  Handle extends InteractionHandle,
  Code extends keyof ErrorsForHandle<Handle> & string,
>(
  error: unknown,
  handle: Handle,
  code: Code,
): error is DeclaredInteractionError<ErrorsForHandle<Handle>[Code]> &
  Readonly<{ code: Code }> {
  return (
    error instanceof DeclaredInteractionError &&
    declaredErrors.has(error) &&
    error.interactionId === handle.interactionId &&
    declaredErrorContractDigests.get(error) === handle.contractDigest &&
    error.code === code
  );
}

export function isAuthenticDeclaredError(
  value: unknown,
): value is DeclaredInteractionError {
  return (
    value instanceof DeclaredInteractionError &&
    declaredErrors.has(value) &&
    declaredErrorDefinitions.has(value)
  );
}

export function definitionForDeclaredError(
  value: DeclaredInteractionError,
): AnyInteractionDefinition | undefined {
  return declaredErrorDefinitions.get(value);
}

export function errorEnvelope(
  error: DeclaredInteractionError,
): JsonObject {
  return Object.freeze({ code: error.code, details: error.details });
}
