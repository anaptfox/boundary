import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one published SDK and where its build output lives. */
export const NPM_SCOPE = "@foxworth" as const;
export const SDK_NAME = "@foxworth/boundary" as const;
export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ARTIFACT_ROOT = path.join(WORKSPACE_ROOT, "dist", "boundary");

/**
 * The release candidate format lists a family of packages in publish order.
 * Boundary publishes one; release code keeps the list so the candidate format
 * and its crash recovery stay unchanged.
 */
export const RELEASE_FAMILY = Object.freeze(["boundary"] as const);
export function packageName(shortName: string): `${typeof NPM_SCOPE}/${string}` {
  return `${NPM_SCOPE}/${shortName}`;
}
export function isScopedName(name: string): boolean {
  return name.startsWith(`${NPM_SCOPE}/`);
}
