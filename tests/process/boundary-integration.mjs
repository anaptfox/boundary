import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Four real Node processes over the installed public SDK and one host-owned retained journal. */
export function proveBoundaryIntegration(consumerRoot) {
  const fixture = path.join(consumerRoot, "boundary-integration.mjs");
  copyFileSync(fileURLToPath(new URL("../fixtures/runtimes/boundary-integration.mjs", import.meta.url)), fixture);
  const journal = path.join(consumerRoot, "boundary-integration-journal.json");
  for (const phase of ["lost-ack", "recover", "unknown", "recover-unknown"]) {
    execFileSync(process.execPath, [fixture, phase, journal], { cwd: consumerRoot, stdio: "inherit" });
  }
}
