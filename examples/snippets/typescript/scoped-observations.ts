/** In-process Fetch/SSE teaching fixture, with test identity and app-owned state. */
import { z } from "zod";
import { bindProjection, compileInteractions, defineInteraction, direct, directRealizationIds,
  implementInteractions, installInteractions, projectInteractions } from "@foxworth/boundary";
import type { InvocationObservation } from "@foxworth/boundary/program";
import { createObservationHttpHandler } from "@foxworth/boundary/http/observations";
import { createProtocolHandler, fetchTransport } from "@foxworth/boundary/http/protocol";
// #region imports
import { createInvocationState, createProjectionClient, pinProjectionReferences } from "@foxworth/boundary/client";
import { createInteractionCacheScope, watchInteraction } from "@foxworth/boundary/client/cache";
import { subscribeToObservations } from "@foxworth/boundary/client/observations";
// #endregion imports

type Todo = Readonly<{ id: number; title: string }>;
type Context = Readonly<{ role: "owner" }>;
const TodoSchema = z.strictObject({ id: z.number().int(), title: z.string() });
const interactions = {
  list: defineInteraction({ id: "todos.list", output: z.array(TodoSchema), reads: ["todos"] }),
  create: defineInteraction({
    id: "todos.create", input: z.strictObject({ title: z.string().min(1) }),
    output: TodoSchema, changes: ["todos"],
  }),
};

export async function createScopedObservationExample(
  render: (snapshot: Readonly<{ data: readonly Todo[] | undefined }>) => void,
) {
  const rows: Todo[] = [];
  const compiled = await compileInteractions(interactions);
  const projection = await projectInteractions(compiled, {
    list: direct(compiled.handles.list), create: direct(compiled.handles.create),
  });
  const implementations = implementInteractions<typeof interactions, Context>(interactions, {
    list: () => [...rows],
    create(input) {
      const todo = { id: rows.length + 1, title: input.title };
      rows.push(todo);
      return todo;
    },
  });
  const { installation } = await installInteractions(compiled, {
    installationId: "todos:scoped-observations:1", implementations,
    realizationIds: directRealizationIds(compiled, "release-1"),
  });
  const listeners = new Set<(event: InvocationObservation) => void>();
  const bound = await bindProjection(projection, installation, {
    admit: ({ context }) => context.role === "owner" ? { decision: "allow" } : { decision: "deny", reason: "owner required" },
    observation: { publish: (event) => { for (const send of listeners) send(event); } },
  });
  if (bound.status !== "bound") throw new Error("example did not bind", { cause: bound.report });
  // Test-only identity checked before dispatch; no production identity system is claimed.
  const context = (request: Request) => request.headers.get("authorization") === "Bearer test-owner"
    ? { role: "owner" as const } : new Response(null, { status: 401 });
  const protocol = createProtocolHandler({ binding: bound.binding, context: () => ({ role: "owner" as const }), path: "/boundary" });
  const events = createObservationHttpHandler({
    path: "/events", context,
    subscribe: (_, send) => { listeners.add(send); return () => { listeners.delete(send); }; },
  });
  const exampleFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const authenticated = context(request);
    if (authenticated instanceof Response) return authenticated;
    return await events(request) ?? await protocol(request);
  };
  const baseUrl = "http://boundary.test";
  const headers = { authorization: "Bearer test-owner" };
  const screenClient = createProjectionClient(fetchTransport({ baseUrl: `${baseUrl}/boundary`, headers, fetch: exampleFetch }));
  const otherClient = createProjectionClient(fetchTransport({ baseUrl: `${baseUrl}/boundary`, headers, fetch: exampleFetch }));
  const references = projection.handles;
  const observationOptions = { url: `${baseUrl}/events`, headers, fetch: exampleFetch };

  // #region client
  const handles = await pinProjectionReferences(screenClient, references);
  const scope = createInteractionCacheScope();
  const todos = watchInteraction(screenClient, handles.list, { scope });
  const stopRendering = todos.subscribe(() => render(todos.getSnapshot()));
  const createTodo = createInvocationState(screenClient, handles.create, "direct", { scope });
  const subscription = subscribeToObservations(screenClient, { ...observationOptions, scope });
  try {
    await subscription.ready;
  } catch (error) {
    disposeView();
    throw error;
  }
  // #endregion client

  async function addFromScreen() {
    // #region change
    // Invoke only from the application's explicit event handler.
    await createTodo.invoke({ title: "From screen" });
    // #endregion change
  }
  function disposeView() {
    // #region cleanup
    subscription.dispose();
    stopRendering();
    todos.dispose();
    createTodo.dispose();
    // #endregion cleanup
  }
  return {
    screenClient, otherClient, handles, todos, createTodo, subscription, rows,
    addFromScreen, disposeView,
    get subscriberCount() { return listeners.size; },
  };
}
