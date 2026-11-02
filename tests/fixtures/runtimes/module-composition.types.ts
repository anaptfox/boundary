import { compileInteractions } from "@foxworth/boundary/pipeline";
import { type DefinitionInput } from "@foxworth/boundary";
import {
  capacityModule,
  createModuleCompositionHost,
  hostDefinitions,
  taskModule,
  type Context,
  type InstalledCall,
} from "../../../examples/snippets/typescript/module-composition.ts";

const context: Context = { principal: "fox", projects: ["public"], mayMutate: true };
const taskInput: DefinitionInput<typeof taskModule.mutate> = {
  project: "public", task: "todo-1", completed: true,
};
const capacityInput: DefinitionInput<typeof capacityModule.mutate> = { project: "public", limit: 2 };

function authorizationTypes(call: InstalledCall) {
  call.input.project satisfies string;
  if (call.interaction === "tasks.mutate") {
    call.input.completed satisfies boolean;
    call.input.task satisfies string;
    // @ts-expect-error the task interaction does not receive capacity input
    call.input.limit;
  }
  if (call.interaction === "tasks.query") {
    call.input.task satisfies string;
    // @ts-expect-error query input does not contain mutation fields
    call.input.completed;
  }
  if (call.interaction === "capacity.mutate") call.input.limit satisfies number;
  if (call.interaction === "capacity.query") {
    // @ts-expect-error capacity queries cannot access task input
    call.input.task;
  }
}

async function publicTypes() {
  const compiled = await compileInteractions(hostDefinitions);
  compiled.handles.taskMutate.interactionId satisfies "tasks.mutate";
  compiled.handles.capacityMutate.interactionId satisfies "capacity.mutate";
  // @ts-expect-error host aliases are explicit and closed
  compiled.handles.mutate;
  const host = await createModuleCompositionHost();
  const task = await host.callers.taskEditor.call(host.projections.taskEditor.handles.mutate, taskInput, context);
  task.completed satisfies boolean;
  task.task satisfies string;
  // @ts-expect-error task results do not contain capacity output
  task.limit;
  const capacity = await host.callers.capacityReader.call(host.projections.capacityReader.handles.query, { project: "public" }, context);
  capacity.limit satisfies number;
  // @ts-expect-error capacity results do not contain task output
  capacity.completed;
  // @ts-expect-error task readers only select query
  host.projections.taskReader.handles.mutate;
  // @ts-expect-error capacity readers only select query
  host.projections.capacityReader.handles.mutate;
  // @ts-expect-error task mutations require task input
  host.callers.taskEditor.call(host.projections.taskEditor.handles.mutate, capacityInput, context);
  // @ts-expect-error selected readers cannot execute an editor's handle
  host.callers.taskReader.call(host.projections.taskEditor.handles.mutate, taskInput, context);
  // @ts-expect-error authorization correlates interaction with input
  const wrong: InstalledCall = { interaction: "tasks.mutate", input: capacityInput, context };
  // @ts-expect-error authorization cannot introduce an unknown interaction
  const unknown: InstalledCall = { interaction: "tasks.erase", input: taskInput, context };
  void wrong;
  void unknown;
}
void authorizationTypes;
void publicTypes;
