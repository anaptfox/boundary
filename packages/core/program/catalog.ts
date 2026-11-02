import { BoundaryErrorBase } from "./errors";
import {
  compareUtf8,
  isSha256Digest,
  normalizeJson,
  type JsonObject,
  type JsonSchema,
  type Sha256Digest,
} from "./json";
import type { Program } from "./program";
import { validatePortableSchema } from "./validation";

const REALIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u;

export type CatalogDirectMode = Readonly<{
  realizationId: string;
}>;

export type CatalogRequestMode = Readonly<{
  realizationId: string;
  controlDigest: Sha256Digest;
  previewSchema: JsonSchema;
}>;

/** Handler-free availability for one declared interaction. */
export type CatalogEntry = Readonly<{
  interactionId: string;
  direct?: CatalogDirectMode;
  request?: CatalogRequestMode;
}>;

/**
 * Handler-free deployment overlay. Membership never changes interaction meaning;
 * it pins which exact mode realizations one deployment makes available.
 */
export type Catalog = Readonly<{
  version: 1;
  programDigest: Sha256Digest;
  interactions: readonly CatalogEntry[];
}>;

export type CatalogSource = readonly CatalogEntry[];

export type CatalogDiagnosticCode =
  | "CATALOG_INVALID_PROGRAM_DIGEST"
  | "CATALOG_PROGRAM_MISMATCH"
  | "CATALOG_UNKNOWN_INTERACTION"
  | "CATALOG_MISSING_INTERACTION"
  | "CATALOG_DUPLICATE_INTERACTION"
  | "CATALOG_INVALID_AVAILABILITY"
  | "CATALOG_INVALID_REALIZATION_ID"
  | "CATALOG_DUPLICATE_REALIZATION"
  | "CATALOG_INVALID_CONTROL_DIGEST"
  | "CATALOG_INVALID_PREVIEW_SCHEMA";

export class CatalogError extends BoundaryErrorBase {
  declare readonly code: CatalogDiagnosticCode;

  constructor(code: CatalogDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "CatalogError";
  }
}

function fail(
  code: CatalogDiagnosticCode,
  path: string,
  message: string,
): never {
  throw new CatalogError(code, path, message);
}

function requireObject(
  value: unknown,
  path: string,
  label: string,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CATALOG_INVALID_AVAILABILITY", path, `${label} must be an object`);
  }
  return value as JsonObject;
}

function requireExactKeys(
  value: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    fail(
      "CATALOG_INVALID_AVAILABILITY",
      `${path}.${extra}`,
      `${path} contains an unsupported field`,
    );
  }
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    fail(
      "CATALOG_INVALID_AVAILABILITY",
      `${path}.${missing}`,
      `${path} requires ${missing}`,
    );
  }
}

function requireRealizationId(value: unknown, path: string): string {
  if (typeof value !== "string" || !REALIZATION_ID_PATTERN.test(value)) {
    fail(
      "CATALOG_INVALID_REALIZATION_ID",
      path,
      "realizationId must be a non-empty stable ASCII token",
    );
  }
  return value;
}

function normalizeDirect(value: unknown, path: string): CatalogDirectMode {
  const direct = requireObject(value, path, "direct mode");
  requireExactKeys(direct, path, ["realizationId"]);
  return Object.freeze({
    realizationId: requireRealizationId(
      direct["realizationId"],
      `${path}.realizationId`,
    ),
  });
}

function normalizeRequest(value: unknown, path: string): CatalogRequestMode {
  const request = requireObject(value, path, "request mode");
  requireExactKeys(request, path, [
    "realizationId",
    "controlDigest",
    "previewSchema",
  ]);
  const controlDigest = request["controlDigest"];
  if (!isSha256Digest(controlDigest)) {
    fail(
      "CATALOG_INVALID_CONTROL_DIGEST",
      `${path}.controlDigest`,
      "controlDigest must be sha256:<64 lowercase hex>",
    );
  }
  const previewSchema = request["previewSchema"];
  if (
    previewSchema === null ||
    typeof previewSchema !== "object" ||
    Array.isArray(previewSchema)
  ) {
    fail(
      "CATALOG_INVALID_PREVIEW_SCHEMA",
      `${path}.previewSchema`,
      "previewSchema must be a portable schema object",
    );
  }
  try {
    validatePortableSchema(
      previewSchema as JsonSchema,
      `${path}.previewSchema`,
    );
  } catch {
    fail(
      "CATALOG_INVALID_PREVIEW_SCHEMA",
      `${path}.previewSchema`,
      "previewSchema must use the portable schema profile",
    );
  }
  return Object.freeze({
    realizationId: requireRealizationId(
      request["realizationId"],
      `${path}.realizationId`,
    ),
    controlDigest,
    previewSchema: previewSchema as JsonSchema,
  });
}

