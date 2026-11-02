/**
 * An additional Todo lifecycle example with two callers and refusal cases.
 * Executed by tests/typescript/docs-examples.test.ts.
 */
// #region setup
import { z } from "zod";
import { admitWhen, declaredInteractionError, defineInteraction, isDeclaredInteractionError, InteractionFault, surface } from "@foxworth/boundary";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectSurface, realizationIdsFor } from "@foxworth/boundary/pipeline";
import { interactions } from "./readme";

type Actor = { kind: "screen" | "agent"; actorId: string };
type Todo = { id: number; title: string; done: boolean };
// #endregion setup

export async function runWalkthroughExample() {
  const todos = new Map<number, Todo>([
    [1, { id: 1, title: "Ship Boundary", done: false }],
    [2, { id: 2, title: "Teach Boundary", done: false }],
  ]);

  // #region project
  const compiled = await compileInteractions(interactions);

  const screen = await projectSurface(compiled, surface.all(interactions));
  const agent = await projectSurface(compiled, surface(interactions, { call: ["complete"] }));
  // #endregion project

  // #region install
  const implementations = implementInteractions<typeof interactions, Actor>(interactions, {
    complete(input) {
      const todo = todos.get(input.id);
      if (!todo) throw declaredInteractionError(interactions.complete, "notFound", input);
      const done = { ...todo, done: true };
      todos.set(input.id, done);
      return done;
    },
    clear() {
      const removed = todos.size;
      todos.clear();
      return { removed };
    },
  });

  const { installation, controller } = await installInteractions<typeof interactions, Actor>(
    compiled,
    {
      installationId: "todos:local:v1",
      implementations,
      realizationIds: realizationIdsFor(compiled, "v1"),
    },
  );
  // #endregion install

  // #region bind
  const screenBound = await bindSurface(screen, installation, {
    admit: admitWhen((actor) => actor.kind === "screen", "screen caller required"),
  });
  const agentBound = await bindSurface(agent, installation, {
    admit: admitWhen((actor) => actor.kind === "agent", "agent caller required"),
  });
  if (screenBound.status !== "bound" || agentBound.status !== "bound") {
    throw new Error("the todo host did not realize both surfaces");
  }
  // #endregion bind

  // #region call
  const screenCaller = screenBound.binding.connect();
  const agentCaller = agentBound.binding.connect();

  const byScreen = await screenCaller.call(
    screen.handles.complete,
    { id: 1 },
    { kind: "screen", actorId: "ada" },
  );
  const byAgent = await agentCaller.call(
    agent.handles.complete,
    { id: 2 },
    { kind: "agent", actorId: "agent-7" },
  );
  // #endregion call

  // #region denied
  let denied: InteractionFault | undefined;
  try {
    await agentCaller.call(agent.handles.complete, { id: 1 }, { kind: "screen", actorId: "ada" });
  } catch (error) {
    if (error instanceof InteractionFault && error.cause === "denied") denied = error;
    else throw error;
  }
  // #endregion denied

  // #region declared-error
  let notFound: { id: number } | undefined;
  try {
    await agentCaller.call(agent.handles.complete, { id: 999 }, { kind: "agent", actorId: "agent-7" });
  } catch (error) {
    if (isDeclaredInteractionError(error, agent.handles.complete, "notFound")) {
      notFound = error.details;
    } else {
      throw error;
    }
  }
  // #endregion declared-error

  // #region unrealized
  const partialInteractions = { complete: interactions.complete } as const;
  const partial = await compileInteractions(partialInteractions);
  const { installation: partialInstallation } = await installInteractions<
    typeof partialInteractions,
    Actor
  >(partial, {
    installationId: "todos:partial:v1",
    implementations: implementInteractions<typeof partialInteractions, Actor>(partialInteractions, {
      complete: (input) => ({ id: input.id, title: "partial", done: true }),
    }),
    realizationIds: realizationIdsFor(partial, "v1"),
  });

  const unrealized = await bindSurface(screen, partialInstallation, {
    admit: admitWhen((actor: Actor) => actor.kind === "screen"),
  });
  // unrealized.status === "unrealized"; unrealized.report.issues names "clear"
  // #endregion unrealized

  // #region stale
  const staleInteractions = {
    complete: defineInteraction({
      id: "todos.complete",
      input: z.strictObject({ id: z.number().int().positive() }),
      output: z.strictObject({ id: z.number().int(), title: z.string(), done: z.string() }),
      errors: { notFound: z.strictObject({ id: z.number().int() }) },
      reads: ["todos"],
      changes: ["todos"],
    }),
  } as const;
  const staleCompiled = await compileInteractions(staleInteractions);
  const staleAgent = await projectSurface(staleCompiled, surface.all(staleInteractions));

  const stale = await bindSurface(staleAgent, installation, {
    admit: admitWhen((actor: Actor) => actor.kind === "agent"),
  });
  // stale.status === "unrealized": same id, different contract, refused before dispatch
  // #endregion stale

  // #region revoke
  controller.revoke();
  // #endregion revoke

  return { byScreen, byAgent, denied, notFound, unrealized, stale, remaining: todos.size };
}
