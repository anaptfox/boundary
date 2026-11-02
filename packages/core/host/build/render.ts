import { canonicalJson, normalizeJson, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { assertProjectionBinding } from "../binding";
import { metadataForCompiled } from "../compile";
import { failHost } from "../errors";
import { metadataForInstallation } from "../install";
import { metadataForProjection } from "../projection";
import type {
  HostArtifactFile,
  HostArtifactReferenceModule,
  HostArtifactSet,
  NamedHostArtifact,
  RenderHostArtifactsOptions,
} from "./types";

export const HOST_ARTIFACT_INVENTORY_PATH =
  ".boundary-core-host-inventory.json" as const;

const artifactSets = new WeakSet<object>();
const encoder = new TextEncoder();

function artifactPath(name: unknown, suffix: string, path: string): string {
  if (typeof name !== "string" || name.length === 0) {
    return failHost(
      "INVALID_ARTIFACT_PATH",
      path,
      "artifact names must be non-empty relative POSIX paths",
    );
  }
  if (
    name.includes("\\") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("\0") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return failHost(
      "INVALID_ARTIFACT_PATH",
      path,
      "artifact names must be normalized relative POSIX paths without dot segments",
    );
  }
  return `${name}${suffix}`;
}

function artifact(path: string, value: unknown): HostArtifactFile {
  let portable: JsonValue;
  try {
    portable = normalizeJson(value, path);
  } catch (cause) {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "host artifacts must contain only portable JSON",
      cause,
    );
  }
  const bytes = Object.freeze([...encoder.encode(`${canonicalJson(portable)}\n`)]);
  return Object.freeze({ path, bytes });
}

function sourceArtifact(path: string, source: string): HostArtifactFile {
  return Object.freeze({
    path,
    bytes: Object.freeze([...encoder.encode(source)]),
  });
}

function recordEntries<Value>(
  value: Readonly<Record<string, NamedHostArtifact<Value>>> | undefined,
  path: string,
): readonly (readonly [string, NamedHostArtifact<Value>])[] {
  if (value === undefined) return Object.freeze([]);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "artifact collections must be closed records",
    );
  }
  return Object.freeze(
    Object.entries(value).sort(([left], [right]) => compareUtf8(left, right)),
  );
}

function namedValue<Value>(
  entry: NamedHostArtifact<Value>,
  path: string,
): NamedHostArtifact<Value> {
  if (entry === null || typeof entry !== "object") {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "artifact entries require an explicit name and value",
    );
  }
  return entry;
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function requireIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !identifier.test(value)) {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "generated TypeScript names must be JavaScript identifiers",
    );
  }
  return value;
}

// Binding names have stricter rules than property names in definition records.
const reservedBindingNames = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package",
  "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield",
]);

function requireBindingName(value: unknown, path: string): string {
  const name = requireIdentifier(value, path);
  if (reservedBindingNames.has(name)) {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "generated export names must be valid strict-module binding identifiers",
    );
  }
  if (name === "Object") {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "generated export names must not shadow the Object.freeze intrinsic",
    );
  }
  return name;
}

function requireModule(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\0\r\n\u2028\u2029]/u.test(value)
  ) {
    return failHost(
      "INVALID_ARTIFACT",
      path,
      "generated type modules must be explicit non-empty module specifiers",
    );
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost("INVALID_ARTIFACT", path, "generated reference metadata must be a record");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const extra = Reflect.ownKeys(value).find(
    (key) => typeof key !== "string" || !allowed.includes(key),
  );
  if (extra !== undefined) {
    failHost(
      "INVALID_ARTIFACT",
      `${path}.${String(extra)}`,
      "generated reference metadata contains an unknown field",
    );
  }
}

function typeSource(value: unknown, path: string) {
  const record = requireRecord(value, path);
  exactKeys(record, ["module", "export"], path);
  return Object.freeze({
    module: requireModule(record.module, `${path}.module`),
    export: requireIdentifier(record.export, `${path}.export`),
  });
}

function interactionSource(value: unknown, path: string) {
  const record = requireRecord(value, path);
  exactKeys(record, ["compiled", "module", "export"], path);
  metadataForCompiled(record.compiled as never);
  return Object.freeze({
    compiled: record.compiled as HostArtifactReferenceModule["source"]["compiled"],
    module: requireModule(record.module, `${path}.module`),
    export: requireIdentifier(record.export, `${path}.export`),
  });
}

