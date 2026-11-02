import { describe, expect, it } from "vitest";
import { portableSchema } from "@foxworth/boundary/program";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  installInteractions,
  projectInteractions,
  type NativeDispatchRequest,
  type NativeDispatchOutcome,
} from "../../packages/core/host/index";

const semanticFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../conformance/v1/host-lifecycle.json", import.meta.url),
    ),
    "utf8",
  ),
) as Readonly<{
  nativeDispatchOutcomes: readonly Readonly<{
    name: string;
    certainty: "not-started" | "not-completed" | "completed" | "unknown";
    resultKind: string;
  }>[];
}>;

const Input = portableSchema<{ readonly title: string }>({
  type: "object",
  properties: { title: { type: "string", minLength: 1 } },
  required: ["title"],
  additionalProperties: false,
});
const Output = portableSchema<{ readonly id: string; readonly title: string }>({
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string" } },
  required: ["id", "title"],
  additionalProperties: false,
});
const Rejected = portableSchema<{ readonly title: string }>({
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
});

const definitions = {
  create: defineInteraction({
    id: "native.outcome.create",
    input: Input,
    output: Output,
    errors: { rejected: Rejected },
    reads: ["native.outcomes"],
    changes: ["native.outcomes"],
  }),
} as const;

describe("native dispatch outcomes", () => {
  it("preserves host-owned outcomes and never retries dispatch", async () => {
    const compiled = await compileInteractions(definitions);
    let dispatches = 0;
    let effects = 0;
    expect(semanticFixtures.nativeDispatchOutcomes).toEqual([
      { name: "native-returned", certainty: "completed", resultKind: "returned" },
      { name: "native-declared-error", certainty: "completed", resultKind: "declared-error" },
      { name: "native-denied", certainty: "not-started", resultKind: "denied" },
      { name: "native-not-started", certainty: "not-started", resultKind: "fault" },
      { name: "native-not-completed", certainty: "not-completed", resultKind: "fault" },
      { name: "native-unknown", certainty: "unknown", resultKind: "fault" },
    ]);
    let behavior: (
      request: NativeDispatchRequest<typeof definitions.create, object, void>,
    ) => NativeDispatchOutcome<typeof definitions.create>;
    behavior = (request) => request.outcomes.returned({ id: "first", title: request.input.title });
    const target = {};
    const { installation, controller: installationController } = await installInteractions(
      compiled,
      {
        installationId: "native:outcomes:1",
        bindings: [{
          interaction: compiled.handles.create,
          target,
          dispatch(request) {
            dispatches += 1;
            return behavior(request);
          },
        }],
        realizationIds: { create: { direct: "native:outcomes:create:1" } },
      },
    );
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct"] },
    });
    const result = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    const caller = result.binding.connect();
    const interaction = result.binding.resolve("native.outcome.create")!;

    behavior = (request) => {
      effects += 1;
      return request.outcomes.returned({ id: "done", title: request.input.title });
    };
    await expect(caller.callRaw(interaction, { title: "done" })).resolves.toMatchObject({
      certainty: "completed",
      result: { kind: "returned", value: { id: "done", title: "done" } },
    });

    behavior = (request) => request.outcomes.declared("rejected", { title: request.input.title });
    await expect(caller.callRaw(interaction, { title: "rejected" })).resolves.toMatchObject({
      certainty: "completed",
      result: { kind: "declared-error", code: "rejected", details: { title: "rejected" } },
    });

    behavior = (request) => request.outcomes.denied("host.pre-effect-denial");
    await expect(caller.callRaw(interaction, { title: "denied" })).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "denied", code: "host.pre-effect-denial" },
    });
    expect(effects).toBe(1);

    behavior = (request) => request.outcomes.notStarted();
    await expect(caller.callRaw(interaction, { title: "not-started" })).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(effects).toBe(1);

    behavior = (request) => {
      effects += 1;
      return request.outcomes.notCompleted();
    };
    await expect(caller.callRaw(interaction, { title: "rollback" })).resolves.toMatchObject({
      certainty: "not-completed",
      result: { kind: "fault", cause: "realization-failed" },
    });

    behavior = (request) => {
      effects += 1;
      return request.outcomes.returned({ id: "bad", title: 42 } as never);
    };
    await expect(caller.callRaw(interaction, { title: "bad-output" })).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });

    behavior = (request) => {
      effects += 1;
      return request.outcomes.unknown();
    };
    await expect(caller.callRaw(interaction, { title: "unknown" })).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "realization-failed" },
    });

    behavior = () => {
      effects += 1;
      throw new Error("native exception after effect");
    };
    const beforeThrown = dispatches;
    await expect(caller.callRaw(interaction, { title: "throws" })).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(dispatches).toBe(beforeThrown + 1);

    const beforeInvalid = dispatches;
    await expect(caller.callRaw(interaction, { title: "" })).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "invalid-input" },
    });
    expect(dispatches).toBe(beforeInvalid);

    const replacement = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(replacement.status).toBe("bound");
    if (replacement.status !== "bound") return;
    const staleInteraction = replacement.binding.resolve("native.outcome.create")!;
    const beforeStale = dispatches;
    await expect(caller.callRaw(staleInteraction, { title: "stale" })).rejects.toMatchObject({
      cause: "invalid-invocation",
      certainty: "not-started",
    });
    expect(dispatches).toBe(beforeStale);

    expect(installationController.revoke()).toBe(true);
    const beforeRevoked = dispatches;
    await expect(caller.callRaw(interaction, { title: "revoked" })).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "revoked" },
    });
    expect(dispatches).toBe(beforeRevoked);
  });

  it("does not treat a plain outcome-shaped object as authority", async () => {
    const compiled = await compileInteractions(definitions);
    const { installation } = await installInteractions(compiled, {
      installationId: "native:outcomes:forged:1",
      bindings: [{
        interaction: compiled.handles.create,
        target: {},
        dispatch() {
          return { kind: "denied", code: "forged" } as never;
        },
      }],
      realizationIds: { create: { direct: "native:outcomes:forged:create:1" } },
    });
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct"] },
    });
    const result = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (result.status !== "bound") throw new Error("expected bound");
    const outcome = await result.binding.connect().callRaw(
      result.binding.resolve("native.outcome.create")!,
      { title: "forged" },
    );
    expect(outcome).toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });
  });

  it("rejects a retained outcome token from an earlier native invocation", async () => {
    const compiled = await compileInteractions(definitions);
    let cached: NativeDispatchOutcome<typeof definitions.create> | undefined;
    let effects = 0;
    const { installation } = await installInteractions(compiled, {
      installationId: "native:outcomes:retained:1",
      bindings: [{
        interaction: compiled.handles.create,
        target: {},
        dispatch(request) {
          if (!cached) {
            cached = request.outcomes.denied("native.first-call-denial");
            return cached;
          }
          effects += 1;
          return cached;
        },
      }],
      realizationIds: { create: { direct: "native:outcomes:retained:create:1" } },
    });
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct"] },
    });
    const first = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    const second = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (first.status !== "bound" || second.status !== "bound") {
      throw new Error("expected bound callers");
    }
    const firstOutcome = await first.binding.connect().callRaw(
      first.binding.resolve("native.outcome.create")!,
      { title: "first" },
    );
    expect(firstOutcome).toMatchObject({
      certainty: "not-started",
      result: { kind: "denied", code: "native.first-call-denial" },
    });
    const replayed = await second.binding.connect().callRaw(
      second.binding.resolve("native.outcome.create")!,
      { title: "second" },
    );
    expect(effects).toBe(1);
    expect(replayed).toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "invalid-realization-outcome" },
    });
  });
});
