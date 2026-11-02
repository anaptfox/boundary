import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Run inside the packed consumer; no build or installation is performed here. */
export function proveArtifactConsumer(consumerRoot, receiptPath) {
  const destination = path.join(consumerRoot, "artifact-proof.mjs");
  copyFileSync(
    fileURLToPath(new URL("../fixtures/runtimes/artifact-node.mjs", import.meta.url)),
    destination,
  );
  execFileSync(process.execPath, [destination, receiptPath], {
    cwd: consumerRoot,
    stdio: "inherit",
  });
}
