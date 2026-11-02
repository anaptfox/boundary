/**
 * One way to reach a surface.
 *
 * Kinds are closed in version 1. In-process reach needs no record, because a
 * caller in the same process already holds the Binding; a record exists
 * precisely to cross a boundary.
 *
 * This is a from-scratch TypeScript port of the algorithm in
 * `crates/boundary-reach/src/record.rs`. It must sort and validate
 * byte-identically to the Rust implementation; the shared conformance vector
 * is the check, not this comment.
 */
import { compareUtf8 } from "#program/internal";

/** A Unix domain socket on this machine. Trust is the OS user. */
export type UnixTransport = {
  readonly kind: "unix";
  /** Absolute socket path. */
  readonly path: string;
  /** Base path the two protocol routes hang beneath. */
  readonly base: string;
};

/** An HTTP origin serving the framing in specification section 6. */
export type HttpTransport = {
  readonly kind: "http";
  /** Absolute base URL, with no trailing slash. The two routes hang beneath it. */
  readonly url: string;
};

export type Transport = UnixTransport | HttpTransport;

/** Why a transport address is invalid. */
export type TransportViolation = { readonly reason: string };

/**
 * Characters a transport address may carry beyond ASCII alphanumerics.
 *
 * A strict allowlist, not a denylist of what is dangerous today. A record is
 * handed between applications and is unsigned in version 1, so whoever hands
 * one over chooses the address a caller dials. Carriage return and line feed
 * would split one HTTP request into two on the wire; a space would end the
 * request line early; `?`, `#`, and `@` name url parts a Reach base has no
 * business carrying. Listing what is allowed means a character nobody
 * thought to deny cannot surprise a later sink.
 *
 * `%` stays in: a base path may be percent-encoded, and nothing here decodes
 * it, so an encoded byte reaches the server as encoded text.
 */
const ADDRESS_ALLOWED = "-._~:/%";

/** Refuses any character outside {@link ADDRESS_ALLOWED} or ASCII alphanumerics. */
function characterViolation(
  field: string,
  value: string,
): TransportViolation | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (/[A-Za-z0-9]/.test(character) || ADDRESS_ALLOWED.includes(character)) {
      continue;
    }
    return {
      reason: `${field} may not contain ${JSON.stringify(character)} at byte ${index}; an address is limited to ASCII alphanumerics and ${JSON.stringify(ADDRESS_ALLOWED)}`,
    };
  }
  return undefined;
}

/**
 * Validates one transport's address shape.
 *
 * Returns the violation rather than throwing, so a caller can decide how to
 * report it; {@link validateTransport} throws for callers who want that.
 */
export function transportViolation(
  transport: Transport,
): TransportViolation | undefined {
  if (transport.kind === "unix") {
    if (!transport.path.startsWith("/")) {
      return {
        reason: `unix socket path must be absolute, got ${JSON.stringify(transport.path)}`,
      };
    }
    const path = characterViolation("unix socket path", transport.path);
    if (path !== undefined) return path;
    return baseViolation(transport.base);
  }
  if (!transport.url.startsWith("http://") && !transport.url.startsWith("https://")) {
    return {
      reason: `http url must name a scheme, got ${JSON.stringify(transport.url)}`,
    };
  }
  if (transport.url.endsWith("/")) {
    return {
      reason: "http url must not end with a slash; the routes supply it",
    };
  }
  return characterViolation("http url", transport.url);
}

function baseViolation(base: string): TransportViolation | undefined {
  const characters = characterViolation("base path", base);
  if (characters !== undefined) return characters;
  if (!base.startsWith("/")) {
    return { reason: `base path must be absolute, got ${JSON.stringify(base)}` };
  }
  if (base === "/") {
    return { reason: "base path must not claim the application root" };
  }
  if (base.endsWith("/")) {
    return { reason: "base path must not end with a slash" };
  }
  return undefined;
}

/** A stable sort key: unix ranks 0, http ranks 1. */
function sortKey(transport: Transport): readonly [number, string, string] {
  return transport.kind === "unix"
    ? [0, transport.path, transport.base]
    : [1, transport.url, ""];
}

/**
 * A stable ordering, so a record's digest does not depend on the order a
 * host happened to list its transports.
 */
export function compareTransports(left: Transport, right: Transport): number {
  const [leftRank, leftPrimary, leftSecondary] = sortKey(left);
  const [rightRank, rightPrimary, rightSecondary] = sortKey(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const primary = compareUtf8(leftPrimary, rightPrimary);
  if (primary !== 0) return primary;
  return compareUtf8(leftSecondary, rightSecondary);
}

/** Structural equality, for collapsing adjacent duplicates once sorted. */
export function transportsEqual(left: Transport, right: Transport): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "unix"
    ? left.path === (right as UnixTransport).path &&
        left.base === (right as UnixTransport).base
    : left.url === (right as HttpTransport).url;
}

/**
 * Sorts transports by their stable key and drops adjacent duplicates, the
 * same way a Rust host does after `sort_by` + `dedup`.
 */
export function sortAndDedupeTransports(
  transports: readonly Transport[],
): readonly Transport[] {
  const sorted = [...transports].sort(compareTransports);
  const out: Transport[] = [];
  for (const transport of sorted) {
    const previous = out[out.length - 1];
    if (previous !== undefined && transportsEqual(previous, transport)) continue;
    out.push(transport);
  }
  return out;
}