function normalizeInteractions(
  program: Program,
  source: CatalogSource,
): readonly CatalogEntry[] {
  const safeSource = normalizeJson(source, "catalog.interactions");
  if (!Array.isArray(safeSource)) {
    fail(
      "CATALOG_INVALID_AVAILABILITY",
      "catalog.interactions",
      "catalog interactions must be an array of interaction entries",
    );
  }

  const programIds = new Set(
    program.interactions.map((interaction) => interaction.contract.id),
  );
  const seenInteractions = new Set<string>();
  const seenRealizations = new Set<string>();
  const normalized: CatalogEntry[] = [];

  for (let index = 0; index < safeSource.length; index += 1) {
    const path = `catalog.interactions[${index}]`;
    const entry = requireObject(safeSource[index], path, "catalog entry");
    requireExactKeys(entry, path, ["interactionId"], ["direct", "request"]);
    const interactionId = entry["interactionId"];
    if (typeof interactionId !== "string" || !programIds.has(interactionId)) {
      fail(
        "CATALOG_UNKNOWN_INTERACTION",
        `${path}.interactionId`,
        `catalog cannot advertise interaction absent from program: ${String(interactionId)}`,
      );
    }
    if (seenInteractions.has(interactionId)) {
      fail(
        "CATALOG_DUPLICATE_INTERACTION",
        `${path}.interactionId`,
        `catalog contains duplicate interaction entry: ${interactionId}`,
      );
    }
    seenInteractions.add(interactionId);

    const direct = Object.hasOwn(entry, "direct")
      ? normalizeDirect(entry["direct"], `${path}.direct`)
      : undefined;
    const request = Object.hasOwn(entry, "request")
      ? normalizeRequest(entry["request"], `${path}.request`)
      : undefined;
    for (const [mode, realizationId] of [
      ["direct", direct?.realizationId],
      ["request", request?.realizationId],
    ] as const) {
      if (realizationId === undefined) continue;
      if (seenRealizations.has(realizationId)) {
        fail(
          "CATALOG_DUPLICATE_REALIZATION",
          `${path}.${mode}.realizationId`,
          "one realizationId cannot identify more than one interaction mode",
        );
      }
      seenRealizations.add(realizationId);
    }

    normalized.push(
      Object.freeze({
        interactionId,
        ...(direct === undefined ? {} : { direct }),
        ...(request === undefined ? {} : { request }),
      }),
    );
  }

  for (const interactionId of [...programIds].sort(compareUtf8)) {
    if (!seenInteractions.has(interactionId)) {
      fail(
        "CATALOG_MISSING_INTERACTION",
        "catalog.interactions",
        `catalog must declare availability for program interaction: ${interactionId}`,
      );
    }
  }

  return Object.freeze(
    normalized.sort((left, right) =>
      compareUtf8(left.interactionId, right.interactionId),
    ),
  );
}

export function createCatalog(
  program: Program,
  interactions: CatalogSource,
): Catalog {
  if (program.version !== 1 || !isSha256Digest(program.programDigest)) {
    fail(
      "CATALOG_INVALID_PROGRAM_DIGEST",
      "catalog.programDigest",
      "catalog requires a valid program SHA-256 digest",
    );
  }
  return Object.freeze({
    version: 1,
    programDigest: program.programDigest,
    interactions: normalizeInteractions(program, interactions),
  });
}

/** Revalidate a received catalog against the exact program it claims to expose. */
export function validateCatalog(program: Program, catalog: Catalog): Catalog {
  if (catalog.version !== 1 || !isSha256Digest(catalog.programDigest)) {
    fail(
      "CATALOG_INVALID_PROGRAM_DIGEST",
      "catalog.programDigest",
      "catalog must use version 1 with a valid program SHA-256 digest",
    );
  }
  if (catalog.programDigest !== program.programDigest) {
    fail(
      "CATALOG_PROGRAM_MISMATCH",
      "catalog.programDigest",
      "catalog was produced for a different program",
    );
  }
  return createCatalog(program, catalog.interactions);
}