function renderReferenceModule(value: HostArtifactReferenceModule): string {
  const record = requireRecord(value, "references.value");
  exactKeys(record, ["binding", "projection", "source", "exportName", "members"], "references.value");
  if ((value.binding === undefined) === (value.projection === undefined)) {
    return failHost("INVALID_ARTIFACT", "references.value", "references require exactly one Projection or Binding");
  }
  if (value.binding !== undefined) assertProjectionBinding(value.binding);
  else metadataForProjection(value.projection!);
  const selections = value.binding !== undefined
    ? value.binding.manifest.interactions
    : value.projection!.manifest.interactions.flatMap((interaction) =>
      interaction.modes.map((mode) => ({ ...interaction, mode }))
    );
  const source = interactionSource(value.source, "references.value.source");
  const exportName = requireBindingName(
    value.exportName,
    "references.value.exportName",
  );
  const members = requireRecord(value.members, "references.value.members");
  const grouped = new Map<
    string,
    {
      interactionId: string;
      contractDigest: string;
      inputArity: 0 | 1;
      modes: Array<"direct" | "request">;
    }
  >();
  for (const interaction of selections) {
    const existing = grouped.get(interaction.alias);
    if (existing) {
      if (
        existing.interactionId !== interaction.interactionId ||
        existing.contractDigest !== interaction.expectedContractDigest ||
        existing.inputArity !== interaction.inputArity
      ) {
        failHost(
          "INVALID_ARTIFACT",
          `references.value.binding.${interaction.alias}`,
          "one Binding alias must retain one expected interaction identity",
        );
      }
      existing.modes.push(interaction.mode);
    } else {
      grouped.set(interaction.alias, {
        interactionId: interaction.interactionId,
        contractDigest: interaction.expectedContractDigest,
        inputArity: interaction.inputArity,
        modes: [interaction.mode],
      });
    }
  }
  const aliases = [...grouped.keys()].sort(compareUtf8);
  const memberKeys = Reflect.ownKeys(members);
  if (
    memberKeys.some((key) => typeof key !== "string") ||
    memberKeys.length !== aliases.length ||
    aliases.some((alias) => !Object.hasOwn(members, alias))
  ) {
    return failHost(
      "INVALID_ARTIFACT",
      "references.value.members",
      "reference members must cover every Binding alias exactly",
    );
  }

  const requestTypes: string[] = [];
  const typeFields: string[] = [];
  const valueFields: string[] = [];
  for (const [index, alias] of aliases.entries()) {
    const interaction = grouped.get(alias)!;
    interaction.modes.sort(compareUtf8);
    const memberPath = `references.value.members.${alias}`;
    const member = requireRecord(members[alias], memberPath);
    exactKeys(member, ["definition", "requestOutput"], memberPath);
    const definition = requireIdentifier(
      member.definition,
      `${memberPath}.definition`,
    );
    const sourceHandle = source.compiled.handles[definition];
    if (
      sourceHandle === undefined
      || sourceHandle.interactionId !== interaction.interactionId
      || sourceHandle.contractDigest !== interaction.contractDigest
      || sourceHandle.inputArity !== interaction.inputArity
    ) {
      return failHost(
        "INVALID_ARTIFACT",
        `${memberPath}.definition`,
        "reference definition must name the exact compiled interaction bound to this alias",
      );
    }
    const hasRequest = interaction.modes.includes("request");
    let requestType = "";
    if (hasRequest && value.projection !== undefined) {
      if (member.requestOutput !== undefined) {
        return failHost("INVALID_ARTIFACT", `${memberPath}.requestOutput`, "a typed public request result requires a Binding; a Projection declares request mode only");
      }
      requestType = ', import("@foxworth/boundary/program").JsonValue';
    } else if (hasRequest) {
      if (member.requestOutput === undefined) {
        return failHost(
          "INVALID_ARTIFACT",
          `${memberPath}.requestOutput`,
          "request references require an explicit public request output type",
        );
      }
      const output = typeSource(
        member.requestOutput,
        `${memberPath}.requestOutput`,
      );
      const name = `RequestOutput${index}`;
      requestTypes.push(
        `type ${name} = import(${JSON.stringify(output.module)}).${output.export};`,
      );
      requestType = `, ${name}`;
    } else if (member.requestOutput !== undefined) {
      return failHost(
        "INVALID_ARTIFACT",
        `${memberPath}.requestOutput`,
        "direct-only references must not declare a request output type",
      );
    }
    const modes = interaction.modes.map((mode) => JSON.stringify(mode)).join(", ");
    typeFields.push(
      `  readonly ${JSON.stringify(alias)}: ProjectedInteractionHandle<InteractionHandle<SourceInteractions[${JSON.stringify(definition)}]>, readonly [${modes}]${requestType}>;`,
    );
    valueFields.push(
      [
        `  [${JSON.stringify(alias)}]: Object.freeze({`,
        `    interactionId: ${JSON.stringify(interaction.interactionId)},`,
        `    contractDigest: ${JSON.stringify(interaction.contractDigest)},`,
        `    inputArity: ${interaction.inputArity},`,
        `    modes: Object.freeze([${modes}] as const),`,
        "  }),",
      ].join("\n"),
    );
  }
  return [
    "// Generated by @foxworth/boundary/host/build. Do not edit.",
    'import type { InteractionHandle, ProjectedInteractionHandle } from "@foxworth/boundary";',
    "",
    `type SourceInteractions = (typeof import(${JSON.stringify(source.module)}))[${JSON.stringify(source.export)}];`,
    ...requestTypes,
    "",
    `export const ${exportName}: Readonly<{`,
    ...typeFields,
    "}> = Object.freeze({",
    ...valueFields,
    "});",
    "",
  ].join("\n");
}

