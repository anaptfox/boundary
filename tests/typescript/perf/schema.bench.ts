import { describe, it } from "vitest";
import { canonicalJson, normalizeJson, portableSchema, validateSchemaValue, type JsonSchema } from "../../../packages/core/program/index";
import { measureSync, recordCase } from "./measure";

// Cold includes snapshot/validation/compilation. Warm reuses an owned schema.
// These are local workload timings, not a cross-language performance claim.
const source: JsonSchema = {
  type: "object", required: ["items"], additionalProperties: false,
  properties: {
    items: { type: "array", items: { anyOf: [
      { type: "string", pattern: "^[a-z]+$" },
      { type: "object", required: ["n"], additionalProperties: false,
        properties: { n: { type: "integer", minimum: 0 } } },
    ] } },
  },
};
const value = { items: ["abc", { n: 2 }, "def", { n: 3 }] };

describe("portable schema cold and warm workload", () => {
  it("records unconstrained strings and unique array scaling", async () => {
    const raw = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, { index, label: "value" }]));
    const owned = normalizeJson(raw);
    for (const [kind, input] of [["raw", raw], ["owned", owned]] as const) {
      recordCase({ id: `ts.canonical.${kind}.100`, lang: "ts", class: "per-call",
        ...measureSync(() => canonicalJson(input), { warmup: 50, iters: 400, batchSize: 32 }) });
    }
    const text = portableSchema({ type: "string" });
    for (const size of [1024, 1048576]) {
      const input = "a".repeat(size);
      recordCase({ id: `ts.schema.string.${size}`, lang: "ts", class: "per-call",
        ...measureSync(() => validateSchemaValue(text, input), { warmup: 20, iters: 100, batchSize: 32 }) });
    }
    const unique = portableSchema({ type: "array", uniqueItems: true });
    for (const size of [100, 1000, 5000]) {
      const input = Array.from({ length: size }, (_, index) => index);
      recordCase({ id: `ts.schema.unique.${size}`, lang: "ts", class: "per-call",
        ...measureSync(() => validateSchemaValue(unique, input), { warmup: 3, iters: 12 }) });
    }
  });
  it("records first-use and repeated-use costs independently", async () => {
    const owned = portableSchema(source);
    validateSchemaValue(owned, value);
    for (const [id, fn] of [
      ["schema-cold", () => validateSchemaValue(portableSchema(source), value)],
      ["schema-warm", () => validateSchemaValue(owned, value)],
    ] as const) {
      recordCase({ id, lang: "ts", class: id === "schema-cold" ? "startup" : "per-call",
        ...measureSync(fn, { warmup: 100, iters: 2000, batchSize: id === "schema-warm" ? 32 : 1 }) });
    }
  });
});
