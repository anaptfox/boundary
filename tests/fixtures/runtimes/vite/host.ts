import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  admitAll,
  bindProjection,
  compileInteractions,
  defineInteraction,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createHttpHandler, route } from "@foxworth/boundary/http";

const todo = z.strictObject({
  id: z.number().int(),
  title: z.string(),
  completed: z.boolean(),
});

const interactions = {
  list: defineInteraction({
    id: "vite.todos.list",
    description: "List persisted Vite-native todos.",
    output: z.array(todo),
    reads: ["vite.todos"],
    changes: [],
  }),
  create: defineInteraction({
    id: "vite.todos.create",
    description: "Create a persisted Vite-native todo.",
    input: z.strictObject({ title: z.string().min(1) }),
    output: todo,
    reads: ["vite.todos"],
    changes: ["vite.todos"],
  }),
} as const;

type Todo = z.infer<typeof todo>;

async function loadTodos(path: string): Promise<Todo[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Todo[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function createViteTodoHost(statePath: string) {
  const todos = await loadTodos(statePath);
  let nextId = Math.max(0, ...todos.map((item) => item.id)) + 1;
  const persist = () => writeFile(statePath, JSON.stringify(todos), "utf8");
  const compiled = compileInteractions(interactions);
  const projection = projectInteractions(compiled, {
    list: { interaction: compiled.handles.list, modes: ["direct"] },
    create: { interaction: compiled.handles.create, modes: ["direct"] },
  });
  const implementations = implementInteractions(interactions, {
    list: () => [...todos],
    async create(input) {
      const created = { id: nextId++, title: input.title, completed: false };
      todos.push(created);
      await persist();
      return created;
    },
  });
  const { installation } = installInteractions(compiled, {
    installationId: "vite-native:todos:v1",
    implementations,
    realizationIds: directRealizationIds(compiled, "vite-native"),
  });
  const result = bindProjection(projection, installation, { admit: admitAll });
  if (result.status !== "bound") throw new Error("Vite native todo projection did not bind");
  return {
    handler: createHttpHandler({
      binding: result.binding,
      context: () => undefined,
      routes: [
        route(projection.handles.list, { method: "GET", path: "/todos" }),
        route(projection.handles.create, { method: "POST", path: "/todos" }),
      ],
    }),
  };
}
