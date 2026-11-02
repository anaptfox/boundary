/**
 * Consumes the reviewed Reach record vector.
 *
 * A Reach record is the answer to "where is this Binding", asked without
 * reopening what the Binding pinned. These tests hold the record to one
 * reviewed identity so a TypeScript host and a Rust host issue records the
 * other can read. Mirrors `crates/boundary-reach/tests/reach_conformance.rs`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ReachError,
  createReachRecord,
  verifyReachRecord,
  type ReachRecord,
  type Transport,
} from "../../packages/discovery/reach/index";

type VectorCase = {
  readonly name: string;
  readonly input: {
    readonly bindingDigest: string;
    readonly installationId: string;
    readonly transports: readonly Transport[];
  };
  readonly expected: {
    readonly reachDigest: string;
    readonly transports: readonly Transport[];
  };
};

type VectorRefusal = {
  readonly name: string;
  readonly bindingDigest: string;
  readonly installationId: string;
  readonly transports: readonly Transport[];
  readonly expected:
    | { readonly status: "empty"; readonly field: "bindingDigest" | "installationId" }
    | { readonly status: "no-transports" }
    | { readonly status: "transport" };
};

type Vector = {
  readonly version: 1;
  readonly domain: string;
  readonly cases: readonly VectorCase[];
  readonly refusals: readonly VectorRefusal[];
};

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../conformance/v1/reach.json", import.meta.url)),
    "utf8",
  ),
) as Vector;

describe("createReachRecord — reviewed reach vector", () => {
  it("carries reviewed cases", () => {
    expect(vector.version).toBe(1);
    expect(vector.domain).toBe("boundary.reach/v1");
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of vector.cases) {
    it(`case: ${testCase.name}`, async () => {
      const record = await createReachRecord(
        testCase.input.bindingDigest,
        testCase.input.installationId,
        testCase.input.transports,
      );

      expect(record.reachDigest, `case ${testCase.name}: digest`).toBe(
        testCase.expected.reachDigest,
      );
      expect(record.transports, `case ${testCase.name}: sorted transports`).toEqual(
        testCase.expected.transports,
      );
      await expect(verifyReachRecord(record)).resolves.toBeUndefined();
    });
  }

  it("does not change the digest when listing order changes", () => {
    const httpFirst = vector.cases.find((c) => c.name === "both-listed-http-first");
    const unixFirst = vector.cases.find((c) => c.name === "both-listed-unix-first");
    expect(httpFirst).toBeDefined();
    expect(unixFirst).toBeDefined();
    expect(httpFirst?.expected.reachDigest).toBe(unixFirst?.expected.reachDigest);
  });

  it("gives distinct places distinct digests", () => {
    const digests = new Set(vector.cases.map((c) => c.expected.reachDigest));
    // Four cases, three distinct places: the two orderings collapse.
    expect(digests.size).toBe(3);
  });
});

describe("createReachRecord — reviewed refusals", () => {
  for (const refusal of vector.refusals) {
    it(`refusal: ${refusal.name}`, async () => {
      let thrown: unknown;
      try {
        await createReachRecord(
          refusal.bindingDigest,
          refusal.installationId,
          refusal.transports,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `refusal ${refusal.name} must be refused`).toBeInstanceOf(
        ReachError,
      );
      const error = thrown as ReachError;

      switch (refusal.expected.status) {
        case "empty": {
          expect(error.code).toBe("EMPTY");
          expect(error.field).toBe(refusal.expected.field);
          return;
        }
        case "no-transports": {
          expect(error.code).toBe("NO_TRANSPORTS");
          return;
        }
        case "transport": {
          expect(error.code).toBe("TRANSPORT");
          return;
        }
        default: {
          throw new Error(`unknown reviewed refusal status ${String(refusal.expected)}`);
        }
      }
    });
  }
});

describe("createReachRecord — laws beyond the reviewed cases", () => {
  it("round-trips a record through JSON and still verifies", async () => {
    const record = await createReachRecord(
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "deploy:example:1",
      [{ kind: "http", url: "https://host.invalid/boundary/v1" }],
    );

    const encoded = JSON.stringify(record);
    const raw: Record<string, unknown> = JSON.parse(encoded);
    // Version 1 records are unsigned, so the reserved field is absent from
    // the wire rather than present and null.
    expect("signature" in raw).toBe(false);

    const decoded = JSON.parse(encoded) as ReachRecord;
    await expect(verifyReachRecord(decoded)).resolves.toBeUndefined();
  });

  it("fails verification when a tampered record's content no longer matches its digest", async () => {
    const record = await createReachRecord(
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "deploy:example:1",
      [{ kind: "http", url: "https://host.invalid/boundary/v1" }],
    );

    const tampered: ReachRecord = {
      ...record,
      transports: [{ kind: "http", url: "https://attacker.invalid/boundary/v1" }],
    };

    await expect(verifyReachRecord(tampered)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });
  });

  it("carries no authority: only the expected fields are present", async () => {
    const record = await createReachRecord(
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "deploy:example:1",
      [{ kind: "unix", path: "/tmp/boundary.sock", base: "/boundary/v1" }],
    );

    expect(Object.keys(record).sort()).toEqual([
      "bindingDigest",
      "installationId",
      "reachDigest",
      "transports",
      "version",
    ]);
  });
});
