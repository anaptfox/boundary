/** Jco decodes binary bytes; the projection resolves only static import shapes. */
import { print } from "@bytecodealliance/jco";
import { compareUtf8 } from "#program/internal";
import type { RequiredImport } from "./imports";
import { forms } from "./component-wat";
import { importedMembers } from "./component-projection";

/** Reads every root import member, retaining names and full interface versions. */
export async function readRequiredImports(bytes: Uint8Array): Promise<RequiredImport[]> {
  // Capture before Jco initialization yields, including for direct callers.
  const root = forms(await print(new Uint8Array(bytes)));
  return importedMembers(root)
    // Types, modules and components carry no callable authority on their own.
    .filter((member) => member.instance !== undefined || member.kind === "func" || member.kind === "core-func")
    .map((member): RequiredImport => ({ instance: member.instance, name: member.name }))
    .sort((left, right) => {
      if (left.instance === undefined && right.instance !== undefined) return -1;
      if (right.instance === undefined && left.instance !== undefined) return 1;
      return compareUtf8(left.instance ?? "", right.instance ?? "") || compareUtf8(left.name, right.name);
    });
}
