import { compileInteractions, composeCompiledInteractions, implementInteractions } from "@foxworth/boundary/pipeline";
import {
  capacityModule,
  createModuleCompositionHost,
  hostDefinitions,
  taskModule,
  type Context,
  type InstalledCall,
} from "../../examples/snippets/typescript/module-composition";

async function selectedModuleInterfaces() {
  const host = await createModuleCompositionHost();
  const context: Context = { principal: "fox", projects: ["public"], mayMutate: true };
  host.compiled.handles.taskMutate.interactionId satisfies "tasks.mutate";
  host.compiled.handles.capacityMutate.interactionId satisfies "capacity.mutate";
  // @ts-expect-error explicit host aliases remain a closed record
  host.compiled.handles.mutate;
  host.localCompiled.tasks.handles.mutate.interactionId satisfies "tasks.mutate";
  host.localCompiled.capacity.handles.mutate.interactionId satisfies "capacity.mutate";
  // @ts-expect-error reader selection omits mutation
  host.projections.taskReader.handles.mutate;
  const task = await host.callers.taskEditor.call(
    host.projections.taskEditor.handles.mutate,
    { project: "public", task: "todo-1", completed: true }, context,
  );
  task.completed satisfies boolean;
  // @ts-expect-error task results do not acquire capacity fields
  task.limit;
  const capacity = await host.callers.capacityReader.call(
    host.projections.capacityReader.handles.query, { project: "public" }, context,
  );
  capacity.limit satisfies number;
  // @ts-expect-error selected task query input must carry its task
  await host.callers.taskReader.call(host.projections.taskReader.handles.query, { project: "public" }, context);
  // @ts-expect-error the read-only caller cannot accept a task mutation handle
  await host.callers.taskReader.call(host.projections.taskEditor.handles.mutate, { project: "public", task: "todo-1", completed: true }, context);
  // @ts-expect-error the task interface cannot accept a capacity handle
  await host.callers.taskEditor.call(host.projections.capacityReader.handles.query, { project: "public" }, context);

  const composed = await composeCompiledInteractions(
    await compileInteractions({ taskMutate: taskModule.mutate }),
    await compileInteractions({ capacityMutate: capacityModule.mutate }),
  );
  composed.handles.taskMutate.interactionId satisfies "tasks.mutate";
  composed.handles.capacityMutate.interactionId satisfies "capacity.mutate";
  // @ts-expect-error composition does not add undeclared aliases
  composed.handles.taskQuery;
}
void selectedModuleInterfaces;

function authorize(call: InstalledCall) {
  if (call.interaction === "tasks.mutate") {
    call.input.task satisfies string;
    call.input.completed satisfies boolean;
    // @ts-expect-error narrowed task mutation retains its own input
    call.input.limit;
  }
  if (call.interaction === "tasks.query") {
    call.input.task satisfies string;
    // @ts-expect-error queries carry no completion change
    call.input.completed;
  }
  if (call.interaction === "capacity.mutate") {
    call.input.limit satisfies number;
    // @ts-expect-error capacity mutations do not acquire task fields
    call.input.task;
  }
}
void authorize;

declare const context: Context;
// @ts-expect-error interaction and input stay correlated
const mismatchedCall: InstalledCall = { interaction: "tasks.mutate", input: { project: "public", limit: 2 }, context };
void mismatchedCall;

implementInteractions<typeof hostDefinitions, Context>(hostDefinitions, {
  // @ts-expect-error installation rejects the wrong task output
  taskMutate: () => ({ project: "public", limit: 2 }),
  taskQuery: input => ({ ...input, completed: false }),
  capacityMutate: input => input,
  capacityQuery: input => ({ ...input, limit: 2 }),
});
