/**
 * The host-import admission law, checked before any guest code runs.
 *
 * 1. Synchronous profile. A component that uses component-model async (async
 *    function types, async or callback canon options, streams, futures, tasks,
 *    waitables) is refused. The Rust host disables the proposal on its engine
 *    for the same reason.
 * 2. Exact signature. Every function a guest imports from a host interface must
 *    be exactly `(request: string) -> result<string, string>`, the signature the
 *    host's import provides. A wrong parameter list or result is refused here,
 *    before transpile or instantiation, so a core start function cannot enter
 *    the host through an import whose signature was never checked.
 *
 * The signature is read from the same projection that lists required imports,
 * so it follows direct, outer-aliased, instance-aliased, instantiated and
 * ascribed shapes exactly as the imports themselves are resolved.
 *
 * The input is jco/wasm-tools' decoded WAT, never caller-authored metadata.
 * Mirrors the typed registration in `crates/boundary-plugin/src/runtime_linker.rs`
 * and the engine policy in `crates/boundary-plugin/src/limits.rs`.
 */
// Loaded by plugin workers as plain TypeScript, so relative imports carry extensions.
import { atom, forms, type Form } from "./component-wat.ts";
import { importedMembers } from "./component-projection.ts";

/** `describe()` spelling of `func (param "request" string) (result (result string (error string)))`. */
export const PROFILE_SIGNATURE = "func(param(string),result(result(string,error(string))))";

/** Canon built-ins and type constructors that exist only for component-model async. */
const ASYNC_CANON = /^(task|subtask|waitable|waitable-set|stream|future|backpressure|context|yield|thread\.yield)(\.|$)/;
const ASYNC_TYPE = new Set(["stream", "future"]);

function refuseAsync(root: Form): void {
  const pending: Form[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const head = atom(node[0]);
    const operands = node.map(atom);
    const offending =
      ((head === "func" || head === "canon") && operands.includes("async"))
      || (head === "canon" && (operands.includes("callback") || ASYNC_CANON.test(operands[1] ?? "")))
      || (head !== undefined && ASYNC_TYPE.has(head))
      // A lift or lower option list prints as nested forms: `(async)`, `(callback 0)`.
      || (head === "async" || head === "callback");
    if (offending) throw new Error("Plugin requires the synchronous Component Model profile");
    for (const value of node) if (Array.isArray(value)) pending.push(value);
  }
}

/** Throws before guest code runs when a component is outside the admitted profile. */
export function validateImportAbi(wat: string): void {
  const root = forms(wat);
  refuseAsync(root);
  for (const imported of importedMembers(root)) {
    // Imported types alone have no callable authority.
    if (imported.kind === "type") continue;
    const where = imported.instance === undefined ? imported.name : `${imported.instance}#${imported.name}`;
    // Anything else a root import can be (a module, a component, a value) is
    // not a capability shape the host provides.
    if (imported.instance === undefined && imported.kind !== "func") throw new Error(`unsupported Plugin import ${where}`);
    if (imported.signature !== PROFILE_SIGNATURE) throw new Error(`Plugin import ${where} must be string -> result<string, string>`);
  }
}
