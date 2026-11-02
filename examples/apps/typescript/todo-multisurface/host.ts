import {
  admitWhen,
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  pickProjection,
  projectAllDirect,
} from "@foxworth/boundary";
import { createCaller } from "@foxworth/boundary/pipeline";
import { interactions } from "./interactions";
import { createTodoStore, type TodoStore } from "./store";
import { observedRead } from "@foxworth/boundary/observations";
import { todoSnapshots } from "./observations";

export type TodoCaller = Readonly<{ kind: "screen" | "agent"; actorId: string }>;

const screenContext: TodoCaller = { kind: "screen", actorId: "ada" };
const agentContext: TodoCaller = { kind: "agent", actorId: "agent-7" };

export async function createTodoHost(store: TodoStore = createTodoStore()) {
  const compiled = await compileInteractions(interactions);
  const screen = await projectAllDirect(compiled);
  const agent = await pickProjection(screen, "list", "complete", "reopen");
  const readStats = { evaluations: 0, reuses: 0, validations: 0 };
  const implementations = implementInteractions<typeof interactions, TodoCaller>(
    interactions,
    {
      list: observedRead(interactions.list, {
        snapshots: todoSnapshots(store),
        scope: (context) => ({ kind: context.kind, actorId: context.actorId }),
        authorize() {}, // Binding owns this host's caller admission.
        evaluate: async (_input, view) => [...await view.query({ completed: null, order: "stored", offset: 0, limit: null })],
        reuse: "validated",
        diagnostic(event) {
          if (event.reused) readStats.reuses++;
          else readStats.evaluations++;
          readStats.validations += event.validations;
        },
      }),
      create(input) {
        if (store.hasTitle(input.title)) {
          throw declaredInteractionError(interactions.create, "duplicateTitle", {
            title: input.title,
          });
        }
        return store.create(input.title);
      },
      complete(input) {
        const completed = store.complete(input.id);
        if (!completed) {
          throw declaredInteractionError(interactions.complete, "notFound", {
            id: input.id,
          });
        }
        return completed;
      },
      reopen(input) {
        const opened = store.reopen(input.id);
        if (!opened) {
          throw declaredInteractionError(interactions.reopen, "notFound", {
            id: input.id,
          });
        }
        return opened;
      },
      clear() {
        return store.clear();
      },
    },
  );
  const { installation } = await installInteractions<typeof interactions, TodoCaller>(
    compiled,
    {
      installationId: "todos:local:v1",
      implementations,
      realizationIds: directRealizationIds(compiled, "v1"),
    },
  );

  const screenResult = await bindProjection(screen, installation, {
    admit: admitWhen((ctx: TodoCaller) => ctx.kind === "screen", "screen only"),
  });
  const agentResult = await bindProjection(agent, installation, {
    admit: admitWhen((ctx: TodoCaller) => ctx.kind === "agent", "agent only"),
  });
  if (screenResult.status !== "bound" || agentResult.status !== "bound") {
    throw new Error("the Todo host did not realize both caller surfaces");
  }

  return {
    interactions,
    compiled,
    store,
    get readStats() { return Object.freeze({ ...readStats }); },
    screen,
    agent,
    installation,
    screenBinding: screenResult.binding,
    agentBinding: agentResult.binding,
    screenCaller: createCaller(screenResult.binding),
    agentCaller: createCaller(agentResult.binding),
    screenContext,
    agentContext,
  };
}

export type TodoHost = Awaited<ReturnType<typeof createTodoHost>>;
