import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Run the native host in a separate process; no new dependency is installed. */
export async function startExampleHost() {
  const require = createRequire(import.meta.url);
  const loader = require.resolve("tsx", { paths: [require.resolve("vite")] });
  const tokens = { a: randomUUID(), b: randomUUID() };
  const child = spawn(process.execPath, ["--import", loader, fileURLToPath(new URL("./host.ts", import.meta.url))], {
    env: { ...process.env, OBS_A_TOKEN: tokens.a, OBS_B_TOKEN: tokens.b },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${errors}`)), 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Host exited: ${errors}`)); });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("\n")) {
          clearTimeout(timer);
          try { resolve(JSON.parse(output.split("\n")[0]!).baseUrl); } catch (error) { reject(error); }
        }
      });
    });
    return {
      baseUrl, tokens,
      async close() {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        await exited;
        clearTimeout(timer);
      },
    };
  } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
}
