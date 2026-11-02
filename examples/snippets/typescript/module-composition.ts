// #region imports
import { declaredInteractionError, defineInteraction, type DefinitionInput, type InteractionDefinitions, type Admission, type AdmissionRequest, surface } from "@foxworth/boundary";
import { bindNativeInteractions, bindSurface, compileInteractions, composeCompiledInteractions, implementInteractions, installInteractions, type ImplementationMap, realizationIdsFor, projectSurface } from "@foxworth/boundary/pipeline";
import { portableSchema } from "@foxworth/boundary/program";
// #endregion imports

const TaskInput = portableSchema<{
  readonly project: string;
  readonly task: string;
  readonly completed: boolean;
}>({
  type: "object",
  properties: {
    project: { type: "string", minLength: 1 },
    task: { type: "string", minLength: 1 },
    completed: { type: "boolean" },
  },
  required: ["project", "task", "completed"],
  additionalProperties: false,
});
const TaskQuery = portableSchema<{
  readonly project: string;
  readonly task: string;
}>({
  type: "object",
  properties: {
    project: { type: "string", minLength: 1 },
    task: { type: "string", minLength: 1 },
  },
  required: ["project", "task"],
  additionalProperties: false,
});
const Task = TaskInput;
const CapacityInput = portableSchema<{
  readonly project: string;
  readonly limit: number;
}>({
  type: "object",
  properties: {
    project: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 0 },
  },
  required: ["project", "limit"],
  additionalProperties: false,
});
const CapacityQuery = portableSchema<{ readonly project: string }>({
  type: "object",
  properties: { project: { type: "string", minLength: 1 } },
  required: ["project"],
  additionalProperties: false,
});

// #region modules
// Module-local aliases may repeat; the host-owned interaction IDs do not.
export const taskModule = {
  mutate: defineInteraction({
    id: "tasks.mutate",
    input: TaskInput,
    output: Task,
    errors: { missing: TaskQuery },
    reads: ["tasks"],
    changes: ["tasks"],
  }),
  query: defineInteraction({
    id: "tasks.query",
    input: TaskQuery,
    output: Task,
    errors: { missing: TaskQuery },
    reads: ["tasks"],
  }),
} as const;

export const capacityModule = {
  mutate: defineInteraction({
    id: "capacity.mutate",
    input: CapacityInput,
    output: CapacityInput,
    reads: ["capacity"],
    changes: ["capacity"],
  }),
  query: defineInteraction({
    id: "capacity.query",
    input: CapacityQuery,
    output: CapacityInput,
    reads: ["capacity"],
  }),
} as const;
// #endregion modules

export type Context = Readonly<{
  principal: string;
  projects: readonly string[];
  mayMutate: boolean;
}>;
export type DispatchStyle = "ordinary" | "native";

// #region authorization-types
export type ModuleCalls<Definitions extends InteractionDefinitions> = {
  [Alias in keyof Definitions & string]: Readonly<{
    interaction: Definitions[Alias]["id"];
    input: DefinitionInput<Definitions[Alias]>;
    context: Context;
  }>;
}[keyof Definitions & string];
export type InstalledCall =
  | ModuleCalls<typeof taskModule>
  | ModuleCalls<typeof capacityModule>;
// #endregion authorization-types

export const hostDefinitions = {
  taskMutate: taskModule.mutate,
  taskQuery: taskModule.query,
  capacityMutate: capacityModule.mutate,
  capacityQuery: capacityModule.query,
} as const;

