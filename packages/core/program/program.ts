import { BoundaryErrorBase } from "./errors";
import {
  cloneJson,
  compareUtf8,
  hashJson,
  isSha256Digest,
  normalizeJson,
  type DomainHasher,
  type JsonArray,
  type JsonObject,
  type JsonSchema,
  type Sha256Digest,
} from "./json";
import { exactObject } from "./snapshot";
import { validatePortableSchema } from "./validation";

export const INTERACTION_CONTRACT_DOMAIN = "boundary.interaction-contract/v1";
export const PROGRAM_DOMAIN = "boundary.program/v1";
export const INTERACTION_ID_PATTERN =
  "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$" as const;
const INTERACTION_ID_REGEXP = new RegExp(INTERACTION_ID_PATTERN, "u");
const normalizedContracts = new WeakSet<object>();

export function isInteractionId(value: unknown): value is string {
  return typeof value === "string" && INTERACTION_ID_REGEXP.test(value);
}

/** The complete declared identity of one interaction in Boundary Program v1. */
export type InteractionContract = {
  readonly version: 1;
  readonly id: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly errorSchema?: JsonSchema;
  readonly reads: readonly string[];
  readonly changes: readonly string[];
};

/** The exact contract value hashed for identity. */
export type InteractionContractIdentity = InteractionContract;

/** Exact interaction identity carried across realization and control seams. */
export type InteractionIdentity = {
  readonly interactionId: string;
  readonly contractDigest: Sha256Digest;
};

export type InteractionDocumentation = {
  readonly summary?: string;
  readonly description?: string;
};

export type InteractionDescriptorSource = {
  readonly contract: InteractionContract;
  readonly docs?: InteractionDocumentation;
  readonly annotations?: JsonObject;
};

/** Handler-free interaction meaning plus non-identity presentation metadata. */
export type InteractionDescriptor = {
  readonly version: 1;
  readonly contract: InteractionContract;
  readonly contractDigest: Sha256Digest;
  readonly docs: InteractionDocumentation;
  readonly annotations: JsonObject;
};

/** A deterministic handler-free set of interaction descriptors. */
export type Program = {
  readonly version: 1;
  readonly interactions: readonly InteractionDescriptor[];
  readonly programDigest: Sha256Digest;
};

export type ProgramDiff = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
};

export type ProgramDiagnosticCode =
  | "INVALID_HASHER_RESULT"
  | "INVALID_INTERACTION_ID"
  | "INVALID_INTERACTION_FOOTPRINT"
  | "UNSUPPORTED_CONTRACT_VERSION"
  | "UNSUPPORTED_DESCRIPTOR_VERSION"
  | "UNSUPPORTED_PROGRAM_VERSION"
  | "EMPTY_READ"
  | "EMPTY_CHANGE"
  | "CONTRACT_DIGEST_MISMATCH"
  | "PROGRAM_DIGEST_MISMATCH"
  | "DUPLICATE_INTERACTION_ID"
  | "INVALID_DOCUMENTATION";

export class ProgramError extends BoundaryErrorBase {
  declare readonly code: ProgramDiagnosticCode;

  constructor(code: ProgramDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "ProgramError";
  }
}

function fail(
  code: ProgramDiagnosticCode,
  path: string,
  message: string,
): never {
  throw new ProgramError(code, path, message);
}

async function digest(
  hasher: DomainHasher,
  domain: string,
  value: JsonObject | JsonArray,
): Promise<Sha256Digest> {
  const result = await hasher(domain, value);
  if (!isSha256Digest(result)) {
    fail(
      "INVALID_HASHER_RESULT",
      domain,
      "hasher must return sha256:<64 lowercase hex>",
    );
  }
  return result;
}

function validateInteractionId(id: string): void {
  if (!isInteractionId(id)) {
    fail(
      "INVALID_INTERACTION_ID",
      `${id || "interaction"}.id`,
      `interaction id must be a stable ASCII token of at most 128 characters: ${id}`,
    );
  }
}

function normalizeEffects(
  interactionId: string,
  field: "reads" | "changes",
  rawValue: unknown,
): readonly string[] {
  const path = `${interactionId}.contract.${field}`;
  let value: ReturnType<typeof normalizeJson>;
  try {
    value = normalizeJson(rawValue, path);
  } catch {
    return fail(
      "INVALID_INTERACTION_FOOTPRINT",
      path,
      `${field} must be an own enumerable data-property array of strings`,
    );
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return fail(
      "INVALID_INTERACTION_FOOTPRINT",
      path,
      `${field} must be an own enumerable data-property array of strings`,
    );
  }
  const values = value as readonly string[];
  const normalized = [...new Set(values)].sort(compareUtf8);
  const empty = normalized.find((value) => !value.trim());
  if (empty !== undefined) {
    fail(
      field === "reads" ? "EMPTY_READ" : "EMPTY_CHANGE",
      `${interactionId}.contract.${field}`,
      `${interactionId} has an empty ${field === "reads" ? "read" : "change"}`,
    );
  }
  return Object.freeze(normalized);
}

