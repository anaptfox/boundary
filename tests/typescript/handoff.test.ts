import { describe, expect, it } from "vitest";
import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "../../packages/core/host/index";
import {
  createHandoffInvocation,
  executeHandoff,
  validateHandoffInvocation,
  validateHandoffOutcomeAgainstManifest,
  validateHandoffOutcome,
  validateProjectionBindingManifest,
} from "../../packages/core/handoff/index";

const RETIRED_WIRE_VERSION = 2;

const Input = portableSchema<{ readonly value: string }>({
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
});
const Output = portableSchema<{ readonly result: string }>({
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
});

async function fixture() {
  type Context = { readonly marker: object };
  const contexts: Context[] = [];
  const interactions = {
    echo: defineInteraction({
      id: "handoff.echo",
      input: Input,
      output: Output,
      reads: [],
      changes: [],
    }),
  } as const;
  const compiled = await compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, Context>(
    interactions,
    {
      echo(input, context) {
        contexts.push(context);
        if (input.value === "throw") {
          throw Object.assign(new Error("private secret"), {
            credential: "do-not-cross",
          });
        }
        return { result: input.value };
      },
    },
  );
  const { installation } = await installInteractions<typeof interactions, Context>(
    compiled,
    {
      installationId: "installation:handoff:2",
      implementations,
      realizationIds: { echo: { direct: "realization:echo:2" } },
    },
  );
  const projection = await projectInteractions(compiled, {
    echo: { interaction: compiled.handles.echo, modes: ["direct"] },
  });
  const result = await bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }),
  });
  if (result.status !== "bound") throw new Error("fixture did not bind");
  return { binding: result.binding, contexts };
}

