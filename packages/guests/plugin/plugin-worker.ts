/** One artifact per worker: termination releases generated ESM and compiled code. */
import { parentPort, workerData } from "node:worker_threads";
import { print, transpile } from "@bytecodealliance/jco";
import type { PluginCallResult } from "./execution-types.ts";
import type { RequiredImport } from "./imports.ts";
import type { PluginLifetime } from "./host.ts";
import type { WorkerCommand, WorkerEvent, WorkerSetup } from "./worker-protocol.ts";
import { validateImportAbi } from "./import-abi.ts";

const port = parentPort;
if (port === null) throw new Error("plugin runtime requires a worker");
const setup: WorkerSetup = workerData;
const send = (event: WorkerEvent) => port.postMessage(event);
type Exports = Record<string, unknown>;
type HostFunction = (request: string) => unknown;
type PreparedInstantiator = (imports: Record<string, Record<string, HostFunction>>) => Promise<Exports>;
type JcoInstantiator = (
  core: (path: string) => Promise<WebAssembly.Module>,
  imports: Record<string, Record<string, HostFunction>>,
) => Promise<Exports>;
type Binding = { required: readonly RequiredImport[]; lifetime: PluginLifetime; exports?: Exports };
const bindings = new Map<number, Binding>();
const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
const MAX_REASON_BYTES = 4 * 1024;
function bounded(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.byteLength <= MAX_REASON_BYTES
    ? text
    : `${bytes.subarray(0, MAX_REASON_BYTES).toString("utf8")}…`;
}
const failed = (reason: string): PluginCallResult =>
  ({ status: "fault", certainty: "unknown", reason: bounded(reason) });
const message = (error: unknown) => bounded(error instanceof Error ? error.message : String(error));

/**
 * Host-call copy budget for the current startup or call: UTF-8 bytes of every
 * request and delivered reply, compared with `hostcallCopyBytes` (equality is
 * allowed). Reset before instantiation and before each call. Jobs are
 * serialized, so one counter serves every binding in this worker.
 */
let hostcallBytes = 0;
function chargeHostcall(bytes: number, what: string): void {
  const total = hostcallBytes + bytes;
  if (total > setup.hostcallCopyBytes) {
    throw new Error(`host import ${what} would pass the ${setup.hostcallCopyBytes}-byte copy budget`);
  }
  hostcallBytes = total;
}

function hostFunction(job: number, binding: number, name: string): HostFunction {
  return (request) => {
    if (typeof request !== "string" || Buffer.byteLength(request) > setup.maxPayloadBytes) {
      throw new Error("host import request exceeds the payload limit");
    }
    // Counted before the host can run: a refused request never reaches it.
    chargeHostcall(Buffer.byteLength(request), "request");
    const shared = new SharedArrayBuffer(8 + setup.maxPayloadBytes);
    const header = new Int32Array(shared, 0, 2);
    send({ type: "host", job, binding, name, request, shared });
    // Only the worker waits. The parent may await an asynchronous host capability.
    Atomics.wait(header, 0, 0);
    const length = Atomics.load(header, 1);
    const text = new TextDecoder().decode(new Uint8Array(shared, 8, length));
    if (Atomics.load(header, 0) !== 1) throw new Error(text);
    const reply: unknown = JSON.parse(text);
    if (typeof reply === "object" && reply !== null && "tag" in reply && reply.tag === "unknown"
      && "val" in reply && typeof reply.val === "string") {
      throw new Error(`host import could not confirm its effect: ${reply.val}`);
    }
    // Counted before the guest can see it; a withheld reply follows a host
    // effect that may have happened, so the fault stays `unknown`.
    const delivered = typeof reply === "string" ? reply
      : typeof reply === "object" && reply !== null && "val" in reply && typeof reply.val === "string"
        ? reply.val : undefined;
    if (delivered !== undefined) chargeHostcall(Buffer.byteLength(delivered), "reply");
    return reply;
  };
}