function normalizeContract(contract: InteractionContract): InteractionContract {
  if (contract.version !== 1) {
    fail(
      "UNSUPPORTED_CONTRACT_VERSION",
      `${contract.id}.contract.version`,
      `${contract.id} must use interaction contract version 1`,
    );
  }
  const id = contract.id;
  validateInteractionId(id);
  const snapped = exactObject(contract as unknown, {
    path: `${id}.contract`,
    keys: ["version", "id", "inputSchema", "outputSchema", "reads", "changes"],
    optionalKeys: ["errorSchema"],
    fail: (f) => fail("INVALID_INTERACTION_FOOTPRINT", f.path, f.message),
  });
  validatePortableSchema(snapped.inputSchema as JsonSchema, `${id}.inputSchema`);
  validatePortableSchema(snapped.outputSchema as JsonSchema, `${id}.outputSchema`);
  if (snapped.errorSchema !== undefined && snapped.errorSchema !== null) {
    validatePortableSchema(snapped.errorSchema as JsonSchema, `${id}.errorSchema`);
  }
  const normalized = Object.freeze({
    version: 1 as const,
    id,
    inputSchema: cloneJson(snapped.inputSchema as JsonObject, `${id}.inputSchema`) as JsonSchema,
    outputSchema: cloneJson(snapped.outputSchema as JsonObject, `${id}.outputSchema`) as JsonSchema,
    ...(snapped.errorSchema === undefined
      ? {}
      : {
          errorSchema: cloneJson(snapped.errorSchema as JsonObject, `${id}.errorSchema`) as JsonSchema,
        }),
    reads: normalizeEffects(id, "reads", snapped.reads),
    changes: normalizeEffects(id, "changes", snapped.changes),
  }) as InteractionContract;
  normalizedContracts.add(normalized);
  return normalized;
}

function normalizeDocumentation(
  docs: InteractionDocumentation,
): InteractionDocumentation {
  let normalized: JsonObject;
  try {
    const value = normalizeJson(docs, "descriptor.docs");
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(
        "INVALID_DOCUMENTATION",
        "descriptor.docs",
        "interaction documentation must be an object",
      );
    }
    normalized = value as JsonObject;
  } catch (error) {
    if (error instanceof ProgramError) throw error;
    fail(
      "INVALID_DOCUMENTATION",
      "descriptor.docs",
      "interaction documentation must be portable data",
    );
  }
  const unexpected = Object.keys(normalized).find(
    (key) => key !== "summary" && key !== "description",
  );
  if (unexpected !== undefined) {
    fail(
      "INVALID_DOCUMENTATION",
      `descriptor.docs.${unexpected}`,
      `unsupported documentation field: ${unexpected}`,
    );
  }
  for (const field of ["summary", "description"] as const) {
    if (normalized[field] !== undefined && typeof normalized[field] !== "string") {
      fail(
        "INVALID_DOCUMENTATION",
        `descriptor.docs.${field}`,
        `${field} must be a string`,
      );
    }
  }
  const summary = normalized.summary;
  const description = normalized.description;
  return Object.freeze({
    ...(summary === undefined ? {} : { summary: summary as string }),
    ...(description === undefined
      ? {}
      : { description: description as string }),
  });
}

/**
 * Return the exact JSON value hashed for contract identity. Docs, annotations,
 * execution policy and realization details are deliberately absent. Both
 * `reads` and `changes` participate because callers use the complete footprint
 * for authorization, invalidation, scheduling, and evidence.
 */
function identityFromNormalized(
  contract: InteractionContract,
): InteractionContractIdentity {
  return Object.freeze({
    version: 1,
    id: contract.id,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    ...(contract.errorSchema === undefined
      ? {}
      : { errorSchema: contract.errorSchema }),
    reads: contract.reads,
    changes: contract.changes,
  });
}

export function interactionContractIdentity(
  contract: InteractionContract,
): InteractionContractIdentity {
  const normalized = normalizedContracts.has(contract)
    ? contract
    : normalizeContract(contract);
  return identityFromNormalized(normalized);
}

