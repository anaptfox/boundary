import { normalizeJson, type JsonValue } from "@foxworth/boundary/program";
import type { ObservationView, ObservedSnapshot, ReadObservation } from "./types";

/** Capturing views never escape their snapshot lifetime. Failed or unawaited
 * reads make the invocation ineligible for retention. */
export function captureView(snapshot: ObservedSnapshot<JsonValue, JsonValue, JsonValue, JsonValue>) {
  const observations: ReadObservation[] = [];
  const state = { active: true, failed: false, pending: 0 };
  const enter = () => {
    if (!state.active) throw new Error("observation view is closed");
    state.pending++;
  };
  const view: ObservationView<JsonValue, JsonValue, JsonValue, JsonValue> = Object.freeze({
    async read(key: JsonValue) {
      enter();
      try {
        const owned = normalizeJson(key);
        const result = await snapshot.read(owned);
        if (result.kind !== "present" && result.kind !== "absent") throw new TypeError("invalid point evidence");
        const token = normalizeJson(result.token);
        const value = result.kind === "present" ? normalizeJson(result.value) : null;
        if (!state.active) throw new Error("observation view is closed");
        observations.push(Object.freeze({ kind: "point", key: owned, present: result.kind === "present", token }));
        return result.kind === "present"
          ? Object.freeze({ kind: "present" as const, value })
          : Object.freeze({ kind: "absent" as const });
      } catch (error) {
        state.failed = true;
        throw error;
      } finally { state.pending--; }
    },
    async query(query: JsonValue) {
      enter();
      try {
        const owned = normalizeJson(query);
        const result = await snapshot.query(owned);
        const token = normalizeJson(result.token);
        const value = normalizeJson(result.value);
        if (!state.active) throw new Error("observation view is closed");
        observations.push(Object.freeze({ kind: "query", query: owned, token }));
        return value;
      } catch (error) {
        state.failed = true;
        throw error;
      } finally { state.pending--; }
    },
  });
  return { view, observations, state };
}
