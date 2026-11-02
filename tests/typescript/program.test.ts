import { describe, expect, it } from "vitest";
import {
  INTERACTION_CONTRACT_DOMAIN,
  PROGRAM_DOMAIN,
  composePrograms,
  createCatalog,
  createInteractionDescriptor,
  createProgram,
  diffPrograms,
  hashJson,
  validateCatalog,
  type DomainHasher,
  type JsonValue,
  type InteractionContract,
  type InteractionDescriptorSource,
} from "../../packages/core/program/index";

const baseContract: InteractionContract = {
  version: 1,
  id: "todos.list",
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { items: { type: "array" } },
  },
  errorSchema: { type: "object" },
  reads: ["todos"],
  changes: [],
};

function source(
  contract: InteractionContract,
  summary?: string,
): InteractionDescriptorSource {
  return {
    contract,
    ...(summary === undefined ? {} : { docs: { summary } }),
    annotations: { surface: "collection" },
  };
}

describe("program v1 identity", () => {
  it("hashes exactly the declared contract fields in the v1 domain", async () => {
    const calls: { domain: string; value: JsonValue }[] = [];
    const recordingHasher: DomainHasher = async (domain, value) => {
      calls.push({ domain, value });
      return hashJson(domain, value);
    };

    const descriptor = await createInteractionDescriptor(
      source(baseContract, "List todos"),
      recordingHasher,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      domain: INTERACTION_CONTRACT_DOMAIN,
      value: {
        version: 1,
        id: "todos.list",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { items: { type: "array" } },
        },
        errorSchema: { type: "object" },
        reads: ["todos"],
        changes: [],
      },
    });
    expect(calls[0]!.value).not.toHaveProperty("docs");
    expect(calls[0]!.value).not.toHaveProperty("annotations");
    expect(descriptor.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("hashes the sorted interaction contracts for program identity", async () => {
    const list = await createInteractionDescriptor(source(baseContract));
    const create = await createInteractionDescriptor(
      source({
        ...baseContract,
        id: "todos.create",
        reads: [],
        changes: ["todos"],
      }),
    );
    const calls: { domain: string; value: JsonValue }[] = [];
    const recordingHasher: DomainHasher = async (domain, value) => {
      calls.push({ domain, value });
      return hashJson(domain, value);
    };

    const program = await createProgram([list, create], recordingHasher);
    const programCall = calls.at(-1)!;

    expect(programCall.domain).toBe(PROGRAM_DOMAIN);
    expect(programCall.value).toEqual([
      {
        version: 1,
        id: "todos.create",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { items: { type: "array" } },
        },
        errorSchema: { type: "object" },
        reads: [],
        changes: ["todos"],
      },
      {
        version: 1,
        id: "todos.list",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { items: { type: "array" } },
        },
        errorSchema: { type: "object" },
        reads: ["todos"],
        changes: [],
      },
    ]);
    expect(programCall.value).not.toHaveProperty("version");
    expect(program.programDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("preserves host-authored interaction ids and includes reads in identity", async () => {
    const original = await createInteractionDescriptor(source(baseContract));
    const differentReads = await createInteractionDescriptor(
      source({ ...baseContract, reads: ["audit", "todos"] }),
    );

    expect(original.contract.id).toBe("todos.list");
    expect(original.contract.id).not.toMatch(/^boundary[.:/]/u);
    expect(differentReads.contractDigest).not.toBe(original.contractDigest);
    expect(
      (await createProgram([differentReads])).programDigest,
    ).not.toBe((await createProgram([original])).programDigest);
  });

  it("keeps descriptor documentation exact portable data", async () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "summary", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      },
    });

    await expect(
      createInteractionDescriptor({
        contract: baseContract,
        docs: accessor as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENTATION" });
    expect(getterCalls).toBe(0);
    await expect(
      createInteractionDescriptor({
        contract: baseContract,
        docs: { summary: (() => "unsafe") as never },
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENTATION" });
    await expect(
      createInteractionDescriptor({
        contract: baseContract,
        docs: { summary: "Todos", extra: true } as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENTATION" });
  });
});

describe("program composition and diff", () => {
  it("composes disjoint programs and rejects ambiguous duplicate interaction ids", async () => {
    const todos = await createInteractionDescriptor(source(baseContract));
    const notes = await createInteractionDescriptor(
      source({ ...baseContract, id: "notes.list", reads: ["notes"] }),
    );
    const todoProgram = await createProgram([todos]);
    const noteProgram = await createProgram([notes]);

    const composed = await composePrograms([noteProgram, todoProgram]);
    expect(composed.interactions.map((interaction) => interaction.contract.id)).toEqual([
      "notes.list",
      "todos.list",
    ]);
    await expect(composePrograms([todoProgram, todoProgram])).rejects.toMatchObject({
      code: "DUPLICATE_INTERACTION_ID",
    });
  });

  it("diffs semantic contract identity while ignoring descriptor-only changes", async () => {
    const list = await createInteractionDescriptor(source(baseContract, "List todos"));
    const renamed = await createInteractionDescriptor(
      source(baseContract, "Read the todo collection"),
    );
    const changed = await createInteractionDescriptor(
      source({ ...baseContract, changes: ["todos"] }),
    );
    const removed = await createInteractionDescriptor(
      source({ ...baseContract, id: "todos.remove", changes: ["todos"] }),
    );
    const added = await createInteractionDescriptor(
      source({ ...baseContract, id: "todos.create", changes: ["todos"] }),
    );

    expect(
      diffPrograms(
        await createProgram([list, removed]),
        await createProgram([renamed, added]),
      ),
    ).toEqual({
      added: ["todos.create"],
      removed: ["todos.remove"],
      changed: [],
      unchanged: ["todos.list"],
    });
    expect(
      diffPrograms(await createProgram([list]), await createProgram([changed])),
    ).toMatchObject({ changed: ["todos.list"] });
  });
});

describe("deployment catalog", () => {
  it("pins exact direct and request realizations without changing Program identity", async () => {
    const list = await createInteractionDescriptor(source(baseContract));
    const publish = await createInteractionDescriptor(
      source({
        ...baseContract,
        id: "todos.publish",
        changes: ["todos"],
      }),
    );
    const program = await createProgram([publish, list]);
    const previewSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    } as const;
    const catalog = createCatalog(program, [
      {
        interactionId: "todos.publish",
        request: {
          realizationId: "realization:todos.publish:request:1",
          controlDigest: publish.contractDigest,
          previewSchema,
        },
      },
      {
        interactionId: "todos.list",
        direct: { realizationId: "realization:todos.list:direct:1" },
      },
    ]);

    expect(catalog).toEqual({
      version: 1,
      programDigest: program.programDigest,
      interactions: [
        {
          interactionId: "todos.list",
          direct: { realizationId: "realization:todos.list:direct:1" },
        },
        {
          interactionId: "todos.publish",
          request: {
            realizationId: "realization:todos.publish:request:1",
            controlDigest: publish.contractDigest,
            previewSchema,
          },
        },
      ],
    });
    expect(catalog).not.toHaveProperty("catalogDigest");
    expect(Object.isFrozen(catalog.interactions[1]?.request?.previewSchema)).toBe(
      true,
    );
    expect(validateCatalog(program, catalog)).toEqual(catalog);
  });

  it("rejects old boolean availability and incomplete request identity", async () => {
    const list = await createInteractionDescriptor(source(baseContract));
    const program = await createProgram([list]);

    expect(() =>
      createCatalog(program, {
        "todos.list": { direct: true, control: false },
      } as never),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_INVALID_AVAILABILITY" }),
    );
    expect(() =>
      createCatalog(program, [
        {
          interactionId: "todos.list",
          request: {
            realizationId: "realization:todos.list:request:1",
            controlDigest: list.contractDigest,
          },
        } as never,
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_INVALID_AVAILABILITY" }),
    );
    expect(() =>
      createCatalog(program, [
        {
          interactionId: "todos.list",
          request: {
            realizationId: "realization:todos.list:request:1",
            controlDigest: "control:unexpected",
            previewSchema: { type: "object" },
          },
        } as never,
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_INVALID_CONTROL_DIGEST" }),
    );
  });

  it("rejects missing, duplicate, unknown, and reused mode identities", async () => {
    const list = await createInteractionDescriptor(source(baseContract));
    const program = await createProgram([list]);
    const other = await createProgram([
      await createInteractionDescriptor(
        source({ ...baseContract, id: "notes.list", reads: ["notes"] }),
      ),
    ]);

    expect(() =>
      createCatalog(program, [
        {
          interactionId: "notes.list",
          direct: { realizationId: "realization:notes.list:direct:1" },
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_UNKNOWN_INTERACTION" }),
    );
    expect(() => createCatalog(program, [])).toThrowError(
      expect.objectContaining({ code: "CATALOG_MISSING_INTERACTION" }),
    );
    expect(() =>
      createCatalog(program, [
        { interactionId: "todos.list" },
        { interactionId: "todos.list" },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_DUPLICATE_INTERACTION" }),
    );
    expect(() =>
      createCatalog(program, [
        {
          interactionId: "todos.list",
          direct: { realizationId: "realization:shared:1" },
          request: {
            realizationId: "realization:shared:1",
            controlDigest: list.contractDigest,
            previewSchema: { type: "object" },
          },
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_DUPLICATE_REALIZATION" }),
    );
    expect(() =>
      validateCatalog(other, createCatalog(program, [{ interactionId: "todos.list" }])),
    ).toThrowError(
      expect.objectContaining({ code: "CATALOG_PROGRAM_MISMATCH" }),
    );
  });
});