export async function digestInteractionContract(
  contract: InteractionContract,
  hasher: DomainHasher = hashJson,
): Promise<Sha256Digest> {
  return digest(
    hasher,
    INTERACTION_CONTRACT_DOMAIN,
    interactionContractIdentity(contract) as unknown as JsonObject,
  );
}

export async function createInteractionDescriptor(
  source: InteractionDescriptorSource,
  hasher: DomainHasher = hashJson,
): Promise<InteractionDescriptor> {
  const contract = normalizeContract(source.contract);
  const contractDigest = await digestInteractionContract(contract, hasher);
  return Object.freeze({
    version: 1,
    contract,
    contractDigest,
    docs: normalizeDocumentation(source.docs ?? {}),
    annotations: cloneJson(
      source.annotations ?? {},
      `${contract.id}.annotations`,
    ),
  });
}

async function normalizeDescriptor(
  descriptor: InteractionDescriptor,
  hasher: DomainHasher,
): Promise<InteractionDescriptor> {
  if (descriptor.version !== 1) {
    fail(
      "UNSUPPORTED_DESCRIPTOR_VERSION",
      `${descriptor.contract.id}.descriptor.version`,
      `${descriptor.contract.id} must use interaction descriptor version 1`,
    );
  }
  const normalized = await createInteractionDescriptor(
    {
      contract: descriptor.contract,
      docs: descriptor.docs,
      annotations: descriptor.annotations,
    },
    hasher,
  );
  if (normalized.contractDigest !== descriptor.contractDigest) {
    fail(
      "CONTRACT_DIGEST_MISMATCH",
      `${descriptor.contract.id}.contractDigest`,
      `${descriptor.contract.id} contract digest does not match its contract`,
    );
  }
  return normalized;
}

/** Return the exact sorted JSON array hashed for whole-program identity. */
export function programIdentity(
  interactions: readonly InteractionDescriptor[],
): JsonArray {
  return Object.freeze(
    [...interactions]
      .sort((left, right) =>
        compareUtf8(left.contract.id, right.contract.id),
      )
      .map((interaction) => interactionContractIdentity(interaction.contract)),
  );
}

export async function digestProgram(
  interactions: readonly InteractionDescriptor[],
  hasher: DomainHasher = hashJson,
): Promise<Sha256Digest> {
  return digest(hasher, PROGRAM_DOMAIN, programIdentity(interactions));
}

export async function createProgram(
  interactions: readonly InteractionDescriptor[],
  hasher: DomainHasher = hashJson,
): Promise<Program> {
  const normalized = await Promise.all(
    interactions.map((interaction) => normalizeDescriptor(interaction, hasher)),
  );
  normalized.sort((left, right) =>
    compareUtf8(left.contract.id, right.contract.id),
  );
  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index]!;
    if (normalized[index - 1]!.contract.id === current.contract.id) {
      fail(
        "DUPLICATE_INTERACTION_ID",
        `program.interactions.${current.contract.id}`,
        `duplicate interaction id: ${current.contract.id}`,
      );
    }
  }

  const frozenInteractions = Object.freeze(normalized);
  return Object.freeze({
    version: 1,
    interactions: frozenInteractions,
    programDigest: await digestProgram(frozenInteractions, hasher),
  });
}

export async function validateProgram(
  program: Program,
  hasher: DomainHasher = hashJson,
): Promise<Program> {
  if (program.version !== 1) {
    fail(
      "UNSUPPORTED_PROGRAM_VERSION",
      "program.version",
      "program must use version 1",
    );
  }
  const normalized = await createProgram(program.interactions, hasher);
  if (normalized.programDigest !== program.programDigest) {
    fail(
      "PROGRAM_DIGEST_MISMATCH",
      "program.programDigest",
      "program digest does not match its interactions",
    );
  }
  return normalized;
}

export async function composePrograms(
  programs: readonly Program[],
  hasher: DomainHasher = hashJson,
): Promise<Program> {
  await Promise.all(programs.map((program) => validateProgram(program, hasher)));
  return createProgram(
    programs.flatMap((program) => [...program.interactions]),
    hasher,
  );
}

export function diffPrograms(previous: Program, next: Program): ProgramDiff {
  const before = new Map(
    previous.interactions.map((interaction) => [
      interaction.contract.id,
      interaction.contractDigest,
    ]),
  );
  const after = new Map(
    next.interactions.map((interaction) => [
      interaction.contract.id,
      interaction.contractDigest,
    ]),
  );
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const id of ids) {
    if (!before.has(id)) added.push(id);
    else if (!after.has(id)) removed.push(id);
    else if (before.get(id) !== after.get(id)) changed.push(id);
    else unchanged.push(id);
  }

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    unchanged: Object.freeze(unchanged),
  });
}
