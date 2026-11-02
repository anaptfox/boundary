/**
 * Consumes the reviewed WIT projection vector.
 *
 * This test never writes the vector. If the projector changes the emitted
 * text, the vector is the reviewed decision and must change first. Mirrors
 * `crates/boundary-plugin/tests/wasm_projection_conformance.rs`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createInteractionDescriptor,
  createProgram,
  portableSchema,
  type Program,
} from "@foxworth/boundary/program";
import { WitProjectionError, projectWit, type WitProjectionOptions } from "../../packages/guests/plugin/index";

type VectorInteraction = {
  readonly id: string;
  readonly reads: readonly string[];
  readonly changes: readonly string[];
};

type ProjectedExpectation = {
  readonly status: "projected";
  readonly wit: string;
  readonly footprints: readonly string[];
  readonly interactions: readonly {
    readonly witName: string;
    readonly interactionId: string;
    readonly contractDigest: string;
  }[];
};

type CollisionExpectation = {
  readonly status: "collision";
  readonly witName: string;
  readonly interactionIds: readonly string[];
};

type UnspellableExpectation = {
  readonly status: "unspellable";
  readonly interactionIds: readonly string[];
};

type FootprintCollisionExpectation = {
  readonly status: "footprint-collision";
  readonly witName: string;
  readonly footprints: readonly string[];
};

type VectorCase = {
  readonly name: string;
  readonly interactions: readonly VectorInteraction[];
  readonly programDigest?: string;
  readonly expected:
    | ProjectedExpectation
    | CollisionExpectation
    | UnspellableExpectation
    | FootprintCollisionExpectation;
};

type Vector = {
  readonly version: 1;
  readonly options: WitProjectionOptions;
  readonly cases: readonly VectorCase[];
};

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../conformance/v1/wasm-projection.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as Vector;

const OBJECT_SCHEMA = portableSchema({
  type: "object",
  additionalProperties: false,
});

async function programFrom(
  interactions: readonly VectorInteraction[],
): Promise<Program> {
  const descriptors = await Promise.all(
    interactions.map((interaction) =>
      createInteractionDescriptor({
        contract: {
          version: 1,
          id: interaction.id,
          inputSchema: OBJECT_SCHEMA,
          outputSchema: OBJECT_SCHEMA,
          reads: interaction.reads,
          changes: interaction.changes,
        },
      }),
    ),
  );
  return createProgram(descriptors);
}

describe("projectWit — reviewed wasm-projection vector", () => {
  it("carries reviewed cases", () => {
    expect(vector.version).toBe(1);
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of vector.cases) {
    it(`case: ${testCase.name}`, async () => {
      const program = await programFrom(testCase.interactions);
      const expected = testCase.expected;

      if (expected.status === "projected") {
        const projection = projectWit(program, vector.options);
        expect(
          projection.wit,
          "emitted WIT must match the reviewed text byte for byte",
        ).toBe(expected.wit);
        expect(projection.footprints).toEqual(expected.footprints);
        expect(projection.programDigest).toBe(testCase.programDigest);
        expect(
          projection.interactions.map((interaction) => ({
            witName: interaction.witName,
            interactionId: interaction.interactionId,
            contractDigest: interaction.contractDigest,
          })),
        ).toEqual(expected.interactions);
        return;
      }

      let thrown: unknown;
      try {
        projectWit(program, vector.options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WitProjectionError);
      const error = thrown as WitProjectionError;

      if (expected.status === "collision") {
        expect(error.code).toBe("NAME_COLLISION");
        expect(error.witName).toBe(expected.witName);
        expect(error.interactionIds).toEqual(expected.interactionIds);
        return;
      }

      if (expected.status === "footprint-collision") {
        expect(error.code).toBe("FOOTPRINT_COLLISION");
        expect(error.witName).toBe(expected.witName);
        expect(error.footprints).toEqual(expected.footprints);
        return;
      }

      // "unspellable": the report names every failing id, not the first.
      expect(error.code).toBe("NAMES_UNSPELLABLE");
      expect(error.errors?.map((nameError) => nameError.interactionId)).toEqual(
        expected.interactionIds,
      );
    });
  }
});

describe("projectWit — laws beyond the reviewed cases", () => {
  it("does not change the emitted world when Program order is reversed", async () => {
    const forward = await programFrom([
      { id: "images.makeThumbnail", reads: ["images"], changes: ["images"] },
      { id: "images.inspect", reads: ["images"], changes: [] },
    ]);
    const reverse = await programFrom([
      { id: "images.inspect", reads: ["images"], changes: [] },
      { id: "images.makeThumbnail", reads: ["images"], changes: ["images"] },
    ]);
    expect(projectWit(forward).wit).toBe(projectWit(reverse).wit);
  });

  it("refuses a collision rather than inventing an alias", async () => {
    const program = await programFrom([
      { id: "a.bC", reads: [], changes: [] },
      { id: "a.b-c", reads: [], changes: [] },
    ]);
    expect(() => projectWit(program)).toThrow(WitProjectionError);
    try {
      projectWit(program);
      throw new Error("projectWit must refuse a collision");
    } catch (error) {
      expect(error).toBeInstanceOf(WitProjectionError);
      const collision = error as WitProjectionError;
      expect(collision.code).toBe("NAME_COLLISION");
      // The collision names the exact colliding pair; it never resolves the
      // clash by renaming one of them to something else.
      expect(collision.witName).toBe("a-b-c");
      expect(collision.interactionIds).toEqual(["a.b-c", "a.bC"]);
    }
  });
});
