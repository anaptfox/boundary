import { BoundaryErrorBase } from "./errors";
import { type JsonValue } from "./json";
import { snapshotJson } from "./snapshot";

export type SchemaCompilationDiagnosticCode =
  | "SCHEMA_NON_FINITE_NUMBER"
  | "SCHEMA_NON_JSON_VALUE"
  | "SCHEMA_UNKNOWN_ZOD_NODE"
  | "SCHEMA_RUNTIME_TRANSFORM"
  | "SCHEMA_NON_JSON_TYPE"
  | "SCHEMA_UNSUPPORTED_KEYWORD"
  | "SCHEMA_NOT_PORTABLE"
  | "SCHEMA_NOT_OBJECT";

export class SchemaCompilationError extends BoundaryErrorBase {
  declare readonly code: SchemaCompilationDiagnosticCode;

  constructor(
    code: SchemaCompilationDiagnosticCode,
    path: string,
    message: string,
  ) {
    super(code, path, message);
    this.name = "SchemaCompilationError";
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function jsonValue(value: unknown, path: string): JsonValue {
  return snapshotJson(value, {
    path,
    fail: (failure) => {
      throw new SchemaCompilationError(
        failure.code === "JSON_NON_FINITE_NUMBER"
          ? "SCHEMA_NON_FINITE_NUMBER"
          : "SCHEMA_NON_JSON_VALUE",
        failure.path,
        failure.message,
      );
    },
  });
}
