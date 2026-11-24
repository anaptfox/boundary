import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createInteractionDescriptor,
  createProgram,
  interactionContractIdentity,
  type JsonValue,
  type InteractionContract,
} from "../../packages/core/program/index";

type ContractVector = {
  name: string;
  contract: InteractionContract;
  identityCanonical: string;
  contractDigest: string;
};

type ProgramVector = {
  name: string;
  contracts: string[];
  identityCanonical: string;
  programDigest: string;
};

type Vectors = {
  version: 1;
  canonical: Array<{ name: string; value: JsonValue; canonical: string }>;
  contracts: ContractVector[];
  programs: ProgramVector[];
};

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../conformance/v1/program.json", import.meta.url)),
    "utf8",
  ),
) as Vectors;

describe("shared Rust and TypeScript Program v1 vectors", () => {
  it("agrees on canonical JSON", () => {
    expect(vectors.version).toBe(1);
    for (const vector of vectors.canonical) {
      expect(canonicalJson(vector.value), vector.name).toBe(vector.canonical);
    }
  });

  it("agrees on contract and Program identity", async () => {
    const descriptors = new Map<string, Awaited<ReturnType<typeof createInteractionDescriptor>>>();
    for (const vector of vectors.contracts) {
      const descriptor = createInteractionDescriptor({ contract: vector.contract });
      expect(
        canonicalJson(interactionContractIdentity(descriptor.contract)),
        vector.name,
      ).toBe(vector.identityCanonical);
      expect(descriptor.contractDigest, vector.name).toBe(vector.contractDigest);
      descriptors.set(vector.name, descriptor);
    }

    for (const vector of vectors.programs) {
      const program = createProgram(
        vector.contracts.map(name => {
          const descriptor = descriptors.get(name);
          if (descriptor === undefined) throw new Error(`unknown contract vector: ${name}`);
          return descriptor;
        }),
      );
      expect(
        canonicalJson(program.interactions.map(interaction =>
          interactionContractIdentity(interaction.contract)
        )),
        vector.name,
      ).toBe(vector.identityCanonical);
      expect(program.programDigest, vector.name).toBe(vector.programDigest);
    }
  });
});
