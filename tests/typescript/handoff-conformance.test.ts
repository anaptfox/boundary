import { describe, expect, it } from "vitest";
import { portableSchema, type JsonValue } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
  type AdmissionDecision,
  type AdmissionRequest,
} from "../../packages/core/host/index";
import { createControlRequestContributions } from "../../packages/core/host/control";
import {
  createCheckedHandoff,
  createHandoffInvocation,
  executeHandoff,
  validateHandoffInvocation,
  validateHandoffOutcomeAgainstManifest,
  validateHandoffOutcome,
  validateProjectionBindingManifest,
  type HandoffInvocation,
} from "../../packages/core/handoff/index";

const RETIRED_WIRE_VERSION = 2;

const ProbeInput = portableSchema<{ readonly value: string }>({
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
});
const ProbeOutput = portableSchema<{ readonly echoed: string }>({
  type: "object",
  properties: { echoed: { type: "string" } },
  required: ["echoed"],
  additionalProperties: false,
});
const ProbeError = portableSchema<{ readonly reason: string }>({
  type: "object",
  properties: { reason: { type: "string" } },
  required: ["reason"],
  additionalProperties: false,
});
const Proposal = portableSchema<{ readonly proposalId: string }>({
  type: "object",
  properties: { proposalId: { type: "string" } },
  required: ["proposalId"],
  additionalProperties: false,
});
const PingOutput = portableSchema<{ readonly ok: boolean }>({
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
});

const interactions = {
  probe: defineInteraction({
    id: "handoff.probe",
    input: ProbeInput,
    output: ProbeOutput,
    errors: { rejected: ProbeError },
    reads: ["probe"],
    changes: ["probe"],
  }),
  ping: defineInteraction({
    id: "handoff.ping",
    output: PingOutput,
    reads: ["probe"],
    changes: [],
  }),
} as const;

type Context = Readonly<{ marker: object }>;

async function fixture(
  decide: (
    request: AdmissionRequest<Context>,
  ) => AdmissionDecision | Promise<AdmissionDecision> = () => ({
    decision: "allow",
  }),
) {
  const seen = {
    admissions: 0,
    direct: 0,
    requests: 0,
    contexts: [] as Context[],
  };
  const compiled = await compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, Context>(
    interactions,
    {
      probe(input, context) {
        seen.direct += 1;
        seen.contexts.push(context);
        if (input.value === "declared") {
          throw declaredInteractionError(interactions.probe, "rejected", {
            reason: "declared",
          });
        }
        if (input.value === "throw-private") {
          throw Object.assign(new Error("private host detail"), {
            credential: "never-cross",
          });
        }
        return { echoed: input.value };
      },
      ping(context) {
        seen.direct += 1;
        seen.contexts.push(context);
        return { ok: true };
      },
    },
  );
  const requests = createControlRequestContributions<typeof interactions, Context>(
    compiled,
    {
      probe: {
        interaction: compiled.handles.probe,
        controlDigest: compiled.handles.probe.contractDigest,
        previewSchema: Proposal,
        request(input, context) {
          seen.requests += 1;
          seen.contexts.push(context);
          if (input.value === "invalid-preview") {
            return { proposalId: 42 } as unknown as {
              readonly proposalId: string;
            };
          }
          return { proposalId: `proposal:${input.value}` };
        },
      },
    },
  );
  const { installation } = await installInteractions<typeof interactions, Context>(
    compiled,
    {
      installationId: "installation:handoff-conformance:2",
      implementations,
      requests,
      realizationIds: {
        ping: { direct: "realization:ping:2" },
        probe: {
          direct: "realization:probe:direct:2",
          request: "realization:probe:request:2",
        },
      },
    },
  );
  const projection = await projectInteractions(compiled, {
    ping: { interaction: compiled.handles.ping, modes: ["direct"] },
    probe: {
      interaction: compiled.handles.probe,
      modes: ["direct", "request"],
    },
  });
  const bound = await bindProjection(projection, installation, {
    async admit(request) {
      seen.admissions += 1;
      seen.contexts.push(request.context);
      return decide(request);
    },
  });
  if (bound.status !== "bound") throw new Error("fixture did not bind");
  return { binding: bound.binding, controller: bound.controller, seen };
}

