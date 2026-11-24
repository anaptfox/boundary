import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCandidate } from "../release/candidate.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) throw new Error(`${name} is required`);
  return args[index + 1];
};
const candidate = path.resolve(option("--candidate"));
const zod = option("--zod");
const root = await mkdtemp(path.join(tmpdir(), "boundary-zod-peer-"));
const sdk = await verifyCandidate(candidate);

try {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "boundary-zod-peer-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@foxworth/boundary": `file:${path.join(candidate, sdk.tarball)}`,
        zod,
      },
    }, null, 2)}\n`,
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-package-lock"], {
    cwd: root,
    stdio: "inherit",
  });
  await writeFile(
    path.join(root, "proof.mjs"),
    `import { z } from "zod";
import { compileInteractions, defineInteraction } from "@foxworth/boundary";
const ping = defineInteraction({ id: "peer.ping", output: z.strictObject({ ok: z.literal(true) }) });
const compiled = compileInteractions({ ping });
if (compiled.program.interactions[0]?.contract.id !== "peer.ping") throw new Error("Zod peer did not compile");
console.log(JSON.stringify({ zod: zodVersion(), digest: compiled.program.programDigest }));
function zodVersion() { return z.core.version; }
`,
  );
  execFileSync(process.execPath, [path.join(root, "proof.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
