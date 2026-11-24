import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createHttpHandler, route } from "@foxworth/boundary/http";

type Actor = Readonly<{ id: string; role: "owner" | "viewer" }>;
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

const interactions = {
  list: defineInteraction({
    id: "todos.list",
    output: portableSchema<readonly Todo[]>({ type: "array", items: TodoSchema }),
    reads: ["todos"],
    changes: [],
  }),
  create: defineInteraction({
    id: "todos.create",
    input: portableSchema<{ readonly title: string }>({
      type: "object",
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
      additionalProperties: false,
    }),
    output: TodoSchema,
    reads: [],
    changes: ["todos"],
  }),
} as const;

export async function createTodoHttpExample() {
  const rows: Todo[] = [];
  const compiled = compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, Actor>(interactions, {
    list: () => [...rows],
    create(input) {
      const todo = { id: rows.length + 1, title: input.title };
      rows.push(todo);
      return todo;
    },
  });
  const { installation } = installInteractions<typeof interactions, Actor>(compiled, {
    installationId: "todos:http:1",
    implementations,
    realizationIds: {
      list: { direct: "todos:list:http:1" },
      create: { direct: "todos:create:http:1" },
    },
  });
  const projection = projectInteractions(compiled, {
    list: { interaction: compiled.handles.list, modes: ["direct"] },
    create: { interaction: compiled.handles.create, modes: ["direct"] },
  });
  const result = bindProjection(projection, installation, {
    admit({ context, handle }) {
      return context.role === "owner" || handle.changes.length === 0
        ? { decision: "allow" }
        : { decision: "deny", reason: "owner role required" };
    },
  });
  if (result.status !== "bound") {
    throw new Error("the HTTP Projection is unrealized");
  }

  // #region explicit-http
  const routes = [
    route(projection.handles.list, { method: "GET", path: "/todos" }),
    route(projection.handles.create, {
      method: "POST",
      path: "/todos",
      successStatus: 201,
    }),
  ];

  const handler = createHttpHandler<Actor>({
    binding: result.binding,
    context: request => ({
      id: request.headers.get("x-user") ?? "anonymous",
      role: request.headers.get("x-role") === "owner" ? "owner" : "viewer",
    } as Actor),
    routes,
  });
  // #endregion explicit-http

  return {
    program: compiled.program,
    installation,
    projection,
    binding: result.binding,
    handler,
    rows,
    routes,
  };
}

export async function runHttpAdapterExample() {
  const { handler } = await createTodoHttpExample();
  const response = await handler(new Request("https://example.test/todos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-role": "owner",
      "x-user": "fox",
    },
    body: JSON.stringify({ title: "Through HTTP" }),
  }));
  return { status: response.status, body: await response.json() };
}
