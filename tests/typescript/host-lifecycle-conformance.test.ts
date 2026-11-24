import { presentProjection } from "../../packages/core/host/index";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portableSchema, type JsonSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
  type Admission,
  type InteractionMode,
} from "../../packages/core/host/index";
import { createControlRequestContributions } from "../../packages/core/host/control";
import {
  createCheckedHandoff,
  createHandoffInvocation,
  validateHandoffOutcomeAgainstManifest,
  validateProjectionBindingManifest,
} from "../../packages/core/handoff/index";

type OutcomeVector = Readonly<{
  name: string;
  mode: InteractionMode;
  behavior: "return" | "deny" | "throw";
  certainty: "not-started" | "completed" | "unknown";
  resultKind: "returned" | "proposed" | "denied" | "fault";
}>;

type LifecycleVector = Readonly<{
  version: 1;
  interaction: Readonly<{
    alias: string;
    id: string;
    inputArity: 1;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    reads: readonly string[];
    changes: readonly string[];
    contractDigest: string;
    programDigest: string;
  }>;
  projection: Readonly<{
    modes: readonly InteractionMode[];
    projectionDigest: string;
    renamedAlias: string;
    renamedProjectionDigest: string;
    durableClaims: readonly [
      "alias",
      "interaction-identity",
      "input-arity",
      "modes",
    ];
  }>;
  compatibleActual: Readonly<{
    inputSchema: JsonSchema;
    contractDigest: string;
    programDigest: string;
    expectedToActual: "compatible";
    actualToExpected: "incompatible";
  }>;
  installation: Readonly<{
    installationId: string;
    realizationIds: Readonly<Record<InteractionMode, string>>;
  }>;
  atomicUnrealized: Readonly<{
    availableModes: readonly InteractionMode[];
    missingMode: InteractionMode;
    reason: string;
    status: "unrealized";
    exposesBinding: false;
  }>;
  outcomes: readonly OutcomeVector[];
  certaintyClaims: readonly Readonly<{
    certainty: "not-started" | "not-completed" | "completed" | "unknown";
    meaning: string;
    legalResultKinds: readonly string[];
  }>[];
  artifacts: Readonly<{
    installation: Record<string, unknown>;
    binding: Record<string, unknown>;
    handoffInvocation: Record<string, unknown>;
    handoffOutcomes: readonly Record<string, unknown>[];
  }>;
}>;

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../conformance/v1/host-lifecycle.json", import.meta.url),
    ),
    "utf8",
  ),
) as LifecycleVector;

const Input = portableSchema<{ readonly title: string }>(
  vector.interaction.inputSchema,
);
const Output = portableSchema<{
  readonly id: string;
  readonly title: string;
}>(vector.interaction.outputSchema);

function definitions() {
  return {
    create: defineInteraction({
      id: "todos.create",
      input: Input,
      output: Output,
      reads: vector.interaction.reads,
      changes: vector.interaction.changes,
    }),
  } as const;
}

async function compiledVector() {
  const interactions = definitions();
  return { interactions, compiled: compileInteractions(interactions) };
}

