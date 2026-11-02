import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ClientTransport } from "@foxworth/boundary/client";
import { validateProjectionBindingManifest, type HandoffInvocation, type HandoffOutcome } from "@foxworth/boundary/handoff";

/** One owned Rust process, serial requests, bounded waits, no retry. */
export function startRustTodo() {
  const executable = process.env.BOUNDARY_CROSS_LANGUAGE_TODO_HOST
    ?? resolve("target/debug/examples/cross_language_todo");
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-8_192); });
  const lines = createInterface({ input: child.stdout });
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let failure: Error | undefined;
  function fail(error: Error) { failure = error; pending?.reject(error); pending = undefined; }
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Rust fixture exited (${code ?? signal}): ${stderr}`)));
  lines.on("line", (line) => {
    const current = pending;
    pending = undefined;
    if (!current) return fail(new Error("unsolicited fixture response"));
    try {
      const response = JSON.parse(line);
      if (response.ok !== true) throw new Error(response.error ?? "fixture rejected request");
      current.resolve(response.value);
    } catch (error) { current.reject(error instanceof Error ? error : new Error(String(error))); }
  });
  async function request(value: unknown): Promise<unknown> {
    if (failure) throw failure;
    if (pending) throw new Error("fixture requests must be serial");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error("Rust fixture response timed out; outcome unknown"));
        child.kill();
      }, 10_000);
      pending = {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      };
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => { if (error) fail(error); });
    });
  }
  let dropNext = false;
  const transport: ClientTransport = {
    inspect: async () => validateProjectionBindingManifest(await request({ kind: "inspect" })),
    async invoke(invocation: HandoffInvocation) {
      const outcome = await request({ kind: "invoke", invocation });
      if (dropNext && invocation.interactionId === "todos.create") {
        dropNext = false;
        throw new Error("fixture discarded the response after Rust finished");
      }
      // The production ProjectionClient validates this untrusted wire value
      // against the exact invocation; the fixture must not rewrite it.
      return outcome as HandoffOutcome;
    },
  };
  return {
    transport, request,
    dropNextResponse() { dropNext = true; },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      lines.close();
    },
  };
}
