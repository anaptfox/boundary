import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const binary = require("electron") as string;
const main = fileURLToPath(new URL("./main.mjs", import.meta.url));

export function launchTodoDesktop(
  url = process.env.TODO_UI_URL ?? "http://127.0.0.1:4173/",
): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, TODO_UI_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ATOM_SHELL_INTERNAL_RUN_AS_NODE;
  return spawn(binary, [main], { env, stdio: "inherit" });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  launchTodoDesktop();
}
