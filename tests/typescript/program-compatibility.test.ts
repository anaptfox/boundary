import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  contractCompatibility,
  type InteractionContract,
} from "@foxworth/boundary/program";

type Overlay = Partial<InteractionContract>;

type Vector = {
  version: 1;
  defaults: InteractionContract;
  cases: Array<{
    name: string;
    compatible: boolean;
    expected: Overlay;
    offered: Overlay;
  }>;
};

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../conformance/v1/contract-compatibility.json", import.meta.url)),
    "utf8",
  ),
) as Vector;

function overlay(partial: Overlay): InteractionContract {
  return { ...vectors.defaults, ...partial };
}

describe("shared contractCompatibility vectors", () => {
  it("pins version 1", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it.each(vectors.cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      const result = contractCompatibility(
        overlay(testCase.expected),
        overlay(testCase.offered),
      );
      expect(result.compatible, testCase.name).toBe(testCase.compatible);
    },
  );
});

describe("TypeScript-only matcher branches", () => {
  it.each([
    [
      "multipleOf dropped",
      { type: "number", multipleOf: 2 },
      { type: "number" },
    ],
    [
      "prefixItems dropped",
      { type: "array", prefixItems: [{ type: "string" }] },
      { type: "array" },
    ],
    [
      "minProperties dropped",
      { type: "object", minProperties: 1 },
      { type: "object" },
    ],
    [
      "maxProperties widened",
      { type: "object", maxProperties: 1 },
      { type: "object", maxProperties: 2 },
    ],
  ] as const)("rejects unprofiled keyword drift: %s", (_name, expectedOutput, offeredOutput) => {
    expect(
      contractCompatibility(
        overlay({ outputSchema: expectedOutput as InteractionContract["outputSchema"] }),
        overlay({ outputSchema: offeredOutput as InteractionContract["outputSchema"] }),
      ).compatible,
    ).toBe(false);
  });

  it("never judges a schema outside the portable profile compatible", () => {
    for (const schema of [{ type: "number", multipleOf: 2 }, { type: "object", minProperties: 1 }]) {
      const contract = overlay({ outputSchema: schema as unknown as InteractionContract["outputSchema"] });
      expect(contractCompatibility(contract, contract)).toMatchObject({ compatible: false, path: "expected.outputSchema" });
    }
  });
});

describe("tuple and record compatibility", () => {
  const output = (expected: object, offered: object) =>
    contractCompatibility(
      overlay({ outputSchema: expected as InteractionContract["outputSchema"] }),
      overlay({ outputSchema: offered as InteractionContract["outputSchema"] }),
    ).compatible;
  const input = (expected: object, offered: object) =>
    contractCompatibility(
      overlay({ inputSchema: expected as InteractionContract["inputSchema"] }),
      overlay({ inputSchema: offered as InteractionContract["inputSchema"] }),
    ).compatible;

  it("bounds positional checks by the offered arity", () => {
    const pair = { type: "array", prefixItems: [{ type: "string" }, { type: "string" }], items: false };
    // The offered output never fills position 1, so the expected item there is moot.
    expect(output(pair, { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], maxItems: 1 })).toBe(true);
    expect(output(pair, { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], maxItems: 2 })).toBe(false);
    // A closed tuple's implied maxItems satisfies an expected maxItems.
    expect(output({ type: "array", maxItems: 2 }, pair)).toBe(true);
    expect(output({ type: "array", maxItems: 1 }, pair)).toBe(false);
  });

  it("compares record value domains for inputs as well as outputs", () => {
    const strings = { type: "object", additionalProperties: { type: "string" } };
    const numbers = { type: "object", additionalProperties: { type: "number" } };
    expect(input(strings, numbers)).toBe(false);
    expect(output(strings, numbers)).toBe(false);
    expect(input(strings, { type: "object", additionalProperties: { type: "string", maxLength: 1 } })).toBe(false);
    expect(output(strings, { type: "object", additionalProperties: { type: "string", maxLength: 1 } })).toBe(true);
  });

  it("checks an optional expected property against offered additional values", () => {
    const expected = { type: "object", properties: { note: { type: "string" } } };
    expect(output(expected, { type: "object", additionalProperties: { type: "number" } })).toBe(false);
    expect(output(expected, { type: "object", additionalProperties: { type: "string" } })).toBe(true);
    // An offered key schema that excludes the name keeps it out of reach.
    expect(output(expected, { type: "object", propertyNames: { type: "string", pattern: "^x" }, additionalProperties: { type: "number" } })).toBe(true);
  });

  it("defaults an untyped offered key schema to strings", () => {
    expect(output(
      { type: "object", propertyNames: { type: "string", minLength: 1 }, additionalProperties: { type: "string" } },
      { type: "object", propertyNames: { minLength: 2 }, additionalProperties: { type: "string" } },
    )).toBe(true);
  });
});
