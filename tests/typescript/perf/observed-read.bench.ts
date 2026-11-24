// @vitest-environment node
import { expect, it } from "vitest";
import {
  bindProjection, compileInteractions, defineInteraction, directRealizationIds,
  implementInteractions, installInteractions, projectAllDirect,
} from "@foxworth/boundary";
import { observedRead, type ObservationSource } from "@foxworth/boundary/observations";
import { portableSchema, type JsonValue } from "@foxworth/boundary/program";
import { measure, recordCase } from "./measure";

type Context = { actorId: string };
type Policy = "off" | "hit" | "miss" | "changed" | "unavailable";

async function fixture(policy: Policy, size: number, points: number) {
  let revision = 0, evaluations = 0, validations = 0, authorizations = 0;
  const output = "x".repeat(size);
  const source: ObservationSource<Context, JsonValue, JsonValue, JsonValue, JsonValue> = {
    async withSnapshot(_context, _scope, run) {
      const captured = revision;
      return run({
        read: () => ({ kind: "present", value: output, token: captured }),
        query: () => ({ value: output, token: captured }),
        validate(observation) {
          validations++;
          return policy === "unavailable" ? "unavailable"
            : observation.token === captured ? "matching" : "changed";
        },
      });
    },
  };
  const definitions = { read: defineInteraction({ id: "perf.observed.read",
    input: portableSchema<string>({ type: "string" }),
    output: portableSchema<string>({ type: "string" }), reads: ["values"], changes: [] }) };
  const compiled = compileInteractions(definitions);
  const projection = projectAllDirect(compiled);
  const implementations = implementInteractions<typeof definitions, Context>(definitions, {
    read: observedRead(definitions.read, {
      snapshots: source, scope: ctx => ({ actorId: ctx.actorId }),
      authorize() { authorizations++; },
      reuse: policy === "off" ? "off" : "validated", maxEntries: 128,
      async evaluate(_input, view) {
        evaluations++;
        let result = "";
        for (let index = 0; index < points; index++) {
          const value = await view.read(`point-${index}`);
          if (value.kind !== "present" || typeof value.value !== "string") throw new Error("missing point");
          result = value.value;
        }
        return result;
      },
    }),
  });
  const { installation } = installInteractions<typeof definitions, Context>(compiled, {
    installationId: `perf:observed:${policy}:${size}:${points}`, implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
  const bound = bindProjection(projection, installation, { admit: () => ({ decision: "allow" }) });
  if (bound.status !== "bound") throw new Error("unbound observed fixture");
  const caller = bound.binding.connect();
  const context = { actorId: "benchmark" };
  let key = 0;
  const call = () => caller.call(projection.handles.read, policy === "miss" ? String(key++) : "fixed", context);
  expect(await call()).toBe(output);
  return { call, advance: () => { revision++; },
    counts: () => ({ evaluations, validations, authorizations }) };
}

it("records observed-read reuse overhead and evidence validation", async () => {
  for (const size of [1024, 65536]) for (const points of [1, 10]) {
    for (const policy of ["off", "hit", "miss", "changed", "unavailable"] as const) {
      const f = await fixture(policy, size, points);
      const warmup = 10, iters = 60;
      const before = f.counts();
      const result = await measure(f.call, { warmup, iters,
        ...(policy === "changed" ? { beforeEach: f.advance } : {}) });
      const after = f.counts();
      recordCase({ id: `ts.observed.${policy}.${size}.${points}`, lang: "ts", class: "per-call",
        ...result, extra: { payloadBytes: size, retainedObservations: points,
          diagnosticEvaluationsPerCall: (after.evaluations - before.evaluations) / (warmup + iters),
          diagnosticValidationsPerCall: (after.validations - before.validations) / (warmup + iters),
          diagnosticAuthorizationsPerCall: (after.authorizations - before.authorizations) / (warmup + iters) } });
      if (policy === "hit") expect(after.evaluations - before.evaluations).toBe(0);
      else expect(after.evaluations - before.evaluations).toBe(warmup + iters);
      expect(after.authorizations - before.authorizations).toBe(warmup + iters);
    }
  }
});
