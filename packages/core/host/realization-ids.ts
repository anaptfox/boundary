import { metadataForCompiled } from "./compile";
import { failHost } from "./errors";
import type { CompiledInteractions, InteractionDefinitions, RealizationId, RealizationIds } from "./types";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,127}$/u;

/**
 * Derive one realization id per installed `(alias, mode)` from a host-owned
 * version label: `<interactionId>:<mode>:<version>`. The version is the host's
 * release identity for executable behaviour; nothing here reads code.
 */
export function deriveRealizationIds(
  interactionIds: Readonly<Record<string, string>>,
  version: unknown,
  requestAliases: ReadonlySet<string>,
): RealizationIds {
  if (typeof version !== "string" || !VERSION.test(version)) {
    return failHost("INVALID_REALIZATION_ID", "version",
      "expected a host-issued version token (letters, digits, . _ ~ : / -); found an invalid or missing value; fix: pass install(..., { version: \"handlers-1\" })");
  }
  const ids: Record<string, Readonly<{ direct: RealizationId; request?: RealizationId }>> = {};
  for (const [alias, interactionId] of Object.entries(interactionIds)) {
    const direct = `${interactionId}:direct:${version}`;
    const request = `${interactionId}:request:${version}`;
    if (!TOKEN.test(direct) || (requestAliases.has(alias) && !TOKEN.test(request))) {
      return failHost("INVALID_REALIZATION_ID", `realizationIds.${alias}`,
        "expected interaction id and version to form a realization id under 256 characters; found a longer value; fix: shorten the version");
    }
    ids[alias] = Object.freeze(requestAliases.has(alias) ? { direct, request } : { direct });
  }
  return Object.freeze(ids);
}

/**
 * Realization ids for a compilation from one host-owned version label:
 * `<interactionId>:direct:<version>` for every alias and
 * `<interactionId>:request:<version>` for the aliases in `request`.
 * The short path derives the same ids from install(..., { version }).
 */
export function realizationIdsFor<Definitions extends InteractionDefinitions>(
  compiled: CompiledInteractions<Definitions>,
  version: string,
  options: Readonly<{ request?: readonly (keyof Definitions & string)[] }> = {},
): RealizationIds {
  metadataForCompiled(compiled);
  const ids = Object.fromEntries(
    Object.entries(compiled.handles).map(([alias, handle]) => [alias, handle.interactionId]),
  );
  return deriveRealizationIds(ids, version, new Set(options.request ?? []));
}