export function renderHostArtifacts(
  options: RenderHostArtifactsOptions,
): HostArtifactSet {
  if (options === null || typeof options !== "object") {
    return failHost(
      "INVALID_ARTIFACT",
      "options",
      "renderHostArtifacts options are required",
    );
  }
  const files: HostArtifactFile[] = [];
  if (options.program !== undefined) {
    const entry = namedValue(options.program, "program");
    files.push(
      artifact(
        artifactPath(entry.name, ".program.json", "program.name"),
        entry.value,
      ),
    );
  }
  for (const [alias, raw] of recordEntries(options.projections, "projections")) {
    const entry = namedValue(raw, `projections.${alias}`);
    metadataForProjection(entry.value);
    files.push(
      artifact(
        artifactPath(
          entry.name,
          ".projection.json",
          `projections.${alias}.name`,
        ),
        entry.value.manifest,
      ),
    );
  }
  for (const [alias, raw] of recordEntries(
    options.installations,
    "installations",
  )) {
    const entry = namedValue(raw, `installations.${alias}`);
    metadataForInstallation(entry.value);
    files.push(
      artifact(
        artifactPath(
          entry.name,
          ".installation.json",
          `installations.${alias}.name`,
        ),
        entry.value.manifest,
      ),
    );
  }
  for (const [alias, raw] of recordEntries(options.bindings, "bindings")) {
    const entry = namedValue(raw, `bindings.${alias}`);
    assertProjectionBinding(entry.value);
    files.push(
      artifact(
        artifactPath(entry.name, ".binding.json", `bindings.${alias}.name`),
        entry.value.manifest,
      ),
    );
  }
  for (const [alias, raw] of recordEntries(options.references, "references")) {
    const entry = namedValue(raw, `references.${alias}`);
    files.push(
      sourceArtifact(
        artifactPath(
          entry.name,
          ".references.ts",
          `references.${alias}.name`,
        ),
        renderReferenceModule(entry.value),
      ),
    );
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const duplicate = files.find(
    (file, index) => index > 0 && files[index - 1]!.path === file.path,
  );
  if (duplicate) {
    return failHost(
      "INVALID_ARTIFACT_PATH",
      duplicate.path,
      "two host artifacts resolve to the same path",
    );
  }
  const inventory = Object.freeze({
    version: 1 as const,
    path: HOST_ARTIFACT_INVENTORY_PATH,
    files: Object.freeze(files.map((file) => file.path)),
  });
  const result = Object.freeze({
    version: 1 as const,
    files: Object.freeze(files),
    inventory,
  });
  artifactSets.add(result);
  return result;
}

export function assertHostArtifactSet(value: unknown): asserts value is HostArtifactSet {
  if (value === null || typeof value !== "object" || !artifactSets.has(value)) {
    failHost(
      "INVALID_ARTIFACT",
      "artifacts",
      "an authentic renderHostArtifacts result is required",
    );
  }
}
