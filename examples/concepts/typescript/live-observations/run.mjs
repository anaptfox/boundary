import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx", { paths: [require.resolve("vite")] });
const child = spawn(process.execPath, ["--import", loader, fileURLToPath(new URL("./demo.ts", import.meta.url))], { stdio: "inherit" });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
