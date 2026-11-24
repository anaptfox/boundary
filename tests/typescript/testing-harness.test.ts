import { describe, expect, it } from "vitest";
import { generateInvalidSamples, generateValidSamples, verifyObservedReadEquivalence, verifyControlCrashRecovery, TestClock, MemoryJournal } from "../../packages/core/testing/index";
import type { JsonSchema, JsonValue } from "@foxworth/boundary/program";
import { compileInteractions, defineInteraction, directRealizationIds, implementInteractions, installInteractions } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
import { verifyDirectHandlers } from "../../packages/core/testing/handler-verifier";

describe("testing harness primitives", () => {
  it("generates deterministic schema samples", () => {
    const schema = { type: "object", properties: { name: { type: "string", minLength: 2 } }, required: ["name"], additionalProperties: false } as unknown as JsonSchema;
    expect(generateValidSamples(schema)).toContainEqual({ name: "xx" });
    expect(generateInvalidSamples(schema)).toContainEqual({ name: "", __unexpected: true });
  });
  it("detects a stale cached observed read", async () => {
    let value: JsonValue = 1;
    const report = await verifyObservedReadEquivalence({
      steps: [{ kind: "read", context: null }, { kind: "mutate", context: null }, { kind: "read", context: null }],
      runCached: async () => 1,
      runFresh: async () => value,
      mutate: async () => { value = 2; },
    });
    expect(report).toMatchObject({ ok: false, readsChecked: 2 });
  });
  it("accepts sound direct handlers and flags invalid outputs", async () => {
    const defs = { echo: defineInteraction({ id: "testing.echo", input: portableSchema<JsonValue>({ type: "number" }), output: portableSchema<JsonValue>({ type: "number" }), reads: [], changes: [] }) };
    const compiled = compileInteractions(defs);
    const makeInstallation = (implementation: (input: JsonValue) => JsonValue) => installInteractions(compiled, {
      installationId: "testing-harness", implementations: implementInteractions(defs, { echo: implementation }),
      realizationIds: directRealizationIds(compiled, "v1"),
    }).installation;
    const sound = await verifyDirectHandlers({ compiled, installation: makeInstallation((input) => input) });
    const broken = await verifyDirectHandlers({ compiled, installation: makeInstallation(() => "bad" as JsonValue) });
    expect(sound.ok).toBe(true);
    expect(broken.ok).toBe(false);
    expect(broken.failures.some((failure) => failure.phase === "valid")).toBe(true);
  });
  it("reports deterministic crash recovery cases", async () => {
    const report = await verifyControlCrashRecovery({ journal: new MemoryJournal(), clock: new TestClock(), run: async (_point, crash) => {
      try { crash(); } catch { /* deterministic injected process boundary */ }
      return { reconcile: async () => undefined, sideEffects: () => 1, terminal: async () => true };
    } });
    expect(report.cases.map((x) => x.point)).toEqual(["after-attempt", "after-apply", "after-verify"]);
    expect(report.ok).toBe(true);
  });
});
