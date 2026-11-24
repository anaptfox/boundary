/**
 * The Reach record: where a Binding can be reached.
 *
 * Binding identity deliberately excludes routes and transport, so moving a
 * deployment must not change what was pinned. That leaves a gap: something
 * has to say where a surface actually is. A Reach record fills it without
 * reopening identity. It *references* a binding digest and is reissued when
 * a deployment moves; the Binding manifest never learns it exists.
 *
 * A Reach record is not authority. Holding one lets a caller find a surface
 * and fetch its manifest; the caller still binds atomically against that
 * manifest, and the host still admits every invocation. Nothing here carries
 * context, credentials, admission policy, or a grant. Handing someone a
 * Reach record is closer to giving out an address than a key.
 *
 * Records are unsigned in version 1. The signature field is reserved so
 * adding one later does not change the shape, and it is excluded from the
 * digest because a signature signs a digest and cannot be part of what it
 * signs.
 *
 * This is a from-scratch TypeScript port of the algorithm in
 * `crates/boundary-reach/src/record.rs`. It must produce byte-identical
 * digests for the same input; the shared conformance vector is the check,
 * not this comment.
 */
import {
  BoundaryErrorBase,
  hashJson,
  type JsonObject,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import {
  sortAndDedupeTransports,
  transportViolation,
  type Transport,
} from "./transport";

/** Identity domain for a Reach record. */
const REACH_DOMAIN = "boundary.reach/v1";

/** Why a Reach record is invalid. */
export type ReachDiagnosticCode =
  | "EMPTY"
  | "NO_TRANSPORTS"
  | "TRANSPORT"
  | "DIGEST_MISMATCH";

/** A required field, for {@link ReachError} with code `EMPTY`. */
export type ReachEmptyField = "bindingDigest" | "installationId";

/** A Reach record that cannot be built, or a record that failed to verify. */
export class ReachError extends BoundaryErrorBase {
  declare readonly code: ReachDiagnosticCode;
  /** The offending field. `EMPTY` only. */
  readonly field?: ReachEmptyField;
  /** What was wrong with a transport address. `TRANSPORT` only. */
  readonly reason?: string;
  /** The digest recorded on the record. `DIGEST_MISMATCH` only. */
  readonly recorded?: Sha256Digest;
  /** The digest recomputed from the record's content. `DIGEST_MISMATCH` only. */
  readonly recomputed?: Sha256Digest;

  private constructor(
    code: ReachDiagnosticCode,
    path: string,
    message: string,
    options: Readonly<{
      field?: ReachEmptyField;
      reason?: string;
      recorded?: Sha256Digest;
      recomputed?: Sha256Digest;
    }> = {},
  ) {
    super(code, path, message);
    this.name = "ReachError";
    if (options.field !== undefined) this.field = options.field;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.recorded !== undefined) this.recorded = options.recorded;
    if (options.recomputed !== undefined) this.recomputed = options.recomputed;
  }

  /** A required field was empty. */
  static empty(field: ReachEmptyField): ReachError {
    return new ReachError(
      "EMPTY",
      field,
      `reach record field ${JSON.stringify(field)} must not be empty`,
      { field },
    );
  }

  /** A record listed no way to reach anything, once sorted and deduplicated. */
  static noTransports(): ReachError {
    return new ReachError(
      "NO_TRANSPORTS",
      "transports",
      "a reach record must list at least one transport",
    );
  }

  /** A transport address was not the shape its kind requires. */
  static transport(reason: string): ReachError {
    return new ReachError(
      "TRANSPORT",
      "transports",
      `transport address is invalid: ${reason}`,
      { reason },
    );
  }

  /** A record's recorded digest does not match its recomputed content. */
  static digestMismatch(
    recorded: Sha256Digest,
    recomputed: Sha256Digest,
  ): ReachError {
    return new ReachError(
      "DIGEST_MISMATCH",
      "reachDigest",
      `reach digest mismatch: recorded ${recorded}, recomputed ${recomputed}`,
      { recorded, recomputed },
    );
  }
}

/** Where one Binding can be reached. */
export type ReachRecord = {
  readonly version: 1;
  readonly bindingDigest: string;
  readonly installationId: string;
  /** Sorted and deduplicated; see {@link sortAndDedupeTransports}. */
  readonly transports: readonly Transport[];
  /**
   * Reserved. Version 1 records are unsigned; local trust is the OS user and
   * remote trust is the transport's own. The field exists so adding a
   * signature later does not change the record shape. Absent on an unsigned
   * record rather than present and `null`.
   */
  readonly signature?: unknown;
  readonly reachDigest: Sha256Digest;
};

function transportToJson(transport: Transport): JsonObject {
  return transport.kind === "unix"
    ? { kind: transport.kind, path: transport.path, base: transport.base }
    : { kind: transport.kind, url: transport.url };
}

/**
 * Hashes the identity-bearing fields.
 *
 * The signature is excluded, because a signature signs a digest and cannot
 * be part of what it signs.
 */
function computeReachDigest(
  bindingDigest: string,
  installationId: string,
  transports: readonly Transport[],
): Sha256Digest {
  return hashJson(REACH_DOMAIN, {
    version: 1,
    bindingDigest,
    installationId,
    transports: transports.map(transportToJson),
  });
}

/**
 * Builds and validates a Reach record, computing its digest.
 *
 * Transports are sorted, so two hosts listing the same addresses in a
 * different order produce the same record.
 *
 * @throws {ReachError} when a field is empty, no transport is listed, or an
 * address is malformed.
 */
export async function createReachRecord(
  bindingDigest: string,
  installationId: string,
  transports: readonly Transport[],
): Promise<ReachRecord> {
  if (bindingDigest.trim() === "") {
    throw ReachError.empty("bindingDigest");
  }
  if (installationId.trim() === "") {
    throw ReachError.empty("installationId");
  }

  for (const transport of transports) {
    const violation = transportViolation(transport);
    if (violation !== undefined) throw ReachError.transport(violation.reason);
  }

  const sorted = sortAndDedupeTransports(transports);
  if (sorted.length === 0) {
    throw ReachError.noTransports();
  }

  const reachDigest = await computeReachDigest(
    bindingDigest,
    installationId,
    sorted,
  );

  return Object.freeze({
    version: 1,
    bindingDigest,
    installationId,
    transports: sorted,
    reachDigest,
  });
}

/**
 * Recomputes and checks the digest of a record that crossed a boundary.
 *
 * @throws {ReachError} with code `DIGEST_MISMATCH` when the record's
 * recorded digest does not match its content.
 */
export async function verifyReachRecord(record: ReachRecord): Promise<void> {
  const recomputed = await computeReachDigest(
    record.bindingDigest,
    record.installationId,
    record.transports,
  );
  if (recomputed !== record.reachDigest) {
    throw ReachError.digestMismatch(record.reachDigest, recomputed);
  }
}
