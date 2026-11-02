/**
 * Consumes the reviewed import-subset vector against the checked-in fixture
 * components. Mirrors crates/boundary-plugin/tests/wasm_import_subset.rs.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HostImports, inspectPlugin } from "../../packages/guests/plugin/index";
import { qualifiedImport } from "../../packages/guests/plugin/imports";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(
  readFileSync(resolve(root, "tests/conformance/v1/wasm-import-subset.json"), "utf8"),
) as {
  interface: string;
  fixtures: Record<string, string>;
  cases: readonly {
    name: string;
    component: string;
    interface?: string;
    provided: readonly string[];
    expected: unknown;
    required?: readonly string[];
  }[];
};

function fixtureBytes(name: string): Uint8Array {
  const relative = vector.fixtures[name];
  if (relative === undefined) {
    throw new Error(`missing fixture ${name}`);
  }
  return new Uint8Array(readFileSync(resolve(root, relative)));
}

describe("wasm import subset vector", () => {
  it("agrees with every reviewed case against the fixture binaries", async () => {
    expect(vector.cases.length).toBeGreaterThan(0);
    for (const testCase of vector.cases) {
      const imports = new HostImports(testCase.interface ?? vector.interface);
      for (const footprint of testCase.provided) {
        imports.provide(footprint);
      }
      const realized = await inspectPlugin(
        fixtureBytes(testCase.component),
        imports,
        "sha256:00",
      );
      // The authority digest travels with the check because the two answer
      // different halves of one question: which bytes ran, and what they
      // could reach.
      expect(
        { ...realized.check, authorityDigest: realized.authorityDigest },
        testCase.name,
      ).toEqual(testCase.expected);
      if (testCase.required !== undefined) {
        expect(realized.required.map(qualifiedImport).sort(), testCase.name).toEqual(testCase.required);
      }
    }
  });
});
