/** Node plugin loading: inspect and resolve authority before worker preparation. */
import { inspectPlugin, type PluginLifetime } from "./host";
import { witIdentifier } from "./name";
import type { HostImports } from "./imports";
import type { PluginExecutor } from "./executor";
import { fault, type PluginHostFunction, type PluginLoadResult } from "./execution-types";
export type { GuestInstance, PluginCallOptions, PluginCallResult, PluginFault,
  PluginHostFunction, PluginHostReply, PluginLoadResult } from "./execution-types";

function resolveHost(
  host: Readonly<Record<string, PluginHostFunction>>,
  witName: string,
): PluginHostFunction | undefined {
  const claimants: string[] = [];
  let found: PluginHostFunction | undefined;
  const direct = host[witName];
  if (direct !== undefined) {
    claimants.push(witName);
    found = direct;
  }
  for (const [key, fn] of Object.entries(host)) {
    if (key === witName) continue;
    const derived = witIdentifier(key);
    if (derived.ok && derived.value === witName) {
      claimants.push(key);
      found ??= fn;
    }
  }
  if (claimants.length > 1) {
    throw new Error(
      `host map entries ${claimants
        .sort()
        .map((name) => JSON.stringify(name))
        .join(", ")} all derive the WIT name ${JSON.stringify(witName)}; the host must not provide two footprints under one name`,
    );
  }
  return found;
}


/** The executor owns compilation, worker capacity, deadlines, and cleanup. */
export async function loadPlugin(args: {
  executor: PluginExecutor;
  bytes: Uint8Array;
  imports: HostImports;
  witDigest: string;
  host: Readonly<Record<string, PluginHostFunction>>;
  lifetime?: PluginLifetime;
}): Promise<PluginLoadResult> {
  try {
    const executor = args.executor;
    executor.assertArtifactSize(args.bytes);
    // Snapshot before hashing: later caller mutation cannot change admitted bytes.
    const bytes = new Uint8Array(args.bytes);
    const suppliedHost: Readonly<Record<string, PluginHostFunction>> = Object.freeze(Object.assign(Object.create(null), args.host));
    const provided = args.imports.witNames();
    const inspection = await inspectPlugin(bytes, args.imports, args.witDigest, args.lifetime);
    if (inspection.check.status === "refused") {
      return { status: "refused", unmapped: inspection.check.unmapped,
        provided: inspection.check.provided };
    }
    const host: Record<string, PluginHostFunction> = Object.create(null);
    for (const imported of inspection.required) {
      const fn = resolveHost(suppliedHost, imported.name);
      if (typeof fn !== "function") {
        return { status: "refused", unmapped: [imported.instance === undefined
          ? imported.name : `${imported.instance}#${imported.name}`],
          provided };
      }
      host[imported.name] = fn;
    }
    const instance = await executor.bind(bytes, inspection, host);
    if ("status" in instance) return instance;
    return { status: "ready", inspection, instance };
  } catch (error) {
    return fault(error instanceof Error ? error.message : String(error));
  }
}
