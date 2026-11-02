import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";

/** Run against installed tarball exports, never workspace source or source aliases. */
export function proveCausalEvidenceConsumer(consumerRoot) {
  const filename = "causal-evidence.mjs";
  copyFileSync(new URL("../fixtures/portable-runtime/causal-evidence.mjs", import.meta.url), path.join(consumerRoot, filename));
  const result = spawnSync(process.execPath, [filename], { cwd: consumerRoot, encoding: "utf8", stdio: "inherit", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`packed causal evidence proof failed (${result.status ?? result.signal}); blocked sockets are not a passed proof`);
}