describe("shared Host lifecycle v1 vectors", () => {
  it("pins stable contract and Program identities", async () => {
    expect(vector.version).toBe(1);
    const first = await compiledVector();
    const second = await compiledVector();

    expect(first.compiled.handles.create.interactionId).toBe(vector.interaction.id);
    expect(first.compiled.handles.create.inputArity).toBe(
      vector.interaction.inputArity,
    );
    expect(first.compiled.handles.create.contractDigest).toBe(
      vector.interaction.contractDigest,
    );
    expect(first.compiled.program.programDigest).toBe(
      vector.interaction.programDigest,
    );
    expect(second.compiled.handles.create.contractDigest).toBe(
      first.compiled.handles.create.contractDigest,
    );
    expect(second.compiled.program.programDigest).toBe(
      first.compiled.program.programDigest,
    );
  });

  it("keeps the desired Projection durable before any Installation exists", async () => {
    const { compiled } = await compiledVector();
    const first = projectInteractions(compiled, {
      create: {
        interaction: compiled.handles.create,
        modes: vector.projection.modes,
      },
    });
    const second = projectInteractions(compiled, {
      create: {
        interaction: compiled.handles.create,
        modes: vector.projection.modes,
      },
    });

    expect(first.projectionDigest).toBe(second.projectionDigest);
    expect(first.projectionDigest).toBe(vector.projection.projectionDigest);
    const durable = JSON.parse(JSON.stringify(first.manifest)) as {
      interactions: Array<Record<string, unknown>>;
    };
    expect(durable).toMatchObject({
      version: 1,
      projectionDigest: first.projectionDigest,
      program: { programDigest: vector.interaction.programDigest },
      interactions: [
        {
          alias: vector.interaction.alias,
          interactionId: vector.interaction.id,
          expectedContractDigest: vector.interaction.contractDigest,
          inputArity: vector.interaction.inputArity,
          modes: vector.projection.modes,
        },
      ],
    });
    expect(vector.projection.durableClaims).toEqual([
      "alias",
      "interaction-identity",
      "input-arity",
      "modes",
    ]);

    const renamed = projectInteractions(compiled, {
      [vector.projection.renamedAlias]: {
        interaction: compiled.handles.create,
        modes: vector.projection.modes,
      },
    });
    expect(renamed.projectionDigest).toBe(
      vector.projection.renamedProjectionDigest,
    );
    expect(renamed.projectionDigest).not.toBe(first.projectionDigest);
    expect(renamed.manifest.interactions).toEqual([
      expect.objectContaining({ alias: vector.projection.renamedAlias }),
    ]);
  });

  it("binds compatible nonidentical actual contracts in one direction only", async () => {
    const expected = await compiledVector();
    const CompatibleInput = portableSchema<{ readonly title: string; readonly priority?: number }>(
      vector.compatibleActual.inputSchema,
    );
    const actualInteractions = {
      create: defineInteraction({
        id: vector.interaction.id,
        input: CompatibleInput,
        output: Output,
        reads: vector.interaction.reads,
        changes: vector.interaction.changes,
      }),
    } as const;
    const actualCompiled = compileInteractions(actualInteractions);
    expect(actualCompiled.handles.create.contractDigest).toBe(
      vector.compatibleActual.contractDigest,
    );
    expect(actualCompiled.program.programDigest).toBe(
      vector.compatibleActual.programDigest,
    );

    const expectedProjection = projectInteractions(expected.compiled, {
      create: {
        interaction: expected.compiled.handles.create,
        modes: ["direct"],
      },
    });
    const { installation: actualInstallation } = installInteractions(actualCompiled, {
      installationId: `${vector.installation.installationId}:compatible`,
      implementations: implementInteractions(actualInteractions, {
        create: (input) => ({ id: "todo-actual", title: input.title }),
      }),
      realizationIds: {
        create: { direct: vector.installation.realizationIds.direct },
      },
    });
    const forward = bindProjection(
      expectedProjection,
      actualInstallation,
      { admit: () => ({ decision: "allow" }) },
    );
    expect(vector.compatibleActual.expectedToActual).toBe("compatible");
    expect(forward.status).toBe("bound");
    if (forward.status !== "bound") return;
    expect(forward.binding.manifest).toMatchObject({
      expectedProgramDigest: vector.interaction.programDigest,
      actualProgramDigest: vector.compatibleActual.programDigest,
      expectedProgram: { programDigest: vector.interaction.programDigest },
      actualProgram: { programDigest: vector.compatibleActual.programDigest },
      interactions: [
        {
          expectedContractDigest: vector.interaction.contractDigest,
          actualContractDigest: vector.compatibleActual.contractDigest,
        },
      ],
    });

    const actualProjection = projectInteractions(actualCompiled, {
      create: {
        interaction: actualCompiled.handles.create,
        modes: ["direct"],
      },
    });
    const { installation: expectedInstallation } = installInteractions(expected.compiled, {
      installationId: `${vector.installation.installationId}:expected`,
      implementations: implementInteractions(expected.interactions, {
        create: (input) => ({ id: "todo-expected", title: input.title }),
      }),
      realizationIds: {
        create: { direct: vector.installation.realizationIds.direct },
      },
    });
    const reverse = bindProjection(
      actualProjection,
      expectedInstallation,
      { admit: () => ({ decision: "allow" }) },
    );
    expect(vector.compatibleActual.actualToExpected).toBe("incompatible");
    expect(reverse).toMatchObject({
      status: "unrealized",
      report: {
        issues: [{ reason: "incompatible-contract" }],
      },
    });
  });

  it("returns durable unrealized data and never a partial Binding", async () => {
    const { interactions, compiled } = await compiledVector();
    const implementations = implementInteractions(interactions, {
      create: (input) => ({ id: "todo-1", title: input.title }),
    });
    const { installation } = installInteractions(compiled, {
      installationId: vector.installation.installationId,
      implementations,
      realizationIds: {
        create: { direct: vector.installation.realizationIds.direct },
      },
    });
    const projection = projectInteractions(compiled, {
      create: {
        interaction: compiled.handles.create,
        modes: vector.projection.modes,
      },
    });
    const result = bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });

    expect(vector.atomicUnrealized.availableModes).toEqual(["direct"]);
    expect(result.status).toBe(vector.atomicUnrealized.status);
    expect(vector.atomicUnrealized.exposesBinding).toBe(false);
    expect(result).not.toHaveProperty("binding");
    expect(result).toMatchObject({
      status: "unrealized",
      report: {
        projection: projection.manifest,
        installationId: vector.installation.installationId,
        issues: [
          {
            alias: vector.interaction.alias,
            interactionId: vector.interaction.id,
            mode: vector.atomicUnrealized.missingMode,
            reason: vector.atomicUnrealized.reason,
          },
        ],
      },
    });
  });

  it("consumes exact shared Installation, Binding, and Handoff artifacts", async () => {
    const interactions = definitions();
    const compiled = compileInteractions(interactions);
    const Preview = portableSchema<Readonly<{ kind: "todo-create"; title: string }>>({
      type: "object",
      properties: { kind: { const: "todo-create" }, title: { type: "string" } },
      required: ["kind", "title"],
      additionalProperties: false,
    });
    const requests = createControlRequestContributions(compiled, {
      create: {
        interaction: compiled.handles.create,
        controlDigest: `sha256:${"2".repeat(64)}`,
        previewSchema: Preview,
        request(input) {
          return { kind: "todo-create" as const, title: input.title };
        },
      },
    });
    const { installation } = installInteractions(compiled, {
      installationId: vector.installation.installationId,
      implementations: implementInteractions(interactions, {
        create: (input) => ({ id: "todo-1", title: input.title }),
      }),
      requests,
      realizationIds: { create: vector.installation.realizationIds },
    });
    expect(JSON.parse(JSON.stringify(installation.manifest))).toEqual(
      vector.artifacts.installation,
    );

    const projection = projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct", "request"] },
    });
    const bound = bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(bound.status).toBe("bound");
    if (bound.status !== "bound") return;
    expect(JSON.parse(JSON.stringify(bound.binding.manifest))).toEqual(
      vector.artifacts.binding,
    );
    expect(validateProjectionBindingManifest(vector.artifacts.binding))
      .toEqual(vector.artifacts.binding);

    const checked = await createCheckedHandoff(bound.binding);
    const invocation = await createHandoffInvocation(
      checked.manifest,
      vector.interaction.id,
      "direct",
      { title: "Native parity" },
    );
    expect(JSON.parse(JSON.stringify(invocation))).toEqual(
      vector.artifacts.handoffInvocation,
    );
    for (const outcome of vector.artifacts.handoffOutcomes) {
      await expect(validateHandoffOutcomeAgainstManifest(checked.manifest, outcome))
        .resolves.toEqual(outcome);
    }
  });

  it("pins exact modes, realization identities, and certainty", async () => {
    expect(vector.certaintyClaims).toEqual([
      {
        certainty: "not-started",
        meaning: "the interaction effect did not begin",
        legalResultKinds: ["proposed", "denied", "fault"],
      },
      {
        certainty: "not-completed",
        meaning:
          "execution began and the dispatcher proved the interaction did not complete",
        legalResultKinds: ["fault"],
      },
      {
        certainty: "completed",
        meaning: "the declared interaction effect completed",
        legalResultKinds: ["returned", "declared-error"],
      },
      {
        certainty: "unknown",
        meaning: "execution may have begun and completion cannot be proved",
        legalResultKinds: ["fault"],
      },
    ]);
    for (const outcomeVector of vector.outcomes) {
      const interactions = definitions();
      const compiled = compileInteractions(interactions);
      const implementations = implementInteractions(interactions, {
        create(input) {
          if (outcomeVector.behavior === "throw") {
            throw new Error("unexpected realization failure");
          }
          return { id: "todo-1", title: input.title };
        },
      });
      const requests = createControlRequestContributions<
        ReturnType<typeof definitions>,
        void
      >(compiled, {
        create: {
          interaction: compiled.handles.create,
          controlDigest: compiled.handles.create.contractDigest,
          previewSchema: Output,
          request(input) {
            return { id: "proposal-1", title: input.title };
          },
        },
      });
      const { installation } = installInteractions<ReturnType<typeof definitions>, void>(compiled, {
        installationId: vector.installation.installationId,
        implementations,
        requests,
        realizationIds: { create: vector.installation.realizationIds },
      });
      const projection = projectInteractions(compiled, {
        create: {
          interaction: compiled.handles.create,
          modes: [outcomeVector.mode],
        },
      });
      const admission: Admission<void> = () =>
        outcomeVector.behavior === "deny"
          ? { decision: "deny", reason: "vector denial" }
          : { decision: "allow" };
      const result = bindProjection(projection, installation, {
        admit: admission,
      });
      expect(result.status, outcomeVector.name).toBe("bound");
      if (result.status !== "bound") continue;

      const resolved = result.binding.resolve(vector.interaction.id);
      expect(resolved, outcomeVector.name).toBeDefined();
      const raw = result.binding.connect();
      const invocation =
        outcomeVector.mode === "direct"
          ? await raw.callRaw(resolved!, { title: "vector" })
          : await raw.requestRaw!(resolved!, { title: "vector" });

      expect(invocation, outcomeVector.name).toMatchObject({
        installationId: vector.installation.installationId,
        interactionId: vector.interaction.id,
        expectedContractDigest: vector.interaction.contractDigest,
        actualContractDigest: vector.interaction.contractDigest,
        mode: outcomeVector.mode,
        realizationId:
          vector.installation.realizationIds[outcomeVector.mode],
        certainty: outcomeVector.certainty,
        result: { kind: outcomeVector.resultKind },
      });
      expect(result.binding.manifest.interactions, outcomeVector.name).toEqual([
        expect.objectContaining({
          interactionId: vector.interaction.id,
          mode: outcomeVector.mode,
          realizationId:
            vector.installation.realizationIds[outcomeVector.mode],
        }),
      ]);
    }
  });
});

 it("matches the independently reviewed presentation digest", async () => {
  const { compiled } = await compiledVector();
  const projection = projectInteractions(compiled, { create: { interaction: compiled.handles.create, modes: ["direct", "request"] } });
  const vector = JSON.parse(readFileSync(new URL("../conformance/v1/composition.json", import.meta.url), "utf8"));
  expect(presentProjection(projection, { create: { title: "Create todo", description: "Propose or create a todo." } })).toEqual(vector.presentation);
});
