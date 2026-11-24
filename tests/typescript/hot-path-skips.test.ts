import { describe, expect, it } from "vitest";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  direct,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { validateProjectionBindingManifest } from "@foxworth/boundary/handoff";
import { portableSchema, validateSchemaValue } from "@foxworth/boundary/program";
import {
  CONTROL_RECORD_VERSION,
  listControl,
  type ProposalRecord,
} from "@foxworth/boundary/control";
import { MemoryJournal } from "@foxworth/boundary/control/testing";

const Title = portableSchema<{ readonly title: string }>({
  type: "object",
  properties: {
    title: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" },
  },
  required: ["title"],
  additionalProperties: false,
});
const Echo = portableSchema<{ readonly n: number }>({
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
  additionalProperties: false,
});
const WiderEcho = portableSchema<{
  readonly n: number;
  readonly note?: string;
}>({
  type: "object",
  properties: {
    n: { type: "number" },
    note: { type: "string" },
  },
  required: ["n"],
  additionalProperties: false,
});

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as const;

describe("hot-path skip laws", () => {
  it("rejects invalid input and output when expected and actual contracts match", async () => {
    const interactions = {
      echo: defineInteraction({
        id: "skips.echo",
        input: Echo,
        output: Echo,
        reads: ["skips"],
        changes: [],
      }),
    } as const;
    const compiled = compileInteractions(interactions);
    const { installation } = installInteractions(compiled, {
      installationId: "installation:skips-equal:1",
      implementations: implementInteractions(interactions, {
        echo: () => ({ n: "bad" as unknown as number }),
      }),
      realizationIds: directRealizationIds(compiled, "v1"),
    });
    const projection = projectInteractions(compiled, {
      echo: direct(compiled.handles.echo),
    });
    const result = bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    await expect(
      result.binding.connect().call(projection.handles.echo, { n: "x" } as never),
    ).rejects.toMatchObject({ cause: "invalid-input" });
    await expect(
      result.binding.connect().call(projection.handles.echo, { n: 1 }),
    ).rejects.toMatchObject({ cause: "invalid-realization-outcome" });
  });

  it("still rejects invalid input when expected and actual contracts differ", async () => {
    const expected = {
      echo: defineInteraction({
        id: "skips.wider",
        input: Echo,
        output: Echo,
        reads: ["skips"],
        changes: [],
      }),
    } as const;
    const actual = {
      echo: defineInteraction({
        id: "skips.wider",
        input: WiderEcho,
        output: Echo,
        reads: ["skips"],
        changes: [],
      }),
    } as const;
    const expectedCompiled = compileInteractions(expected);
    const actualCompiled = compileInteractions(actual);
    expect(expectedCompiled.handles.echo.contractDigest).not.toBe(
      actualCompiled.handles.echo.contractDigest,
    );
    const { installation } = installInteractions(actualCompiled, {
      installationId: "installation:skips-wider:1",
      implementations: implementInteractions(actual, {
        echo: (input) => ({ n: input.n }),
      }),
      realizationIds: directRealizationIds(actualCompiled, "v1"),
    });
    const projection = projectInteractions(expectedCompiled, {
      echo: direct(expectedCompiled.handles.echo),
    });
    const result = bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    expect(result.binding.manifest.interactions[0]?.expectedContractDigest).not.toBe(
      result.binding.manifest.interactions[0]?.actualContractDigest,
    );
    await expect(
      result.binding.connect().call(projection.handles.echo, { n: "x" } as never),
    ).rejects.toMatchObject({ cause: "invalid-input" });
    await expect(
      result.binding.connect().call(projection.handles.echo, { n: 1 }),
    ).resolves.toEqual({ n: 1 });
  });

  it("revalidates a copied Binding manifest and rejects a tampered digest", async () => {
    const interactions = {
      echo: defineInteraction({
        id: "skips.handoff",
        input: Echo,
        output: Echo,
        reads: ["skips"],
        changes: [],
      }),
    } as const;
    const compiled = compileInteractions(interactions);
    const { installation } = installInteractions(compiled, {
      installationId: "installation:skips-handoff:1",
      implementations: implementInteractions(interactions, {
        echo: (input) => input,
      }),
      realizationIds: directRealizationIds(compiled, "v1"),
    });
    const projection = projectInteractions(compiled, {
      echo: direct(compiled.handles.echo),
    });
    const result = bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    const validated = validateProjectionBindingManifest(result.binding.manifest);
    expect(validateProjectionBindingManifest(validated)).toBe(validated);
    const tampered = { ...validated, bindingDigest: digest("f") };
    expect(() => validateProjectionBindingManifest(tampered)).toThrow(expect.objectContaining({
      code: "INVALID_MANIFEST",
    }));
  });

  it("rejects a string that does not match a cached pattern", () => {
    expect(validateSchemaValue(Title, { title: "Ship-Boundary" })).toEqual([]);
    expect(validateSchemaValue(Title, { title: "1bad" })).toEqual([
      expect.objectContaining({ message: "string must match pattern" }),
    ]);
  });

  it("rejects a list when a stored proposal digest does not match its content", async () => {
    const journal = new MemoryJournal();
    const identity = {
      version: CONTROL_RECORD_VERSION,
      id: "proposal-corrupt",
      bindingDigest: digest("4"),
      projectionDigest: digest("5"),
      installationId: "installation:todos:1",
      installationDigest: digest("6"),
      expectedProgramDigest: digest("7"),
      actualProgramDigest: digest("7"),
      programDigest: digest("0"),
      controlDigest: digest("2"),
      interactionId: "todos.publish",
      expectedContractDigest: digest("8"),
      contractDigest: digest("3"),
      requestRealizationId: "realization:todos.publish:request:1",
      executionRealizationId: "realization:todos.publish:execute:1",
      controlRealizationDigest: digest("9"),
      requestedBy: "author",
      subject: { kind: "todo-list", id: "inbox" },
      baselineSummary: "unpublished",
      effects: [{ kind: "network", action: "publish", resource: "todos/inbox" }],
      preview: { title: "Publish" },
      createdAt: 1_000,
      input: { list: "inbox" },
      baseline: { revision: 1 },
      state: { body: ["item"] },
    };
    await journal.createProposal({
      ...identity,
      proposalDigest: digest("1"),
    } as ProposalRecord);
    await expect(
      listControl(journal, undefined, {
        interactionIds: ["todos.publish"],
        tenant: { kind: "todo-list", id: "inbox" },
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_INTEGRITY_MISMATCH",
    });
  });
});
