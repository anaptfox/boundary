import { readFileSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_ROOT } from "./sdk.ts";

/** Exact subpath aliases from the built manifest, for process proofs against the built SDK. */
export function publishedAliases() {
  const manifest = JSON.parse(readFileSync(path.join(ARTIFACT_ROOT, "package.json"), "utf8"));
  return Object.entries(manifest.exports)
    .sort(([left], [right]) => right.length - left.length)
    .map(([subpath, target]) => ({
      find: new RegExp(`^${(manifest.name + (subpath === "." ? "" : subpath.slice(1))).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      replacement: path.join(ARTIFACT_ROOT, typeof target === "string" ? target : (target.default ?? target.node)),
    }));
}
