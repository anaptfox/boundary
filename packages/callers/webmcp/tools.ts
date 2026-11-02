import type { JsonValue } from "@foxworth/boundary/program";
import { resolveSelection, selectionsOf, verbForMode, type InteractionSource, type ResolvedBindingInteraction, type SourceAliases, type SourceVerbs } from "@foxworth/boundary/remote";
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

/** Declare one WebMCP tool over an alias the caller (or, offline, a CompiledSurface) selects. */
export function webMcpTool<S extends InteractionSource, const Alias extends SourceAliases<S>>(
  source: S,
  alias: Alias,
  options: Readonly<{
    /** `call` or `propose`; required when the alias is selected for both. */
    mode?: SourceVerbs<S, Alias>;
    name?: string;
    title?: string;
    description?: string;
    consequentialHint?: boolean;
    debugging?: boolean;
    untrustedContentHint?: boolean;
    exposedTo?: readonly string[];
  }> = {},
): WebMcpTool {
  const { handle, mode } = resolveSelection(source, alias, options.mode as never, "webMcpTool");
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
  const declaration: WebMcpTool = Object.freeze({
    alias,
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

export type WebMcpToolSource = InteractionSource;

export type WebMcpToolOptions = Omit<NonNullable<Parameters<typeof webMcpTool>[2]>, "mode">;

/** One WebMCP tool per selected (alias, mode). Optional extras are keyed by alias. */
export function webMcpTools(
  source: WebMcpToolSource,
  extras: Readonly<Record<string, WebMcpToolOptions>> = {},
): WebMcpTool[] {
  return selectionsOf(source, "webMcpTools").map((selection) =>
    webMcpTool(source, selection.alias as never, {
      ...extras[selection.alias],
      mode: verbForMode(selection.mode) as never,
    }),
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
