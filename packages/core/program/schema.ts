import { BoundaryErrorBase } from "./errors";
import {
  normalizeJson,
  type JsonObject,
  type JsonSchema,
} from "./json";
import { validatePortableSchema } from "./validation";

export type SchemaRole = "input" | "output" | "error";

export type SchemaCompilationContext = {
  readonly role: SchemaRole;
  readonly path: string;
};

export type SchemaCompilation = {
  /** Assertion-bearing portable JSON Schema used by contract identity. */
  readonly contract: JsonSchema;
  /** Projector hints and documentation excluded from contract identity. */
  readonly annotations: JsonObject;
};

export interface SchemaAdapter<Schema> {
  compile(
    schema: Schema,
    context: SchemaCompilationContext,
  ): {
    readonly contract: unknown;
    readonly annotations?: unknown;
  };
}

export type SchemaAdapterDiagnosticCode =
  | "SCHEMA_ADAPTER_COMPILE_FAILED"
  | "SCHEMA_ADAPTER_CONTRACT_NOT_OBJECT"
  | "SCHEMA_ADAPTER_ANNOTATIONS_NOT_OBJECT";

export class SchemaAdapterError extends BoundaryErrorBase {
  declare readonly code: SchemaAdapterDiagnosticCode;

  constructor(
    code: SchemaAdapterDiagnosticCode,
    path: string,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(code, path, message, options);
    this.name = "SchemaAdapterError";
  }
}

function isStableSchemaDiagnostic(
  error: unknown,
): error is Error & { readonly code: string; readonly path: string } {
  if (!(error instanceof Error) || !("code" in error) || !("path" in error)) {
    return false;
  }
  return (
    typeof error.code === "string" &&
    /^SCHEMA_[A-Z0-9_]+$/u.test(error.code) &&
    typeof error.path === "string"
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Compile through an explicit schema adapter, then enforce Boundary's strict
 * portable JSON seam. Core never has to know an adapter's internal format.
 */
export function compileSchema<Schema>(
  schema: Schema,
  adapter: SchemaAdapter<Schema>,
  context: SchemaCompilationContext,
): SchemaCompilation {
  let compiled: ReturnType<SchemaAdapter<Schema>["compile"]>;
  try {
    compiled = adapter.compile(schema, context);
  } catch (error) {
    if (isStableSchemaDiagnostic(error)) throw error;
    throw new SchemaAdapterError(
      "SCHEMA_ADAPTER_COMPILE_FAILED",
      context.path,
      "schema adapter could not compile the schema",
      { cause: error },
    );
  }
  const contract = normalizeJson(compiled.contract, context.path);
  if (!isJsonObject(contract)) {
    throw new SchemaAdapterError(
      "SCHEMA_ADAPTER_CONTRACT_NOT_OBJECT",
      context.path,
      "compiled contract schema must be a JSON object",
    );
  }
  validatePortableSchema(contract, context.path);

  const annotationPath = `${context.path}.annotations`;
  const annotations = normalizeJson(compiled.annotations ?? {}, annotationPath);
  if (!isJsonObject(annotations)) {
    throw new SchemaAdapterError(
      "SCHEMA_ADAPTER_ANNOTATIONS_NOT_OBJECT",
      annotationPath,
      "compiled schema annotations must be a JSON object",
    );
  }

  return Object.freeze({ contract, annotations });
}
