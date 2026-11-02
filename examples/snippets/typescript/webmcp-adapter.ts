import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
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
  const compiled = await compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, Actor>(
    interactions,
    {
      list: () => [...rows],
      create: ({ title }) => {
        const todo = { id: rows.length + 1, title };
        rows.push(todo);
        return todo;
      },
    },
  );
  const { installation } = await installInteractions<typeof interactions, Actor>(
    compiled,
    {
      installationId: "docs:webmcp:1",
      implementations,
      realizationIds: {
        list: { direct: "docs:webmcp:list:1" },
        create: { direct: "docs:webmcp:create:1" },
      },
    },
  );
  const projection = await projectInteractions(compiled, {
    list: { interaction: compiled.handles.list, modes: ["direct"] },
    create: { interaction: compiled.handles.create, modes: ["direct"] },
  });
  const result = await bindProjection(projection, installation, {
    admit: ({ context, handle }) =>
      context.role === "owner" || handle.changes.length === 0
        ? { decision: "allow" }
        : { decision: "deny", reason: "viewer is read-only" },
  });
  if (result.status !== "bound") {
    throw new Error("the WebMCP example Binding could not be realized");
  }

  // #region explicit-webmcp
  const tools = [
    webMcpTool(projection.handles.list, { untrustedContentHint: true }),
    webMcpTool(projection.handles.create),
  ];
  const registration = isWebMcpAvailable(modelContext)
    ? await registerWebMcpBinding({
        binding: result.binding,
        tools,
        context: () => Object.freeze({ role: "owner" as const }),
        modelContext,
      })
    : undefined;
  // #endregion explicit-webmcp

  return {
    program: compiled.program,
    binding: result.binding,
    projection,
    registration,
    rows,
  };
}

export async function runWebMcpAdapterExample(modelContext: ModelContextPort) {
  const { registration } = await createTodoWebMcpExample(modelContext);
  return registration?.tools.map((entry) => entry.name) ?? [];
}
