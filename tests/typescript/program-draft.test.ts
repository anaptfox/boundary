/**
 * Consumes the reviewed Draft vector.
 *
 * A Draft proposes a full interaction contract that does not exist yet. These
 * tests hold it to one reviewed identity so a TypeScript host and a Rust
 * host issue drafts the other can read. Mirrors
 * `crates/boundary-core/tests/draft_conformance.rs`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProgramError } from "../../packages/core/program/program";
import {
  DraftError,
  createDraft,
  verifyDraft,
  type Draft,
  type InteractionContract,
} from "../../packages/core/program/index";

type VectorCase = {
  readonly name: string;
  readonly input: {
    readonly contract: InteractionContract;
    readonly gap: string;
    readonly proposer: string;
    readonly createdAt: string;
  };
  readonly expected: {
    readonly draftDigest: string;
  };
};

type VectorRefusal = {
  readonly name: string;
  readonly contract: InteractionContract;
  readonly gap: string;
  readonly proposer: string;
  readonly createdAt: string;
  readonly expected: {
    readonly status:
      | "empty-gap"
      | "empty-proposer"
      | "invalid-created-at"
      | "invalid-contract";
  };
};

type Vector = {
  readonly version: 1;
  readonly domain: string;
  readonly cases: readonly VectorCase[];
  readonly refusals: readonly VectorRefusal[];
};

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../conformance/v1/draft.json", import.meta.url)),
    "utf8",
  ),
) as Vector;

describe("createDraft — reviewed draft vector", () => {
  it("carries reviewed cases", () => {
    expect(vector.version).toBe(1);
    expect(vector.domain).toBe("boundary.interaction-draft/v1");
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of vector.cases) {
    it(`case: ${testCase.name}`, async () => {
      const draft = createDraft({
        contract: testCase.input.contract,
        gap: testCase.input.gap,
        proposer: testCase.input.proposer,
        createdAt: testCase.input.createdAt,
      });

      expect(draft.draftDigest, `case ${testCase.name}: digest`).toBe(
        testCase.expected.draftDigest,
      );
      expect(verifyDraft(draft)).toBeUndefined();
    });
  }

  it("gives distinct drafts distinct digests", () => {
    const digests = new Set(vector.cases.map((c) => c.expected.draftDigest));
    expect(digests.size).toBe(vector.cases.length);
  });
});

describe("createDraft — reviewed refusals", () => {
  for (const refusal of vector.refusals) {
    it(`refusal: ${refusal.name}`, async () => {
      let thrown: unknown;
      try {
        createDraft({
          contract: refusal.contract,
          gap: refusal.gap,
          proposer: refusal.proposer,
          createdAt: refusal.createdAt,
        });
      } catch (error) {
        thrown = error;
      }

      switch (refusal.expected.status) {
        case "empty-gap": {
          expect(thrown, `refusal ${refusal.name} must be refused`).toBeInstanceOf(DraftError);
          expect((thrown as DraftError).code).toBe("EMPTY_GAP");
          return;
        }
        case "empty-proposer": {
          expect(thrown, `refusal ${refusal.name} must be refused`).toBeInstanceOf(DraftError);
          expect((thrown as DraftError).code).toBe("EMPTY_PROPOSER");
          return;
        }
        case "invalid-created-at": {
          expect(thrown, `refusal ${refusal.name} must be refused`).toBeInstanceOf(DraftError);
          expect((thrown as DraftError).code).toBe("INVALID_CREATED_AT");
          return;
        }
        case "invalid-contract": {
          // An invalid contract is refused by Program's own contract
          // validation, not by Draft: it throws ProgramError, never DraftError.
          expect(thrown, `refusal ${refusal.name} must be refused`).toBeInstanceOf(ProgramError);
          expect(thrown).not.toBeInstanceOf(DraftError);
          return;
        }
        default: {
          throw new Error(`unknown reviewed refusal status ${String(refusal.expected)}`);
        }
      }
    });
  }
});

describe("createDraft — laws beyond the reviewed cases", () => {
  const contract: InteractionContract = {
    version: 1,
    id: "todos.archive",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    reads: ["todos"],
    changes: ["todos"],
  };

  it("round-trips a draft through JSON and still verifies", async () => {
    const draft = createDraft({
      contract,
      gap: "a gap",
      proposer: "agent:test",
      createdAt: "2026-09-06T12:00:00Z",
    });

    const encoded = JSON.stringify(draft);
    const decoded = JSON.parse(encoded) as Draft;
    expect(verifyDraft(decoded)).toBeUndefined();
  });

  it("fails verification when a tampered draft's content no longer matches its digest", async () => {
    const draft = createDraft({
      contract,
      gap: "a gap",
      proposer: "agent:test",
      createdAt: "2026-09-06T12:00:00Z",
    });

    const tampered: Draft = { ...draft, gap: "a different gap entirely" };

    expect(() => verifyDraft(tampered)).toThrow(expect.objectContaining({
      code: "DIGEST_MISMATCH",
    }));
  });

  it("is not a Program entry: only the expected fields are present", async () => {
    const draft = createDraft({
      contract,
      gap: "a gap",
      proposer: "agent:test",
      createdAt: "2026-09-06T12:00:00Z",
    });

    expect(Object.keys(draft).sort()).toEqual([
      "contract",
      "createdAt",
      "draftDigest",
      "gap",
      "proposer",
      "version",
    ]);
  });
});
