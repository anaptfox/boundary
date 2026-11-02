import { failHost } from "./errors";
import type { RealizationId, RealizationIds } from "./types";

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
      "expected a host-issued version token (letters, digits, . _ ~ : / -); found an invalid or missing value; fix: pass install(..., { version: \"handlers@1\" })");
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
