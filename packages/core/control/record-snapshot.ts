import { cloneJson, type JsonValue } from "@foxworth/boundary/program";
import { controlError } from "./errors";

export function snapshot<T>(value: T, path: string): T {
  return cloneJson(value as unknown as JsonValue, path) as unknown as T;
}

export function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordSourceSnapshot<T>(value: T, path: string): T {
  try {
    return snapshot(value, path);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      path,
      error instanceof Error ? error.message : "record must be portable data",
      error,
    );
  }
}

export function requireExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  path: string,
): void {
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected !== undefined) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      `${path}.${unexpected}`,
      `unexpected record field: ${unexpected}`,
    );
  }
  const missing = required.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      `${path}.${missing}`,
      `required record field is missing: ${missing}`,
    );
  }
}