function copy<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

describe("Handoff v1 hostile-boundary conformance", () => {
  it("snapshots and validates one exact immutable Binding handshake", async () => {
    const { binding } = await fixture();
    const forged = copy(binding.manifest);
    const validated = await validateProjectionBindingManifest(forged);

    (forged as { installationId: string }).installationId = "installation:mutated";
    expect(validated.installationId).toBe(
      "installation:handoff-conformance:2",
    );
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.interactions)).toBe(true);

    await expect(
      validateProjectionBindingManifest({
        ...copy(binding.manifest),
        version: RETIRED_WIRE_VERSION,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    await expect(
      validateProjectionBindingManifest({
        ...copy(binding.manifest),
        version: 99,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    await expect(
      validateProjectionBindingManifest({
        ...copy(binding.manifest),
        installationId: "installation:other",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    await expect(
      validateProjectionBindingManifest({
        ...copy(binding.manifest),
        extra: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });

  it("rejects accessor-backed handshake and invocation fields without invoking them", async () => {
    const { binding, seen } = await fixture();
    let getterCalls = 0;
    const manifest = copy(binding.manifest) as unknown as Record<string, unknown>;
    Object.defineProperty(manifest, "bindingDigest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return binding.manifest.bindingDigest;
      },
    });
    await expect(
      validateProjectionBindingManifest(manifest),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });

    const invocation = copy(
      await createHandoffInvocation(
        binding.manifest,
        "handoff.probe",
        "direct",
        { value: "safe" },
      ),
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(invocation, "input", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { value: "unsafe" };
      },
    });
    expect(() => validateHandoffInvocation(invocation)).toThrowError(
      expect.objectContaining({ code: "INVALID_INVOCATION" }),
    );
    expect(getterCalls).toBe(0);
    expect(seen.admissions).toBe(0);
    expect(seen.direct).toBe(0);
  });

  it("creates exact envelopes only for exposed modes and canonical zero arity", async () => {
    const { binding } = await fixture();
    const direct = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "direct",
      { value: "hello" },
    );
    expect(direct).toMatchObject({
      version: 1,
      bindingDigest: binding.manifest.bindingDigest,
      installationId: binding.manifest.installationId,
      interactionId: "handoff.probe",
      mode: "direct",
      realizationId: "realization:probe:direct:2",
    });

    await expect(
      createHandoffInvocation(
        binding.manifest,
        "handoff.ping",
        "request",
        null,
      ),
    ).rejects.toMatchObject({ code: "MODE_NOT_EXPOSED" });
    const ping = await createHandoffInvocation(
      binding.manifest,
      "handoff.ping",
      "direct",
      null,
    );
    expect(ping.input).toBeNull();
    await expect(
      executeHandoff(binding, { ...ping, input: {} }, { marker: {} }),
    ).resolves.toMatchObject({
      certainty: "not-started",
      result: {
        kind: "fault",
        cause: "invalid-input",
        issues: [expect.objectContaining({ path: "invocation.input" })],
      },
    });
  });

  it("authorizes and dispatches once with the exact invocation context", async () => {
    const { binding, seen } = await fixture();
    const context = { marker: {} };
    const invocation = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "direct",
      { value: "hello" },
    );
    await expect(executeHandoff(binding, invocation, context)).resolves.toEqual({
      version: 1,
      bindingDigest: binding.manifest.bindingDigest,
      installationId: binding.manifest.installationId,
      interactionId: "handoff.probe",
      expectedContractDigest: invocation.expectedContractDigest,
      actualContractDigest: invocation.actualContractDigest,
      mode: "direct",
      realizationId: "realization:probe:direct:2",
      certainty: "completed",
      result: { kind: "returned", value: { echoed: "hello" } },
    });
    expect(seen.admissions).toBe(1);
    expect(seen.direct).toBe(1);
    expect(seen.contexts).toEqual([context, context]);
  });

  it("rejects stale, unselected, malformed, and invalid calls before Host admission", async () => {
    const { binding, seen } = await fixture();
    const invocation = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "direct",
      { value: "hello" },
    );
    const digest = `sha256:${"f".repeat(64)}` as const;
    const cases: readonly [Partial<HandoffInvocation>, string][] = [
      [{ bindingDigest: digest }, "STALE_BINDING"],
      [{ installationId: "installation:stale" }, "STALE_INSTALLATION"],
      [{ interactionId: "handoff.unselected" }, "INTERACTION_NOT_EXPOSED"],
      [{ expectedContractDigest: digest }, "STALE_CONTRACT"],
      [{ actualContractDigest: digest }, "STALE_CONTRACT"],
      [{ realizationId: "realization:stale" }, "STALE_REALIZATION"],
    ];
    for (const [change, code] of cases) {
      await expect(
        executeHandoff(
          binding,
          { ...invocation, ...change },
          { marker: {} },
        ),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      executeHandoff(
        binding,
        { ...invocation, input: { value: 42 } as unknown as JsonValue },
        { marker: {} },
      ),
    ).resolves.toMatchObject({
      certainty: "not-started",
      result: {
        kind: "fault",
        cause: "invalid-input",
        issues: [expect.objectContaining({ path: "invocation.input.value" })],
      },
    });
    await expect(
      executeHandoff(
        binding,
        { ...invocation, extra: true },
        { marker: {} },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INVOCATION" });
    expect(seen.admissions).toBe(0);
    expect(seen.direct).toBe(0);
    expect(seen.requests).toBe(0);
  });

  it("preserves declared errors and request proposals as distinct public results", async () => {
    const { binding, seen } = await fixture();
    const context = { marker: {} };
    const declared = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "direct",
      { value: "declared" },
    );
    await expect(executeHandoff(binding, declared, context)).resolves.toMatchObject({
      certainty: "completed",
      result: {
        kind: "declared-error",
        code: "rejected",
        details: { reason: "declared" },
      },
    });
    const request = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "request",
      { value: "review" },
    );
    await expect(executeHandoff(binding, request, context)).resolves.toMatchObject({
      certainty: "not-started",
      mode: "request",
      realizationId: "realization:probe:request:2",
      result: {
        kind: "proposed",
        proposal: { proposalId: "proposal:review" },
      },
    });
    const invalidPreview = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "request",
      { value: "invalid-preview" },
    );
    await expect(
      executeHandoff(binding, invalidPreview, context),
    ).resolves.toMatchObject({
      certainty: "not-started",
      mode: "request",
      result: { kind: "fault", cause: "request-failed" },
    });
    expect(seen.direct).toBe(1);
    expect(seen.requests).toBe(2);
  });

  it("returns stable denial and sanitized execution faults without private causes", async () => {
    const denied = await fixture(() => ({
      decision: "deny",
      reason: "private policy reason",
    }));
    const deniedInvocation = await createHandoffInvocation(
      denied.binding.manifest,
      "handoff.probe",
      "direct",
      { value: "hello" },
    );
    await expect(
      executeHandoff(denied.binding, deniedInvocation, { marker: {} }),
    ).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "denied", code: "CALL_NOT_ADMITTED" },
    });
    expect(denied.seen.direct).toBe(0);

    const throwingAdmission = await fixture(() => {
      throw Object.assign(new Error("private policy detail"), {
        credential: "never-cross",
      });
    });
    const admissionInvocation = await createHandoffInvocation(
      throwingAdmission.binding.manifest,
      "handoff.probe",
      "direct",
      { value: "hello" },
    );
    const admissionOutcome = await executeHandoff(
      throwingAdmission.binding,
      admissionInvocation,
      { marker: {} },
    );
    expect(admissionOutcome).toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "admission-failed" },
    });
    expect(JSON.stringify(admissionOutcome)).not.toContain("private");
    expect(JSON.stringify(admissionOutcome)).not.toContain("credential");

    const failing = await fixture();
    const failingInvocation = await createHandoffInvocation(
      failing.binding.manifest,
      "handoff.probe",
      "direct",
      { value: "throw-private" },
    );
    const executionOutcome = await executeHandoff(
      failing.binding,
      failingInvocation,
      { marker: {} },
    );
    expect(executionOutcome).toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(JSON.stringify(executionOutcome)).not.toContain("private");
    expect(JSON.stringify(executionOutcome)).not.toContain("credential");
  });

  it("sanitizes invalid Host outcomes after dispatch while remote validation rejects them", async () => {
    const { binding, seen } = await fixture();
    const invocation = await createHandoffInvocation(
      binding.manifest,
      "handoff.probe",
      "direct",
      { value: "hello" },
    );
    const interaction = binding.manifest.interactions.find(
      (entry) => entry.interactionId === "handoff.probe" && entry.mode === "direct",
    )!;
    const raw = {
      bindingDigest: binding.manifest.bindingDigest,
      projectionDigest: binding.manifest.projectionDigest,
      installationId: binding.manifest.installationId,
      installationDigest: binding.manifest.installationDigest,
      interactionId: interaction.interactionId,
      expectedContractDigest: interaction.expectedContractDigest,
      actualContractDigest: interaction.actualContractDigest,
      mode: interaction.mode,
      realizationId: interaction.realizationId,
      certainty: "completed" as const,
      result: {
        kind: "returned" as const,
        value: { echoed: "hello" },
      },
    };
    let hostInvocations = 0;
    const withOutcome = (outcome: unknown) =>
      Object.freeze({
        ...binding,
        invoke: async () => {
          hostInvocations += 1;
          return outcome;
        },
      }) as unknown as typeof binding;

    await expect(
      executeHandoff(
        withOutcome({
          ...raw,
          projectionDigest: `sha256:${"e".repeat(64)}`,
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
          result: { kind: "returned", value: { echoed: 42 } },
        }),
        invocation,
        { marker: {} },
      ),
    ).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });
    await expect(
      validateHandoffOutcomeAgainstManifest(binding.manifest, {
        version: 1,
        ...raw,
        result: { kind: "returned", value: { echoed: 42 } },
      }),
    ).rejects.toMatchObject({ code: "INVALID_OUTCOME" });
    expect(hostInvocations).toBe(2);
    expect(seen.admissions).toBe(0);
    expect(seen.direct).toBe(0);
  });

  it("validates result/certainty combinations and the pinned preview schema", async () => {
    const digest = `sha256:${"1".repeat(64)}` as const;
    const base = {
      version: 1 as const,
      bindingDigest: digest,
      installationId: "installation:2",
      interactionId: "handoff.probe",
      expectedContractDigest: digest,
      actualContractDigest: digest,
      mode: "direct" as const,
      realizationId: "realization:2",
    };
    expect(() =>
      validateHandoffOutcome({
        ...base,
        certainty: "not-started",
        result: { kind: "returned", value: { echoed: "no" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTCOME" }));
    expect(() =>
      validateHandoffOutcome({
        ...base,
        mode: "request",
        certainty: "completed",
        result: { kind: "proposed", proposal: { proposalId: "no" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTCOME" }));
    expect(
      validateHandoffOutcome({
        ...base,
        certainty: "not-completed",
        result: { kind: "fault", cause: "realization-failed" },
      }).certainty,
    ).toBe("not-completed");
    const legalFaults = [
      ["direct", "not-started", "invalid-input"],
      ["request", "not-started", "revoked"],
      ["direct", "not-started", "admission-failed"],
      ["request", "not-started", "request-failed"],
      ["direct", "unknown", "invalid-realization-outcome"],
      ["direct", "not-started", "realization-failed"],
      ["direct", "not-completed", "realization-failed"],
      ["direct", "unknown", "realization-failed"],
      ["request", "unknown", "realization-failed"],
      ["request", "not-started", "invalid-invocation"],
    ] as const;
    for (const [mode, certainty, cause] of legalFaults) {
      expect(() => validateHandoffOutcome({
        ...base,
        mode,
        certainty,
        result: { kind: "fault", cause },
      })).not.toThrow();
    }
    const illegalFaults = [
      ["direct", "not-started", "invalid-realization-outcome"],
      ["direct", "not-completed", "invalid-realization-outcome"],
      ["direct", "unknown", "admission-failed"],
      ["request", "not-completed", "revoked"],
      ["direct", "not-started", "request-failed"],
      ["request", "unknown", "invalid-realization-outcome"],
      ["request", "not-started", "realization-failed"],
      ["request", "not-completed", "realization-failed"],
    ] as const;
    for (const [mode, certainty, cause] of illegalFaults) {
      expect(() => validateHandoffOutcome({
        ...base,
        mode,
        certainty,
        result: { kind: "fault", cause },
      })).toThrowError(expect.objectContaining({ code: "INVALID_OUTCOME" }));
    }

    const { binding } = await fixture();
    const requestInteraction = binding.manifest.interactions.find(
      (entry) => entry.mode === "request",
    )!;
    await expect(
      validateHandoffOutcomeAgainstManifest(binding.manifest, {
        version: 1,
        bindingDigest: binding.manifest.bindingDigest,
        installationId: binding.manifest.installationId,
        interactionId: requestInteraction.interactionId,
        expectedContractDigest: requestInteraction.expectedContractDigest,
        actualContractDigest: requestInteraction.actualContractDigest,
        mode: "request",
        realizationId: requestInteraction.realizationId,
        certainty: "not-started",
        result: { kind: "proposed", proposal: { proposalId: 42 } },
      }),
    ).rejects.toMatchObject({ code: "INVALID_OUTCOME" });
  });

  it("binds a checked seam without storing context, retrying, or following replacements", async () => {
    const { binding, controller, seen } = await fixture();
    const checked = await createCheckedHandoff(binding);
    const firstContext = { marker: {} };
    const secondContext = { marker: {} };
    const invocation = await createHandoffInvocation(
      checked.manifest,
      "handoff.ping",
      "direct",
      null,
    );
    await checked.invoke(invocation, firstContext);
    controller.revoke();
    const second = await checked.invoke(invocation, secondContext);

    expect(second).toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "revoked" },
    });
    expect(seen.direct).toBe(1);
    expect(seen.contexts).toEqual([firstContext, firstContext]);
  });

  it("keeps checked execution methods live on their original receiver", async () => {
    const { binding, seen } = await fixture();
    let resolves = true;
    const executable = Object.freeze({
      manifest: binding.manifest,
      resolve(interactionId: string) {
        expect(this).toBe(executable);
        return resolves ? binding.resolve(interactionId) : undefined;
      },
      invoke(...args: Parameters<typeof binding.invoke>) {
        expect(this).toBe(executable);
        return binding.invoke(...args);
      },
    });
    const checked = await createCheckedHandoff<Context>(executable);
    const invocation = await createHandoffInvocation(
      checked.manifest,
      "handoff.ping",
      "direct",
      null,
    );
    const first = { marker: {} };
    const second = { marker: {} };
    await checked.invoke(invocation, first);
    await checked.invoke(invocation, second);
    expect(seen.contexts[0]).toBe(first);
    expect(seen.contexts[1]).toBe(first);
    expect(seen.contexts[2]).toBe(second);
    expect(seen.contexts[3]).toBe(second);
    resolves = false;
    await expect(checked.invoke(invocation, second)).rejects.toMatchObject({
      code: "INTERACTION_NOT_EXPOSED",
    });
    expect(seen.admissions).toBe(2);
    expect(seen.direct).toBe(2);
  });

  it("rechecks shallow-frozen manifests with mutable nested content", async () => {
    const { binding, seen } = await fixture();
    const source = Object.freeze(copy(binding.manifest));
    const executable = Object.freeze({ ...binding, manifest: source });
    const checked = await createCheckedHandoff<Context>(executable);
    const invocation = await createHandoffInvocation(
      checked.manifest,
      "handoff.ping",
      "direct",
      null,
    );
    await checked.invoke(invocation, { marker: {} });
    (source.interactions[0] as { realizationId: string }).realizationId =
      "realization:mutated";
    await expect(
      checked.invoke(invocation, { marker: {} }),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    await expect(
      executeHandoff(executable, invocation, { marker: {} }),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    expect(seen.admissions).toBe(1);
    expect(seen.direct).toBe(1);
  });

  it.each(["replaceable", "accessor"] as const)(
    "rechecks an immutable manifest behind a %s property",
    async (property) => {
      const { binding, seen } = await fixture();
      const replaceable = { ...binding };
      let current = binding.manifest;
      const executable = property === "replaceable"
        ? replaceable
        : Object.freeze({
            ...binding,
            get manifest() {
              return current;
            },
          });
      const checked = await createCheckedHandoff<Context>(executable);
      const invocation = await createHandoffInvocation(
        checked.manifest,
        "handoff.ping",
        "direct",
        null,
      );
      await checked.invoke(invocation, { marker: {} });
      const forged = Object.freeze({
        ...binding.manifest,
        bindingDigest: `sha256:${"f".repeat(64)}` as const,
      });
      if (property === "replaceable") replaceable.manifest = forged;
      else current = forged;
      await expect(
        checked.invoke(invocation, { marker: {} }),
      ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
      expect(seen.admissions).toBe(1);
      expect(seen.direct).toBe(1);
    },
  );

  it("rejects malformed and stale checked invocations before admission", async () => {
    const { binding, seen } = await fixture();
    const checked = await createCheckedHandoff<Context>(binding);
    const invocation = await createHandoffInvocation(
      checked.manifest,
      "handoff.ping",
      "direct",
      null,
    );
    const malformed = checked.invoke(
      { ...invocation, extra: true } as HandoffInvocation,
      { marker: {} },
    );
    await expect(malformed).rejects.toMatchObject({ code: "INVALID_INVOCATION" });
    await expect(checked.invoke({
      ...invocation,
      expectedContractDigest: `sha256:${"f".repeat(64)}`,
    }, { marker: {} })).rejects.toMatchObject({ code: "STALE_CONTRACT" });
    expect(seen.admissions).toBe(0);
    expect(seen.direct).toBe(0);
  });

  it("preserves checked rejection order across interaction modes and conflicting pins", async () => {
    const { binding, seen } = await fixture();
    const checked = await createCheckedHandoff<Context>(binding);
    const invocation = await createHandoffInvocation(
      checked.manifest, "handoff.probe", "direct", { value: "hello" },
    );
    const digest = `sha256:${"f".repeat(64)}` as const;
    const cases: readonly [Partial<HandoffInvocation>, string, string][] = [
      [{ bindingDigest: digest, installationId: "installation:stale", interactionId: "handoff.absent" },
        "STALE_BINDING", "invocation.bindingDigest"],
      [{ installationId: "installation:stale", interactionId: "handoff.absent" },
        "STALE_INSTALLATION", "invocation.installationId"],
      [{ interactionId: "handoff.absent", mode: "request", expectedContractDigest: digest },
        "INTERACTION_NOT_EXPOSED", "invocation.interactionId"],
      [{ interactionId: "handoff.ping", mode: "request", expectedContractDigest: digest },
        "MODE_NOT_EXPOSED", "invocation.mode"],
      [{ expectedContractDigest: digest, realizationId: "realization:stale", input: { value: 42 } },
        "STALE_CONTRACT", "invocation.expectedContractDigest"],
      [{ realizationId: "realization:stale", input: { value: 42 } },
        "STALE_REALIZATION", "invocation.realizationId"],
    ];
    for (const [change, code, path] of cases) {
      await expect(checked.invoke({ ...invocation, ...change }, { marker: {} }))
        .rejects.toMatchObject({ code, path });
    }
    expect(seen.admissions).toBe(0);
    expect(seen.direct).toBe(0);
    expect(seen.requests).toBe(0);
  });

  it("selects exact checked direct and request modes and validates their remote results", async () => {
    const { binding, seen } = await fixture();
    const checked = await createCheckedHandoff<Context>(binding);
    const directInvocation = await createHandoffInvocation(
      checked.manifest, "handoff.probe", "direct", { value: "hello" },
    );
    const requestInvocation = await createHandoffInvocation(
      checked.manifest, "handoff.probe", "request", { value: "hello" },
    );
    const direct = await checked.invoke(directInvocation, { marker: {} });
    const request = await checked.invoke(requestInvocation, { marker: {} });
    expect(direct).toMatchObject({
      mode: "direct", realizationId: "realization:probe:direct:2",
      certainty: "completed", result: { kind: "returned", value: { echoed: "hello" } },
    });
    expect(request).toMatchObject({
      mode: "request", realizationId: "realization:probe:request:2",
      certainty: "not-started", result: { kind: "proposed", proposal: { proposalId: "proposal:hello" } },
    });
    await expect(validateHandoffOutcomeAgainstManifest(checked.manifest, direct)).resolves.toEqual(direct);
    await expect(validateHandoffOutcomeAgainstManifest(checked.manifest, request)).resolves.toEqual(request);
    await expect(validateHandoffOutcomeAgainstManifest(checked.manifest, {
      ...direct, result: { kind: "returned", value: { echoed: 42 } },
    })).rejects.toMatchObject({ code: "INVALID_OUTCOME", path: "outcome.result.value" });
    await expect(validateHandoffOutcomeAgainstManifest(checked.manifest, {
      ...request, result: { kind: "proposed", proposal: { proposalId: 42 } },
    })).rejects.toMatchObject({ code: "INVALID_OUTCOME", path: "outcome.result.proposal" });
    await expect(createHandoffInvocation(checked.manifest, "handoff.ping", "request", null))
      .rejects.toMatchObject({ code: "MODE_NOT_EXPOSED", path: "interaction" });
    await expect(createHandoffInvocation(checked.manifest, "handoff.absent", "direct", null))
      .rejects.toMatchObject({ code: "MODE_NOT_EXPOSED", path: "interaction" });
    expect(seen.admissions).toBe(2);
    expect(seen.direct).toBe(1);
    expect(seen.requests).toBe(1);
  });

  it("preserves remote outcome pin rejection order and missing-mode diagnostics", async () => {
    const { binding } = await fixture();
    const checked = await createCheckedHandoff<Context>(binding);
    const invocation = await createHandoffInvocation(
      checked.manifest, "handoff.probe", "direct", { value: "hello" },
    );
    const remote = {
      version: invocation.version,
      bindingDigest: invocation.bindingDigest,
      installationId: invocation.installationId,
      interactionId: invocation.interactionId,
      expectedContractDigest: invocation.expectedContractDigest,
      actualContractDigest: invocation.actualContractDigest,
      mode: invocation.mode,
      realizationId: invocation.realizationId,
      certainty: "unknown", result: { kind: "fault", cause: "realization-failed" },
    };
    const digest = `sha256:${"f".repeat(64)}` as const;
    const cases = [
      [{ bindingDigest: digest, installationId: "installation:stale", interactionId: "handoff.absent" },
        "STALE_BINDING", "outcome.bindingDigest"],
      [{ installationId: "installation:stale", interactionId: "handoff.absent" },
        "STALE_INSTALLATION", "outcome.installationId"],
      [{ interactionId: "handoff.ping", mode: "request", expectedContractDigest: digest },
        "INTERACTION_NOT_EXPOSED", "outcome.interactionId"],
      [{ expectedContractDigest: digest, realizationId: "realization:stale" },
        "STALE_CONTRACT", "outcome.expectedContractDigest"],
      [{ realizationId: "realization:stale" }, "STALE_REALIZATION", "outcome.realizationId"],
    ] as const;
    for (const [change, code, path] of cases) {
      await expect(validateHandoffOutcomeAgainstManifest(checked.manifest, { ...remote, ...change }))
        .rejects.toMatchObject({ code, path });
    }
  });

  it("keeps invalid checked Host outcomes unknown without retrying", async () => {
    const { binding, seen } = await fixture();
    const executable = Object.freeze({
      ...binding,
      async invoke(...args: Parameters<typeof binding.invoke>) {
        const outcome = await binding.invoke(...args);
        return {
          ...outcome,
          projectionDigest: `sha256:${"f".repeat(64)}` as const,
        };
      },
    });
    const checked = await createCheckedHandoff<Context>(executable);
    const invocation = await createHandoffInvocation(
      checked.manifest,
      "handoff.ping",
      "direct",
      null,
    );
    await expect(
      checked.invoke(invocation, { marker: {} }),
    ).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });
    expect(seen.admissions).toBe(1);
    expect(seen.direct).toBe(1);
  });
});
