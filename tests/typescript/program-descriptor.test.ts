import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createInteractionDescriptor,
  createProgram,
  hashJson,
  isInteractionId,
  type InteractionDescriptorSource,
} from "../../packages/core/program/index";

const readSource: InteractionDescriptorSource = {
  contract: {
    version: 1,
    id: "workspace.inspect",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    errorSchema: { type: "object" },
    reads: ["workspace", "workspace"],
    changes: [],
  },
  docs: {
    summary: "Inspect a workspace path",
    description: "Returns the current text without changing it.",
  },
  annotations: {
    "example.resource/v1": { resource: "workspace", verb: "inspect" },
  },
};

const changeSource: InteractionDescriptorSource = {
  contract: {
    version: 1,
    id: "workspace.apply_patch",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    reads: ["workspace"],
    changes: ["workspace"],
  },
  docs: { summary: "Apply a reviewed patch" },
};

describe("Boundary Program v1 descriptors", () => {
  it("preserves the canonical domain-separated SHA-256 vector", async () => {
    expect(canonicalJson({ z: 1, a: "é" })).toBe('{"a":"é","z":1}');
    expect(
      hashJson("test-vector/v1", { z: 1, a: "é" }),
    ).toBe(
      "sha256:f7a25a391ec012c3dd01b6deea68ee8d2ade5aae3ffe6d32da2b8febac338469",
    );
    expect(
      hashJson("other-test-vector/v1", { z: 1, a: "é" }),
    ).not.toBe(
      "sha256:c94612a5298a96f78cd70ad10baa8a2e5bb779b37752d0cd32175660a49b9ff9",
    );
  });

  it("keeps docs and annotations outside contract and program identity", async () => {
    const original = createInteractionDescriptor(readSource);
    const renamed = createInteractionDescriptor({
      ...readSource,
      docs: {
        summary: "Read one workspace path",
        description: "The same contract, explained more clearly.",
      },
      annotations: {
        "example.resource/v1": { resource: "file", verb: "read" },
      },
    });

    expect(original.contract.reads).toEqual(["workspace"]);
    expect(renamed.contractDigest).toBe(original.contractDigest);
    expect((createProgram([renamed])).programDigest).toBe(
      (createProgram([original])).programDigest,
    );
  });

  it("does not require machine-synthesized documentation", async () => {
    const descriptor = createInteractionDescriptor({
      contract: readSource.contract,
    });

    expect(descriptor.docs).toEqual({});
    expect(descriptor.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it.each([
    ["input schema", { inputSchema: { type: "array", items: { type: "string" } } }],
    ["output schema", { outputSchema: { type: "boolean" } }],
    ["error schema", { errorSchema: { type: "string" } }],
    ["changes", { changes: ["workspace"] }],
  ])("changes contract identity when %s changes", async (_name, change) => {
    const original = createInteractionDescriptor(readSource);
    const changed = createInteractionDescriptor({
      ...readSource,
      contract: { ...readSource.contract, ...change },
    });

    expect(changed.contractDigest).not.toBe(original.contractDigest);
  });

  it("changes contract identity when reads change", async () => {
    const original = createInteractionDescriptor(readSource);
    const changed = createInteractionDescriptor({
      ...readSource,
      contract: { ...readSource.contract, reads: ["workspace", "clock"] },
    });

    expect(changed.contract.reads).toEqual(["clock", "workspace"]);
    expect(changed.contractDigest).not.toBe(original.contractDigest);
  });

  it("accepts stable opaque interaction ids without rewriting spelling", async () => {
    for (const id of [
      "Workspace.read_File",
      "workspace",
      "workspace~read",
      "1x.read",
      "op0_6Jx-V~9",
      "a".repeat(128),
    ]) {
      const descriptor = createInteractionDescriptor({
        ...readSource,
        contract: { ...readSource.contract, id },
      });
      expect(descriptor.contract.id).toBe(id);
    }

    for (const id of ["", ".workspace", "workspace/read", "workspace!read", "a".repeat(129)]) {
      expect(() => createInteractionDescriptor({
          ...readSource,
          contract: { ...readSource.contract, id },
        })).toThrow(expect.objectContaining({ code: "INVALID_INTERACTION_ID" }));
    }
  });

  it("publishes one interaction-id predicate for every boundary", () => {
    for (const id of [
      "Workspace.read_File",
      "workspace",
      "workspace~read",
      "1x.read",
      "op0_6Jx-V~9",
      "a".repeat(128),
    ]) {
      expect(isInteractionId(id)).toBe(true);
    }
    for (const id of [
      undefined,
      null,
      42,
      "",
      ".workspace",
      "workspace/read",
      "workspace!read",
      "a".repeat(129),
    ]) {
      expect(isInteractionId(id)).toBe(false);
    }
  });

  it("rejects malformed interaction footprints without invoking accessors", async () => {
    let getterCalls = 0;
    const accessorContract = { ...readSource.contract } as Record<string, unknown>;
    Object.defineProperty(accessorContract, "reads", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return ["secret"];
      },
    });

    const sparseReads = Array(2) as string[];
    sparseReads[0] = "workspace";
    const extraPropertyReads = ["workspace"] as string[] & { extra?: string };
    extraPropertyReads.extra = "hidden";
    const hiddenPropertyChanges = ["workspace"];
    Object.defineProperty(hiddenPropertyChanges, "secret", {
      enumerable: false,
      value: "hidden",
    });

    for (const [field, value] of [
      ["reads", undefined],
      ["reads", "db"],
      ["reads", new Set(["workspace"])],
      ["reads", sparseReads],
      ["reads", ["workspace", 1]],
      ["reads", extraPropertyReads],
      ["changes", hiddenPropertyChanges],
    ] as const) {
      expect(() => createInteractionDescriptor({
          ...readSource,
          contract: {
            ...readSource.contract,
            [field]: value,
          } as never,
        })).toThrow(expect.objectContaining({
        code: "INVALID_INTERACTION_FOOTPRINT",
        path: `workspace.inspect.contract.${field}`,
      }));
    }

    expect(() => createInteractionDescriptor({
        ...readSource,
        contract: accessorContract as never,
      })).toThrow(expect.objectContaining({
      code: "INVALID_INTERACTION_FOOTPRINT",
      path: "workspace.inspect.contract.reads",
    }));
    expect(getterCalls).toBe(0);
  });

  it("builds a handler-free JSON program in interaction-id byte order", async () => {
    const descriptors = await Promise.all(
      ["boundary.z", "boundary.Z", "boundary.a"].map((id) =>
        createInteractionDescriptor({
          ...readSource,
          contract: { ...readSource.contract, id },
        }),
      ),
    );
    const program = createProgram(descriptors);

    expect(program.interactions.map((interaction) => interaction.contract.id)).toEqual([
      "boundary.Z",
      "boundary.a",
      "boundary.z",
    ]);
    expect(program.programDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.parse(JSON.stringify(program))).toEqual(program);
    expect("byId" in program).toBe(false);
  });

  it("keeps program identity stable across docs and declaration order", async () => {
    const inspect = createInteractionDescriptor(readSource);
    const patch = createInteractionDescriptor(changeSource);
    const renamedInspect = createInteractionDescriptor({
      ...readSource,
      docs: { summary: "Inspect one path" },
    });

    const original = createProgram([patch, inspect]);
    const renamed = createProgram([renamedInspect, patch]);

    expect(renamed.programDigest).toBe(original.programDigest);
  });
});