async function prepare(): Promise<PreparedInstantiator> {
  const started = performance.now();
  // Exact import signatures are decided before any guest code can run.
  validateImportAbi(await print(setup.bytes));
  const { files } = await transpile(setup.bytes, {
    name: "guest", instantiation: "async", wasiShim: false, noTypescript: true,
    // Keep core modules as emitted files so they compile once in this worker.
    // Inline base64 modules would compile again for each instantiation.
    base64Cutoff: 0,
  });
  // Do not retain the component bytes after preparation.
  setup.bytes = new Uint8Array();
  const size = Object.values(files).reduce((sum, file) => sum + file.byteLength, 0);
  if (size > setup.maxPreparedBytes) throw new Error("prepared artifact exceeds the byte limit");
  const js = Object.keys(files).filter((name) => name.endsWith(".js"));
  if (js.length !== 1) throw new Error("expected one self-contained jco JavaScript entry");
  const source = files[js[0]!]!;
  // No filesystem artifact and no parent-process ESM cache retention.
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const compileStart = performance.now();
  const modules = new Map<string, WebAssembly.Module>();
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith(".wasm")) {
      // jco's type permits a SharedArrayBuffer-backed view; WebAssembly's
      // Node declaration deliberately does not. Make one owned preparation
      // copy, then retain the compiled module across all instantiations.
      const core = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      core.set(bytes);
      modules.set(path, await WebAssembly.compile(core));
    }
  }
  // `prepareMs` includes transpilation, loading generated ESM, and core-module
  // compilation. `compileMs` isolates only the core compilation interval.
  const preparedAt = performance.now();
  const instantiate: JcoInstantiator = loaded.instantiate;
  if (typeof instantiate !== "function") throw new Error("jco entry has no instantiator");
  send({ type: "prepared", bytes: size, modules: modules.size,
    prepareMs: preparedAt - started, compileMs: preparedAt - compileStart });
  return (imports) => instantiate(async (path) => {
    const module = modules.get(path);
    if (module === undefined) throw new Error(`missing compiled core module ${path}`);
    return module;
  }, imports);
}

function importsFor(binding: Binding, id: number, job: () => number) {
  const imports: Record<string, Record<string, HostFunction>> = Object.create(null);
  for (const required of binding.required) {
    if (required.instance === undefined) throw new Error("bare imports are not supported");
    const functions = imports[required.instance] ??= Object.create(null);
    const fn: HostFunction = (request) => hostFunction(job(), id, required.name)(request);
    functions[required.name] = fn;
    functions[camel(required.name)] = fn;
    const at = required.instance.lastIndexOf("@");
    if (at > 0) imports[required.instance.slice(0, at)] = functions;
  }
  return imports;
}

function invoke(exports: Exports, name: string, input: string): PluginCallResult {
  const fn = exports[name] ?? exports[camel(name)];
  if (typeof fn !== "function") return failed(`guest does not export ${name}`);
  try {
    const payload: unknown = fn(input);
    if (typeof payload !== "string") return failed("guest returned a non-string payload");
    if (Buffer.byteLength(payload) > setup.maxPayloadBytes) return failed("plugin output exceeds the payload limit");
    return { status: "returned", payload };
  } catch (error) {
    const payload = typeof error === "string" ? error
      : error instanceof Error && error.constructor.name === "ComponentError" ? error.message : undefined;
    if (payload !== undefined && Buffer.byteLength(payload) <= setup.maxPayloadBytes) {
      return { status: "declared-error", payload };
    }
    return failed(message(error));
  }
}

try {
  const instantiate = await prepare();
  let activeJob = 0;
  let tail = Promise.resolve();
  port.on("message", (command: WorkerCommand) => {
    // Parent dispatch is serialized too. Keep the worker defensive against overlap.
    tail = tail.then(async () => {
      if (command.type === "close") { bindings.delete(command.binding); return; }
      activeJob = command.job;
      let instantiateMs = 0;
      let invokeMs = 0;
      try {
        if (command.type === "bind") {
          bindings.set(command.binding, { required: command.required, lifetime: command.lifetime });
        }
        const binding = bindings.get(command.binding);
        if (binding === undefined) throw new Error("plugin binding is closed");
        if (binding.exports === undefined) {
          const start = performance.now();
          hostcallBytes = 0;
          // Capability closures read the current job, never a prior invocation's authority.
          const imports = importsFor(binding, command.binding, () => activeJob);
          binding.exports = await instantiate(imports);
          instantiateMs = performance.now() - start;
        }
        let outcome: PluginCallResult = { status: "returned", payload: "" };
        if (command.type === "call") {
          hostcallBytes = 0;
          const start = performance.now();
          outcome = invoke(binding.exports, command.name, command.input);
          invokeMs = performance.now() - start;
          if (binding.lifetime === "per-call" || outcome.status === "fault") binding.exports = undefined;
        }
        send({ type: "result", job: command.job, outcome, instantiateMs, invokeMs });
      } catch (error) {
        const binding = bindings.get(command.binding);
        if (binding !== undefined) binding.exports = undefined;
        if (command.type === "bind") bindings.delete(command.binding);
        // Initializers can invoke capabilities. Never call this not-started.
        send({ type: "result", job: command.job, outcome: failed(message(error)), instantiateMs, invokeMs });
      }
    });
  });
} catch (error) {
  send({ type: "prepare-failed", reason: message(error) });
  port.close();
}
