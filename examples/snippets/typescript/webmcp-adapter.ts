import { portableSchema } from "@foxworth/boundary/program";
import { admitWhen, defineInteraction, install, surface } from "@foxworth/boundary";
import {
  isWebMcpAvailable,
  registerWebMcpBinding,
  webMcpTool,
  type ModelContextPort,
} from "@foxworth/boundary/webmcp";

type Actor = Readonly<{ role: "owner" | "viewer" }>;
type Todo = Readonly<{ id: number; title: string }>;

const TodoSchema = portableSchema<Todo>({
  type: "object",
  properties: {
    id: { type: "integer" },
    title: { type: "string" },
  },
  required: ["id", "title"],
  additionalProperties: false,
});
const TodoListSchema = portableSchema<readonly Todo[]>({
  type: "array",
  items: TodoSchema,
});
const CreateTodoSchema = portableSchema<Readonly<{ title: string }>>({
  type: "object",
  properties: { title: { type: "string", minLength: 1 } },
  required: ["title"],
  additionalProperties: false,
});

const interactions = {
  list: defineInteraction({
    id: "todos.list",
    output: TodoListSchema,
    reads: ["todos"],
    changes: [],
    description: "Read the current todo collection.",
  }),
  create: defineInteraction({
    id: "todos.create",
    input: CreateTodoSchema,
    output: TodoSchema,
    reads: [],
    changes: ["todos"],
    description: "Create one todo with a non-empty title.",
  }),
} as const;

export async function createTodoWebMcpExample(modelContext: ModelContextPort) {
  const rows: Todo[] = [];
  const app = await install(interactions, {
    id: "docs:webmcp:1",
    version: "webmcp-1",
    handlers: {
      list: (_actor: Actor) => [...rows],
      create: ({ title }, _actor: Actor) => {
        const todo = { id: rows.length + 1, title };
        rows.push(todo);
        return todo;
      },
    },
  });
  const todos = await app.connect(surface.all(interactions), {
    admit: admitWhen((actor: Actor) => actor.role === "owner", "viewer is read-only"),
  });

  // #region explicit-webmcp
  const tools = [
    webMcpTool(todos, "list", { untrustedContentHint: true }),
    webMcpTool(todos, "create"),
  ];
  const registration = isWebMcpAvailable(modelContext)
    ? await registerWebMcpBinding({
        caller: todos,
        tools,
        context: () => Object.freeze({ role: "owner" as const }),
        modelContext,
      })
    : undefined;
  // #endregion explicit-webmcp

  return {
    program: app.program,
    caller: todos,
    binding: app.binding(todos),
    registration,
    rows,
  };
}

export async function runWebMcpAdapterExample(modelContext: ModelContextPort) {
  const { registration } = await createTodoWebMcpExample(modelContext);
  return registration?.tools.map((entry) => entry.name) ?? [];
}