export async function createModuleCompositionHost(options: Readonly<{
  style?: DispatchStyle;
  taskMutation?: ImplementationMap<typeof taskModule, Context>["mutate"];
}> = {}) {
  // #region assembly
  const tasks = await compileInteractions({
    taskMutate: taskModule.mutate,
    taskQuery: taskModule.query,
  });
  const capacity = await compileInteractions({
    capacityMutate: capacityModule.mutate,
    capacityQuery: capacityModule.query,
  });
  const compiled = await composeCompiledInteractions(tasks, capacity);
  // #endregion assembly

  const taskState = new Map<string, DefinitionInput<typeof taskModule.mutate>>([
    ["public:todo-1", { project: "public", task: "todo-1", completed: false }],
  ]);
  const capacityState = new Map([["public", 2]]);
  const telemetry = {
    dispatches: [] as InstalledCall[],
    admissions: [] as AdmissionRequest<Context>[],
  };
  const targets = {
    taskMutate(input, context) {
      telemetry.dispatches.push({ interaction: taskModule.mutate.id, input, context });
      if (options.taskMutation !== undefined) return options.taskMutation(input, context);
      const key = `${input.project}:${input.task}`;
      if (!taskState.has(key)) {
        throw declaredInteractionError(taskModule.mutate, "missing", {
          project: input.project, task: input.task,
        });
      }
      taskState.set(key, input);
      return input;
    },
    taskQuery(input, context) {
      telemetry.dispatches.push({ interaction: taskModule.query.id, input, context });
      const task = taskState.get(`${input.project}:${input.task}`);
      if (task === undefined) throw declaredInteractionError(taskModule.query, "missing", input);
      return task;
    },
    capacityMutate(input, context) {
      telemetry.dispatches.push({ interaction: capacityModule.mutate.id, input, context });
      capacityState.set(input.project, input.limit);
      return input;
    },
    capacityQuery(input, context) {
      telemetry.dispatches.push({ interaction: capacityModule.query.id, input, context });
      return { project: input.project, limit: capacityState.get(input.project) ?? 0 };
    },
  } satisfies ImplementationMap<typeof hostDefinitions, Context>;
  const identity = {
    installationId: "modules:local:v1",
    realizationIds: realizationIdsFor(compiled, "v1"),
  };

  const installed = options.style === "native"
    ? await installNative()
    : await installOrdinary();

  async function installOrdinary() {
    // #region ordinary-installation
    const implementations = implementInteractions<typeof hostDefinitions, Context>(
      hostDefinitions, targets,
    );
    return installInteractions<typeof hostDefinitions, Context>(compiled, {
      ...identity, implementations,
    });
    // #endregion ordinary-installation
  }

  async function installNative() {
    // #region native-installation
    const bindings = bindNativeInteractions<typeof hostDefinitions, typeof targets, Context>(
      compiled, targets, {
        taskMutate: async ({ target, input, context, outcomes }) =>
          outcomes.returned(await target(input, context)),
        taskQuery: ({ target, input, context, outcomes }) =>
          outcomes.returned(target(input, context)),
        capacityMutate: ({ target, input, context, outcomes }) =>
          outcomes.returned(target(input, context)),
        capacityQuery: ({ target, input, context, outcomes }) =>
          outcomes.returned(target(input, context)),
      },
    );
    return installInteractions<typeof hostDefinitions, Context>(compiled, {
      ...identity, bindings,
    });
    // #endregion native-installation
  }

  // #region selected-surfaces
  const localCompiled = {
    tasks: await compileInteractions(taskModule),
    capacity: await compileInteractions(capacityModule),
  };
  const taskEditor = await projectSurface(localCompiled.tasks, surface.all(taskModule));
  const taskReader = await projectSurface(localCompiled.tasks, surface(taskModule, { call: ["query"] }));
  const capacityReader = await projectSurface(localCompiled.capacity, surface(capacityModule, { call: ["query"] }));
  // #endregion selected-surfaces

  // #region admission
  const admit: Admission<Context> = request => {
    // Binding validated input before admission. Match the installed ID and
    // both contract digests before restoring this host's correlated union.
    const known = Object.values(compiled.handles).some(handle =>
      handle.interactionId === request.handle.interactionId &&
      handle.contractDigest === request.handle.expectedContractDigest &&
      handle.contractDigest === request.handle.actualContractDigest,
    );
    if (!known) return { decision: "deny", reason: "unknown module contract" };
    const call = {
      interaction: request.handle.interactionId,
      input: request.input,
      context: request.context,
    } as InstalledCall;
    telemetry.admissions.push(request);
    if (!call.context.projects.includes(call.input.project)) {
      return { decision: "deny", reason: "project is outside the principal's scope" };
    }
    if ((call.interaction === "tasks.mutate" || call.interaction === "capacity.mutate") &&
        !call.context.mayMutate) {
      return { decision: "deny", reason: "principal may only query" };
    }
    return { decision: "allow" };
  };
  // #endregion admission

  // #region binding
  const taskEditorResult = await bindSurface(taskEditor, installed.installation, { admit });
  const taskReaderResult = await bindSurface(taskReader, installed.installation, { admit });
  const capacityReaderResult = await bindSurface(capacityReader, installed.installation, { admit });
  if (taskEditorResult.status !== "bound" || taskReaderResult.status !== "bound" ||
      capacityReaderResult.status !== "bound") {
    throw new Error("the selected module interfaces did not bind to the installation");
  }
  // #endregion binding

  const bindings = {
    taskEditor: taskEditorResult.binding,
    taskReader: taskReaderResult.binding,
    capacityReader: capacityReaderResult.binding,
  };
  return {
    compiled,
    localCompiled,
    installation: installed.installation,
    projections: { taskEditor, taskReader, capacityReader },
    bindings,
    callers: {
      taskEditor: bindings.taskEditor.connect(),
      taskReader: bindings.taskReader.connect(),
      capacityReader: bindings.capacityReader.connect(),
    },
    telemetry,
  };
}

export async function runModuleCompositionScenario(style: DispatchStyle = "ordinary") {
  const host = await createModuleCompositionHost({ style });
  // #region invocation
  const context: Context = { principal: "fox", projects: ["public"], mayMutate: true };
  const before = await host.callers.taskReader.call(
    host.projections.taskReader.handles.query, { project: "public", task: "todo-1" }, context,
  );
  const completed = await host.callers.taskEditor.call(
    host.projections.taskEditor.handles.mutate,
    { project: "public", task: "todo-1", completed: true }, context,
  );
  const after = await host.callers.taskReader.call(
    host.projections.taskReader.handles.query, { project: "public", task: "todo-1" }, context,
  );
  const capacity = await host.callers.capacityReader.call(
    host.projections.capacityReader.handles.query, { project: "public" }, context,
  );
  // #endregion invocation
  const mutation = host.bindings.taskEditor.resolve(taskModule.mutate.id)!;
  const denied = await host.callers.taskEditor.callRaw(mutation, {
    project: "secret", task: "todo-1", completed: true,
  }, context);
  return { host, context, before, completed, after, capacity, denied };
}
