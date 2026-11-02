import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", stdio: "inherit", timeout: 120_000,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(`BLOCKED portable-runtime proof: ${command} is not installed`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  }
}

/** Reuse the actual tarball consumer; never resolve these proofs to TS source. */
export function provePortableRuntimes(consumerRoot, workspaceRoot, includeOtherRuntimes) {
  copyFileSync(new URL("../fixtures/portable-runtime/portable-control.mjs", import.meta.url),
    path.join(consumerRoot, "portable-control.mjs"));
  run(process.execPath, ["portable-control.mjs"], consumerRoot);
  if (!includeOtherRuntimes) return;

  // Bun executes JS/TS but delegates static TS checking to the TypeScript compiler.
  run("bun", ["--version"], consumerRoot);
  run("bun", [
    path.join(workspaceRoot, "node_modules/typescript/bin/tsc"),
    "--project", "tsconfig.proof.json", "--noEmit",
  ], consumerRoot);
  for (const fixture of ["execute-reference.mjs", "portable-control.mjs"]) {
    run("bun", [fixture], consumerRoot);
  }
  console.log("portable Node/Bun packed-consumer proof passed; native framework subpaths excluded");
}
