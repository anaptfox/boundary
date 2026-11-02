import { compareUtf8, type JsonSchema } from "./json";
import type { InteractionContract } from "./program";
import { acceptsEvery, incompatible, type ContractCompatibility } from "./schema-compatibility";
import { validatePortableSchema } from "./validation";

export type { ContractCompatibility } from "./schema-compatibility";

/**
 * Footprints an offered contract declares that the expected one does not.
 *
 * Footprints are directional like the schemas around them: an implementation
 * that reads or changes *less* than the caller was told to expect can serve
 * that caller, because the caller already budgets for the wider set. One
 * that touches *more* cannot — it would invalidate reads the caller never
 * planned to refresh and reach state the caller never agreed to.
 */
function footprintExcess(
  expected: readonly string[],
  offered: readonly string[],
): readonly string[] {
  const allowed = new Set(expected);
  return [...new Set(offered)].filter((name) => !allowed.has(name)).sort(compareUtf8);
}

/**
 * `allowAbsentOffered` is only sound for `errorSchema`: dropping a declared
 * error contract narrows what a caller can see, which is safe. `outputSchema`
 * is not optional on `InteractionContract`; an absent offered output must not
 * take the "nothing to check" shortcut.
 */
function covariantSchema(
  expected: JsonSchema | undefined,
  offered: JsonSchema | undefined,
  path: string,
  options: Readonly<{ allowAbsentOffered: boolean }>,
): ContractCompatibility {
  if (offered === undefined) {
    return options.allowAbsentOffered
      ? { compatible: true }
      : incompatible(`${path} is missing`, path);
  }
  if (expected === undefined) {
    return incompatible("offered schema is not accepted by the expected contract", path);
  }
  return acceptsEvery(expected, offered, path, "ignore");
}

/**
 * Structural judgment on the portable schema profile.
 *
 * Inputs are contravariant, outputs and errors are covariant, and footprints
 * are covariant too: the offered contract may read and change a subset of
 * what the expected contract declares, never a superset.
 */
export function contractCompatibility(
  expected: InteractionContract,
  offered: InteractionContract,
): ContractCompatibility {
  if (expected.id !== offered.id) {
    return incompatible("interaction ids differ", "id");
  }
  const extraReads = footprintExcess(expected.reads, offered.reads);
  if (extraReads.length > 0) {
    return incompatible(`offered reads exceed the expected footprint: ${extraReads.join(", ")}`, "reads");
  }
  const extraChanges = footprintExcess(expected.changes, offered.changes);
  if (extraChanges.length > 0) {
    return incompatible(`offered changes exceed the expected footprint: ${extraChanges.join(", ")}`, "changes");
  }
  // The matcher understands exactly the portable profile. A schema outside it
  // is never judged compatible, so validate both contracts before comparing.
  for (const [side, contract] of [["expected", expected], ["offered", offered]] as const) {
    for (const field of ["inputSchema", "outputSchema", "errorSchema"] as const) {
      const schema = contract[field];
      if (schema === undefined) continue;
      try {
        validatePortableSchema(schema, `${side}.${field}`);
      } catch (error) {
        return incompatible(error instanceof Error ? error.message : String(error), `${side}.${field}`);
      }
    }
  }
  const input = acceptsEvery(offered.inputSchema, expected.inputSchema, "inputSchema", "reject");
  if (!input.compatible) return input;
  const output = covariantSchema(expected.outputSchema, offered.outputSchema, "outputSchema", {
    allowAbsentOffered: false,
  });
  if (!output.compatible) return output;
  return covariantSchema(expected.errorSchema, offered.errorSchema, "errorSchema", {
    allowAbsentOffered: true,
  });
}
