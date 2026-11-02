import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  portableSchema, validateSchemaValue, type JsonSchema, type JsonValue,
} from "@foxworth/boundary/program";

const evidence = JSON.parse(readFileSync(new URL("../conformance/v1/schema-values.json", import.meta.url), "utf8")) as {
  version: number;
  cases: Array<{ name: string; schemaJson: string; valueJson: string; accepted: boolean }>;
  refusedSchemas: Array<{ name: string; schemaJson: string }>;
};

describe("reviewed portable schema value equality", () => {
  it("uses version one reviewed evidence", () => { expect(evidence.version).toBe(1); });
  for (const vector of evidence.cases) {
    it(vector.name, () => {
      const schema = portableSchema(JSON.parse(vector.schemaJson) as JsonSchema);
      const value = JSON.parse(vector.valueJson) as JsonValue;
      expect(validateSchemaValue(schema, value).length === 0).toBe(vector.accepted);
      expect(validateSchemaValue(schema, JSON.parse(JSON.stringify(value)) as JsonValue).length === 0)
        .toBe(vector.accepted);
    });
  }
  for (const vector of evidence.refusedSchemas) {
    it(vector.name, () => {
      expect(() => portableSchema(JSON.parse(vector.schemaJson) as JsonSchema)).toThrow();
    });
  }
});
