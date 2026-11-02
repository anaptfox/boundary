/**
 * Plugin inspection: identity and the bind-time import check.
 *
 * Execution on Node is `loadPlugin` in `execute.ts` (jco transpile).
 * This module is the shared law those hosts must apply before instantiate:
 * the binary's actual imports are a subset of the host imports, compared by
 * full instance name.
 */
import { createHash } from "node:crypto";
import { readRequiredImports } from "./component";
import { snapshotHostImports, type HostImports, type ImportCheck, type RequiredImport } from "./imports";

const REALIZATION_DOMAIN = "boundary.wasm-realization/v1";
const AUTHORITY_DOMAIN = "boundary.wasm-authority/v1";

/**
 * How long one guest instance lives. Part of a realization's identity, not a
 * tuning knob: two calls on a `per-call` guest cannot observe each other; two
 * calls on a `persistent` one can, because guest heap state survives between
 * them. A contract cannot mention that state, so opting into it declares a
 * different realization and gets a different realization id. Mirrors
 * `PluginLifetime` in `crates/boundary-plugin`.
 */
export type PluginLifetime = "per-call" | "persistent";

/**
 * The inspected artifact a host may bind as an interaction implementation.
 *
 * Inspection reads bytes and checks host-authored imports. It never executes
 * plugin code or grants authority beyond those imports.
 */
export type PluginInspection = {
  readonly required: readonly RequiredImport[];
  readonly componentDigest: `sha256:${string}`;
  readonly realizationId: `sha256:${string}`;
  readonly lifetime: PluginLifetime;
  /**
   * Digest of exactly what the host imports grant. The realization id answers
   * "which bytes ran"; this answers "what could they reach". The host imports are not
   * an input to the realization id — the same component under narrow host imports
   * and a wide one is byte-identical — so a receipt naming only the
   * realization is half a receipt. Mirrors `HostImports::authority_digest`
   * in `crates/boundary-plugin/src/imports.rs`.
   */
  readonly authorityDigest: `sha256:${string}`;
  readonly check: ImportCheck;
};

/**
 * Digests host imports: the interface it is scoped to, then every WIT name it
 * grants, sorted. The interface is included in full — package and version —
 * because bind already treats `footprints@1.0.0` and `@9.9.9` as different
 * interfaces.
 */
export function authorityDigest(imports: Pick<HostImports, "interface" | "witNames">): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(AUTHORITY_DOMAIN);
  hash.update(Buffer.from([0]));
  hash.update(imports.interface);
  for (const witName of imports.witNames()) {
    hash.update(Buffer.from([0]));
    hash.update(witName);
  }
  return `sha256:${hash.digest("hex")}`;
}

function digestOf(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function realizationId(
  componentDigest: string,
  witDigest: string,
  lifetime: PluginLifetime,
): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(REALIZATION_DOMAIN);
  hash.update(Buffer.from([0]));
  hash.update(componentDigest);
  hash.update(Buffer.from([0]));
  hash.update(witDigest);
  hash.update(Buffer.from([0]));
  hash.update(lifetime);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Inspects a plugin component against the host imports.
 *
 * Does not instantiate. Instantiation is a later host-runtime step and
 * must not run when `check.status` is `refused`.
 */
export async function inspectPlugin(
  bytesValue: Uint8Array,
  imports: HostImports,
  witDigest: string,
  lifetime: PluginLifetime = "per-call",
): Promise<PluginInspection> {
  // Artifact identity and authority describe one pre-await snapshot.
  const bytes = new Uint8Array(bytesValue);
  const capturedImports = snapshotHostImports(imports);
  const componentDigest = digestOf(bytes);
  const required = await readRequiredImports(bytes);
  return {
    required,
    componentDigest,
    realizationId: realizationId(componentDigest, witDigest, lifetime),
    lifetime,
    authorityDigest: authorityDigest(capturedImports),
    check: capturedImports.check(required),
  };
}
