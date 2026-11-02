import {
  canonicalJson, cloneJson, normalizeJson, validateSchemaValue,
  type InteractionContract, type JsonValue,
} from "@foxworth/boundary/program";
import { captureView } from "./view";
import type { ObservedReadDiagnostic, ObservedReadOptions, ReadObservation } from "./types";
import type { AnyInteractionDefinition } from "../types";

type Options = ObservedReadOptions<AnyInteractionDefinition, unknown, JsonValue, JsonValue, JsonValue, JsonValue>;
type Entry = Readonly<{ output: JsonValue; observations: readonly ReadObservation[] }>;

export function createObservedExecutor(
  options: Options,
  contract: InteractionContract,
  pins: Readonly<{ installationId: string; realizationId: string }>,
) {
  const entries = new Map<string, Entry>();
  const reuse = options.reuse === "validated" && options.maxEntries! > 0;
  let revoked = false;
  const report = async (diagnostic: ObservedReadDiagnostic) => {
    try { await options.diagnostic?.(Object.freeze(diagnostic)); } catch { /* diagnostics own no truth */ }
  };
  const execute = async (input: JsonValue, context: unknown): Promise<unknown> => {
    await options.authorize(input, context);
    const scope = normalizeJson(options.scope(context));
    const key = canonicalJson(normalizeJson({ input, scope, ...pins }));
    let diagnostic: ObservedReadDiagnostic | undefined;
    let invoked = false;
    let invocations = 0;
    let ended = false;
    let completed = false;
    let callbackOutput: JsonValue | undefined;
    let activeCapture: ReturnType<typeof captureView> | undefined;
    let candidate: Entry | undefined;
    let output: unknown;
    try { output = await options.snapshots.withSnapshot(context, scope, snapshot => {
      invocations++;
      const computation = (async () => {
      if (invoked || ended) throw new Error("snapshot source must invoke its callback exactly once before settling");
      invoked = true;
      if (revoked) throw new Error("observed read installation is revoked");
      let validations = 0;
      let reason: ObservedReadDiagnostic["reason"] = reuse ? "miss" : "reuse-off";
      const retained = reuse ? entries.get(key) : undefined;
      if (retained) {
        reason = "matching";
        for (const observation of retained.observations) {
          validations++;
          let validation: unknown;
          try { validation = await snapshot.validate(observation); } catch { validation = "unavailable"; }
          if (validation !== "matching") {
            reason = validation === "changed" ? "changed" : "unavailable";
            break;
          }
        }
        if (reason === "matching") {
          diagnostic = { reused: true, validations, observations: retained.observations.length, reason };
          if (ended) throw new Error("snapshot source settled before evaluation completed");
          completed = true;
          callbackOutput = retained.output;
          return cloneJson(retained.output);
        }
        entries.delete(key);
      }
      if (ended) throw new Error("snapshot source settled before evaluation completed");
      const captured = captureView(snapshot);
      activeCapture = captured;
      let result: JsonValue;
      try {
        result = normalizeJson(await options.evaluate(input, captured.view, context));
        if (validateSchemaValue(contract.outputSchema, result).length > 0) {
          throw new TypeError("observed read returned invalid output");
        }
        if (!revoked && reuse &&
          !captured.state.failed && captured.state.pending === 0) {
          candidate = Object.freeze({ output: result, observations: Object.freeze([...captured.observations]) });
        }
      } finally { captured.state.active = false; }
      diagnostic = { reused: false, validations, observations: captured.observations.length, reason };
      completed = true;
      callbackOutput = result;
      return cloneJson(result);
      })();
      // Invalid sources may abandon this promise; containment still rejects the
      // invocation and closes the view without an unhandled late rejection.
      void computation.catch(() => {});
      return computation;
    }); } finally { ended = true; if (activeCapture) activeCapture.state.active = false; }
    if (!invoked) throw new Error("snapshot source did not invoke its callback");
    if (invocations !== 1) throw new Error("snapshot source must invoke its callback exactly once");
    if (!completed) throw new Error("snapshot source did not await successful evaluation");
    if (canonicalJson(normalizeJson(output)) !== canonicalJson(callbackOutput!)) throw new Error("snapshot source changed its callback result");
    if (candidate && !revoked) {
      if (!entries.has(key) && entries.size >= options.maxEntries!) entries.delete(entries.keys().next().value!);
      entries.set(key, candidate);
    }
    if (diagnostic) await report(diagnostic);
    return output;
  };
  return { execute, clear() { revoked = true; entries.clear(); } };
}
