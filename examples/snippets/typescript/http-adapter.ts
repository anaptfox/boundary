import { portableSchema } from "@foxworth/boundary/program";
import { admitWhen, defineInteraction, install, surface } from "@foxworth/boundary";
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
  const app = await install(interactions, {
    id: "todos:http:1",
    version: "http-1",
    handlers: {
      list: (_actor: Actor) => [...rows],
      create(input, _actor: Actor) {
        const todo = { id: rows.length + 1, title: input.title };
        rows.push(todo);
        return todo;
      },
    },
  });
  const todos = await app.connect(surface.all(interactions), {
    admit: admitWhen((actor: Actor) => actor.role === "owner", "owner role required"),
  });

  // #region explicit-http
  const routes = [
    route(todos, "list", { method: "GET", path: "/todos" }),
    route(todos, "create", {
      method: "POST",
      path: "/todos",
      successStatus: 201,
    }),
  ];

  const handler = createHttpHandler<Actor>({
    caller: todos,
    context: request => ({
      id: request.headers.get("x-user") ?? "anonymous",
      role: request.headers.get("x-role") === "owner" ? "owner" : "viewer",
    } as Actor),
    routes,
  });
  // #endregion explicit-http

  return {
    program: app.program,
    installation: app.installation,
    caller: todos,
    binding: app.binding(todos),
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