describe("Handoff protocol v1", () => {
  it("validates every identity pin and passes exact context once", async () => {
    const { binding, contexts } = await fixture();
    const manifest = await validateProjectionBindingManifest(binding.manifest);
    const invocation = await createHandoffInvocation(
      manifest,
      "handoff.echo",
      "direct",
      { value: "hello" },
    );
    const context = { marker: {} };

    const outcome = await executeHandoff(binding, invocation, context);
    expect(outcome).toEqual({
      version: 1,
      bindingDigest: manifest.bindingDigest,
      installationId: manifest.installationId,
      interactionId: "handoff.echo",
      expectedContractDigest: manifest.interactions[0]!.expectedContractDigest,
      actualContractDigest: manifest.interactions[0]!.actualContractDigest,
      mode: "direct",
      realizationId: "realization:echo:2",
      certainty: "completed",
      result: { kind: "returned", value: { result: "hello" } },
    });
    await expect(
      validateHandoffOutcomeAgainstManifest(manifest, outcome),
    ).resolves.toEqual(outcome);
    expect(contexts).toEqual([context]);

    await expect(
      executeHandoff(
        binding,
        { ...invocation, realizationId: "realization:stale" },
        context,
      ),
    ).rejects.toMatchObject({ code: "STALE_REALIZATION" });
    expect(contexts).toEqual([context]);
  });

  it("rejects a Catalog realization that disagrees with the Binding pin", async () => {
    const { binding } = await fixture();
    const tampered = structuredClone(binding.manifest);
    const entry = tampered.actualCatalog.interactions[0];
    if (!entry?.direct) throw new Error("fixture lacks direct availability");
    (entry.direct as { realizationId: string }).realizationId =
      "realization:echo:drifted";

    await expect(
      validateProjectionBindingManifest(tampered),
    ).rejects.toMatchObject({
      code: "INVALID_MANIFEST",
      path: "manifest.interactions[0].realizationId",
    });
  });

  it("returns frozen nested validation issues before Host dispatch", async () => {
    const { binding, contexts } = await fixture();
    const invocation = await createHandoffInvocation(
      binding.manifest,
      "handoff.echo",
      "direct",
      { value: 42 } as never,
    );

    const outcome = await executeHandoff(
      binding,
      invocation,
      { marker: {} },
    );

    expect(outcome).toMatchObject({
      certainty: "not-started",
      result: {
        kind: "fault",
        cause: "invalid-input",
        issues: [
          {
            path: "invocation.input.value",
            message: expect.any(String),
          },
        ],
      },
    });
    expect(contexts).toEqual([]);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.result)).toBe(true);
    if (outcome.result.kind !== "fault" || !outcome.result.issues) {
      throw new Error("expected validation issues");
    }
    expect(Object.isFrozen(outcome.result.issues)).toBe(true);
    expect(Object.isFrozen(outcome.result.issues[0])).toBe(true);
  });

  it("accepts version 1 only and rejects unknown versions and invalid certainty combinations", () => {
    expect(() =>
      validateHandoffInvocation({ version: RETIRED_WIRE_VERSION }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_VERSION" }));
    expect(() =>
      validateHandoffOutcome({ version: RETIRED_WIRE_VERSION }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_VERSION" }));
    expect(() =>
      validateHandoffInvocation({ version: 99 }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_VERSION" }));

    expect(() =>
      validateHandoffOutcome({
        version: 1,
        bindingDigest: `sha256:${"1".repeat(64)}`,
        installationId: "installation:2",
        interactionId: "handoff.echo",
        expectedContractDigest: `sha256:${"2".repeat(64)}`,
        actualContractDigest: `sha256:${"3".repeat(64)}`,
        mode: "direct",
        realizationId: "realization:2",
        certainty: "not-started",
        result: { kind: "returned", value: null },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTCOME" }));

    expect(
      validateHandoffOutcome({
        version: 1,
        bindingDigest: `sha256:${"1".repeat(64)}`,
        installationId: "installation:2",
        interactionId: "handoff.echo",
        expectedContractDigest: `sha256:${"2".repeat(64)}`,
        actualContractDigest: `sha256:${"3".repeat(64)}`,
        mode: "direct",
        realizationId: "realization:2",
        certainty: "not-completed",
        result: { kind: "fault", cause: "realization-failed" },
      }).certainty,
    ).toBe("not-completed");

    const identity = {
      version: 1,
      bindingDigest: `sha256:${"1".repeat(64)}`,
      installationId: "installation:2",
      interactionId: "handoff.echo",
      expectedContractDigest: `sha256:${"2".repeat(64)}`,
      actualContractDigest: `sha256:${"3".repeat(64)}`,
      mode: "direct",
      realizationId: "realization:2",
      certainty: "not-started",
    } as const;
    expect(() =>
      validateHandoffOutcome({
        ...identity,
        result: {
          kind: "fault",
          cause: "invalid-input",
          issues: [{ path: "invocation.input.value", message: "invalid", private: true }],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTCOME" }));
    expect(() =>
      validateHandoffOutcome({
        ...identity,
        result: {
          kind: "fault",
          cause: "realization-failed",
          issues: [{ path: "invocation.input.value", message: "invalid" }],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTCOME" }));
  });

  it("sanitizes arbitrary realization failures and keeps certainty unknown", async () => {
    const { binding } = await fixture();
    const invocation = await createHandoffInvocation(
      binding.manifest,
      "handoff.echo",
      "direct",
      { value: "throw" },
    );
    const outcome = await executeHandoff(binding, invocation, { marker: {} });

    expect(outcome.certainty).toBe("unknown");
    expect(outcome.result).toEqual({
      kind: "fault",
      cause: "realization-failed",
    });
    expect(JSON.stringify(outcome)).not.toContain("private secret");
    expect(JSON.stringify(outcome)).not.toContain("credential");
  });

  it("sanitizes invalid Host outcomes after dispatch", async () => {
    const { binding, contexts } = await fixture();
    const manifest = await validateProjectionBindingManifest(binding.manifest);
    const interaction = manifest.interactions[0]!;
    const invocation = await createHandoffInvocation(
      manifest,
      interaction.interactionId,
      interaction.mode,
      { value: "hello" },
    );
    const raw = {
      bindingDigest: manifest.bindingDigest,
      projectionDigest: manifest.projectionDigest,
      installationId: manifest.installationId,
      installationDigest: manifest.installationDigest,
      interactionId: interaction.interactionId,
      expectedContractDigest: interaction.expectedContractDigest,
      actualContractDigest: interaction.actualContractDigest,
      mode: interaction.mode,
      realizationId: interaction.realizationId,
      certainty: "completed" as const,
      result: { kind: "returned" as const, value: { result: "hello" } },
    };
    const withOutcome = (outcome: typeof raw) => Object.freeze({
      ...binding,
      invoke: async () => outcome,
    }) as typeof binding;

    await expect(
      executeHandoff(
        withOutcome({
          ...raw,
          bindingDigest: `sha256:${"f".repeat(64)}`,
        }),
        invocation,
        { marker: {} },
      ),
    ).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });
    await expect(
      executeHandoff(
        withOutcome({
          ...raw,
          result: { kind: "returned", value: { result: 42 } },
        } as unknown as typeof raw),
        invocation,
        { marker: {} },
      ),
    ).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });
    expect(contexts).toEqual([]);
  });
});
