import { contractCompatibility, type ContractCompatibility } from "./compatibility";
import { compareUtf8, type JsonObject, type JsonValue } from "./json";
import { interactionContractIdentity, type InteractionContract } from "./program";
import { jsonEquals } from "./snapshot";

/** How one declared element changed. */
export type ChangeKind = "added" | "removed" | "changed";

/**
 * One changed element. Paths are dotted display labels, not patch addresses:
 * property names containing dots are included literally. An absent value is
 * omitted; a declared JSON null remains null.
 */
export type ContractChange = Readonly<{
  path: string;
  kind: ChangeKind;
  before?: JsonValue;
  after?: JsonValue;
}>;

/** Declaration changes and whether a caller of before can be served by after. */
export type ContractDelta = Readonly<{
  changes: readonly ContractChange[];
  existingCallers: Readonly<ContractCompatibility>;
}>;

/**
 * Explain changes between validated, normalized contract snapshots. Arrays
 * change as whole values; changes are ordered by UTF-8 path. This native review
 * aid has no wire form or identity and makes no claim about realization behavior.
 * Compatibility remains the same directional judgment used by Binding.
 */
export function contractChanges(
  before: InteractionContract,
  after: InteractionContract,
): ContractDelta {
  const previous = interactionContractIdentity(before);
  const next = interactionContractIdentity(after);
  const changes: ContractChange[] = [];
  diff("", previous as unknown as JsonObject, next as unknown as JsonObject, changes);
  changes.sort((left, right) => compareUtf8(left.path, right.path));
  return Object.freeze({
    changes: Object.freeze(changes),
    existingCallers: Object.freeze(contractCompatibility(previous, next)),
  });
}

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function diff(
  path: string,
  before: JsonValue,
  after: JsonValue,
  out: ContractChange[],
): void {
  if (isObject(before) && isObject(after)) {
    for (const [key, oldValue] of Object.entries(before)) {
      const nestedPath = join(path, key);
      if (Object.hasOwn(after, key)) {
        diff(nestedPath, oldValue, after[key]!, out);
      } else {
        out.push(Object.freeze({ path: nestedPath, kind: "removed", before: oldValue }));
      }
    }
    for (const [key, newValue] of Object.entries(after)) {
      if (!Object.hasOwn(before, key)) {
        out.push(Object.freeze({ path: join(path, key), kind: "added", after: newValue }));
      }
    }
  } else if (!jsonEquals(before, after)) {
    out.push(Object.freeze({ path, kind: "changed", before, after }));
  }
}
