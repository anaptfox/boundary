import type { JsonValue } from "@foxworth/boundary/program";
import { modeForHandle, snapshotProjectedHandle, type AnyProjectedInteractionHandle, type ResolvedBindingInteraction } from "@foxworth/boundary/remote";
import { WebMcpError } from "./errors";
import type { WebMcpTool } from "./types";

export const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export const toolDeclarations = new WeakSet<object>();

export function fail(
  code: ConstructorParameters<typeof WebMcpError>[0],
  path: string,
  message: string,
): never {
  throw new WebMcpError(code, path, message);
}

function snapshotExposedTo(
  origins: readonly string[] | undefined,
  path: string,
): readonly string[] | undefined {
  if (origins === undefined) return undefined;
  if (!Array.isArray(origins)) {
    fail("INVALID_TOOL", path, "exposedTo must be an array of origin strings");
  }
  return Object.freeze(
    origins.map((origin, index) => {
      if (typeof origin !== "string" || !origin.trim()) {
        fail(
          "INVALID_TOOL",
          `${path}[${index}]`,
          "exposedTo entries must be non-empty origin strings",
        );
      }
      return origin.trim();
    }),
  );
}

export function webMcpTool<Handle extends AnyProjectedInteractionHandle>(
  handleValue: Handle,
  options: Readonly<{
    mode?: Handle["modes"][number];
    name?: string;
    title?: string;
    description?: string;
    consequentialHint?: boolean;
    debugging?: boolean;
    untrustedContentHint?: boolean;
    exposedTo?: readonly string[];
  }> = {},
): WebMcpTool<Handle> {
  const handle = snapshotProjectedHandle(handleValue, "webMcpTool.handle");
  const mode = modeForHandle(handle, options.mode, "webMcpTool.mode");
  for (const [key, value] of [
    ["name", options.name],
    ["title", options.title],
    ["description", options.description],
  ] as const) {
    if (value !== undefined && !value.trim()) {
      fail("INVALID_TOOL", `webMcpTool.${key}`, `${key} must not be empty`);
    }
  }
  for (const [key, value] of [
    ["consequentialHint", options.consequentialHint],
    ["debugging", options.debugging],
    ["untrustedContentHint", options.untrustedContentHint],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      fail("INVALID_TOOL", `webMcpTool.${key}`, `${key} must be a boolean`);
    }
  }
  const exposedTo = snapshotExposedTo(options.exposedTo, "webMcpTool.exposedTo");
  const declaration = Object.freeze({
    handle,
    mode,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.consequentialHint === undefined
      ? {}
      : { consequentialHint: options.consequentialHint }),
    ...(options.debugging === undefined ? {} : { debugging: options.debugging }),
    ...(options.untrustedContentHint === undefined
      ? {}
      : { untrustedContentHint: options.untrustedContentHint }),
    ...(exposedTo === undefined ? {} : { exposedTo }),
  });
  toolDeclarations.add(declaration);
  return declaration;
}

export type WebMcpToolSource = Readonly<{
  readonly handles: Readonly<Record<string, AnyProjectedInteractionHandle>>;
}>;

export type WebMcpToolOptions = NonNullable<Parameters<typeof webMcpTool>[1]>;

/** One WebMCP tool per projected handle. Optional extras are keyed by alias. */
export function webMcpTools(
  projection: WebMcpToolSource,
  extras: Readonly<Record<string, WebMcpToolOptions>> = {},
): WebMcpTool[] {
  return Object.entries(projection.handles).map(([alias, handle]) =>
    webMcpTool(handle, extras[alias] ?? {}),
  );
}

export function inputAnnotations(descriptor: ResolvedBindingInteraction["expected"]):
  | JsonValue
  | undefined {
  const annotations = descriptor.annotations;
  if (
    annotations === undefined ||
    annotations === null ||
    typeof annotations !== "object" ||
    Array.isArray(annotations)
  ) {
    return undefined;
  }
  const schemas = (annotations as { readonly schemas?: JsonValue }).schemas;
  if (
    schemas === undefined ||
    schemas === null ||
    typeof schemas !== "object" ||
    Array.isArray(schemas)
  ) {
    return undefined;
  }
  return (schemas as { readonly input?: JsonValue }).input;
}
