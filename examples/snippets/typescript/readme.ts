/**
 * An additional Todo example using projection helpers.
 * Executed by tests/typescript/docs-examples.test.ts.
 */
// #region define
import { z } from "zod";
import { admitWhen, declaredInteractionError, defineInteraction, surface } from "@foxworth/boundary";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectSurface, realizationIdsFor } from "@foxworth/boundary/pipeline";

const Todo = z.strictObject({ id: z.number().int(), title: z.string(), done: z.boolean() });

export const interactions = {
  complete: defineInteraction({
    id: "todos.complete",
    input: z.strictObject({ id: z.number().int().positive() }),
    output: Todo,
    errors: { notFound: z.strictObject({ id: z.number().int() }) },
    reads: ["todos"],
    changes: ["todos"],
  }),
  clear: defineInteraction({
    id: "todos.clear",
    output: z.strictObject({ removed: z.number().int() }),
    reads: ["todos"],
    changes: ["todos"],
  }),
} as const;
// #endregion define

export async function runReadmeExample() {
  // #region project
  const compiled = await compileInteractions(interactions);

  // The screen may complete and clear. The agent may only complete.
  const screen = await projectSurface(compiled, surface.all(interactions));
  const agent = await projectSurface(compiled, surface(interactions, { call: ["complete"] }));
  // #endregion project

  // #region install
  type Actor = { kind: "screen" | "agent" };
  const todos = new Map<number, z.infer<typeof Todo>>([
    [1, { id: 1, title: "Ship Boundary", done: false }],
    [2, { id: 2, title: "Teach Boundary", done: false }],
  ]);

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

  const { installation } = await installInteractions<typeof interactions, Actor>(compiled, {
    installationId: "todos:local:v1",
    implementations,
    realizationIds: realizationIdsFor(compiled, "v1"),
  });
  // #endregion install

  // #region call
  const bound = await bindSurface(agent, installation, {
    admit: admitWhen((actor) => actor.kind === "agent"),
  });
  if (bound.status !== "bound") {
    throw new Error(`agent surface is unrealized: ${JSON.stringify(bound.report.issues)}`);
  }

  const caller = bound.binding.connect();
  const done = await caller.call(agent.handles.complete, { id: 1 }, { kind: "agent" });
  // #endregion call

  return { done, remaining: todos.size, screen, agent };
}
