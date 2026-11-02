import { describe, expect, it } from "vitest";
import {
  compileInteractions,
  composeCompiledInteractions,
  declaredInteractionError,
  type ImplementationMap,
} from "@foxworth/boundary";
import {
  capacityModule,
  createModuleCompositionHost,
  runModuleCompositionScenario,
  taskModule,
  type Context,
} from "../../examples/snippets/typescript/module-composition";

const styles = ["ordinary", "native"] as const;
const context: Context = { principal: "fox", projects: ["public"], mayMutate: true };
const input = { project: "public", task: "todo-1", completed: true };

describe("module composition recipe", () => {
  it.each(styles)("%s: local selected interfaces bind to one installation by identity", async style => {
    const scenario = await runModuleCompositionScenario(style);
    const { host } = scenario;
    expect(Object.keys(host.compiled.handles)).toEqual([
      "taskMutate", "taskQuery", "capacityMutate", "capacityQuery",
    ]);
    expect(Object.keys(host.localCompiled.tasks.handles)).toEqual(["mutate", "query"]);
    expect(Object.keys(host.localCompiled.capacity.handles)).toEqual(["mutate", "query"]);
    expect(Object.keys(host.projections.taskReader.handles)).toEqual(["query"]);
    expect(Object.keys(host.projections.capacityReader.handles)).toEqual(["query"]);
    expect(host.localCompiled.tasks.handles.mutate.contractDigest)
      .toBe(host.compiled.handles.taskMutate.contractDigest);
    expect(host.localCompiled.tasks.program.programDigest)
      .not.toBe(host.compiled.program.programDigest);
    for (const binding of Object.values(host.bindings)) {
      expect(binding.manifest.installationId).toBe("modules:local:v1");
      expect(binding.manifest.installationDigest).toBe(host.installation.manifest.installationDigest);
    }
    expect(scenario.before.completed).toBe(false);
    expect(scenario.completed).toEqual(input);
    expect(scenario.after.completed).toBe(true);
    expect(scenario.capacity).toEqual({ project: "public", limit: 2 });
    expect(scenario.denied).toMatchObject({
      certainty: "not-started", result: { kind: "denied", code: "CALL_NOT_ADMITTED" },
    });
    expect(host.telemetry.dispatches).toHaveLength(4);
    expect(host.telemetry.admissions).toHaveLength(5);
    for (const dispatch of host.telemetry.dispatches) expect(dispatch.context).toBe(scenario.context);
    for (const admission of host.telemetry.admissions) expect(admission.context).toBe(scenario.context);
  });

  it.each(styles)("%s: validates before input-sensitive policy and denies without dispatch", async style => {
    const host = await createModuleCompositionHost({ style });
    const mutation = host.bindings.taskEditor.resolve(taskModule.mutate.id)!;
    const denied = await host.callers.taskEditor.callRaw(mutation, {
      ...input, project: "secret",
    }, context);
    expect(denied).toMatchObject({ certainty: "not-started", result: { kind: "denied" } });
    expect(host.telemetry.admissions[0]!.input).toEqual({ ...input, project: "secret" });
    expect(host.telemetry.dispatches).toHaveLength(0);

    const queryOnly: Context = { ...context, mayMutate: false };
    await expect(host.callers.taskEditor.callRaw(mutation, input, queryOnly)).resolves.toMatchObject({
      certainty: "not-started", result: { kind: "denied" },
    });
    expect(host.telemetry.dispatches).toHaveLength(0);

    const beforeInvalid = host.telemetry.admissions.length;
    await expect(host.callers.taskEditor.callRaw(mutation, {
      ...input, completed: "invalid",
    }, context)).resolves.toMatchObject({
      certainty: "not-started", result: { kind: "fault", cause: "invalid-input" },
    });
    expect(host.telemetry.admissions).toHaveLength(beforeInvalid);
    expect(host.telemetry.dispatches).toHaveLength(0);
    await expect(host.callers.taskReader.call(
      host.projections.taskReader.handles.query, { project: "public", task: "todo-1" }, queryOnly,
    )).resolves.toMatchObject({ completed: false });
    expect(host.telemetry.dispatches).toHaveLength(1);
  });

  it.each(styles)("%s: excludes omitted and foreign handles before policy or dispatch", async style => {
    const host = await createModuleCompositionHost({ style });
    const other = await createModuleCompositionHost({ style });
    // Deliberately bypass the static selected-interface check to test runtime narrowing.
    const unsafeReader = host.callers.taskReader as typeof host.callers.taskEditor;
    await expect(unsafeReader.call(
      host.projections.taskEditor.handles.mutate, input, context,
    )).rejects.toMatchObject({ cause: "invalid-invocation", certainty: "not-started" });
    await expect(host.callers.taskReader.call(
      other.projections.taskReader.handles.query, { project: "public", task: "todo-1" }, context,
    )).rejects.toMatchObject({ cause: "invalid-invocation", certainty: "not-started" });
    await expect(host.callers.taskReader.callRaw(
      host.bindings.taskEditor.resolve(taskModule.mutate.id)!, input, context,
    )).rejects.toMatchObject({ cause: "invalid-invocation", certainty: "not-started" });
    expect(host.telemetry.admissions).toHaveLength(0);
    expect(host.telemetry.dispatches).toHaveLength(0);
    expect(other.telemetry.dispatches).toHaveLength(0);
  });

  it("rejects repeated compiled aliases and repeated interaction IDs before installation", async () => {
    await expect(composeCompiledInteractions(
      await compileInteractions(taskModule), await compileInteractions(capacityModule),
    )).rejects.toMatchObject({ code: "DUPLICATE_INTERACTION_ALIAS", path: "interactions.mutate" });
    await expect(composeCompiledInteractions(
      await compileInteractions({ taskMutate: taskModule.mutate }),
      await compileInteractions({ anotherAlias: taskModule.mutate }),
    )).rejects.toMatchObject({ code: "DUPLICATE_INTERACTION_ID" });
  });

  type Mutation = ImplementationMap<typeof taskModule, Context>["mutate"];
  const cases: readonly Readonly<{
    name: string;
    mutate: Mutation;
    certainty: string;
    result: object;
  }>[] = [
    {
      name: "valid return", mutate: value => value, certainty: "completed",
      result: { kind: "returned", value: input },
    },
    {
      name: "authentic declared error",
      mutate: value => {
        throw declaredInteractionError(taskModule.mutate, "missing", {
          project: value.project, task: value.task,
        });
      },
      certainty: "completed",
      result: { kind: "declared-error", code: "missing", details: { project: "public", task: "todo-1" } },
    },
    {
      name: "invalid output", mutate: value => ({ ...value, completed: "invalid" }) as never,
      certainty: "unknown", result: { kind: "fault", cause: "invalid-realization-outcome" },
    },
    {
      name: "unexpected exception", mutate: () => { throw new Error("acknowledgement lost"); },
      certainty: "unknown", result: { kind: "fault", cause: "realization-failed" },
    },
  ];

  it.each(cases)("ordinary and native dispatch agree for $name without retries", async scenario => {
    const results = [];
    for (const style of styles) {
      let effects = 0;
      const host = await createModuleCompositionHost({
        style,
        taskMutation(value, received) {
          effects += 1;
          expect(received).toBe(context);
          return scenario.mutate(value, received);
        },
      });
      const outcome = await host.callers.taskEditor.callRaw(
        host.bindings.taskEditor.resolve(taskModule.mutate.id)!, input, context,
      );
      expect(outcome).toMatchObject({ certainty: scenario.certainty, result: scenario.result });
      expect(effects).toBe(1);
      expect(host.telemetry.dispatches).toHaveLength(1);
      expect(host.telemetry.admissions).toHaveLength(1);
      expect(host.telemetry.admissions[0]!.context).toBe(context);
      results.push(outcome);
    }
    expect(results[0]).toEqual(results[1]);
  });
});
