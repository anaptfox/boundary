/**
 * Current executable proof of the ordinary `@foxworth/boundary` workflow.
 *
 * Application-owned definitions compile independently from implementations.
 * Durable Projections select caller surfaces before an Installation exists.
 * Atomic Binding then pins those surfaces to one live Installation and creates
 * stateless Callers whose context is supplied per invocation.
 */
// #region foundation-status
export const hostLifecycleExampleStatus = {
  interface: "host-lifecycle",
  package: "@foxworth/boundary",
  workspaceAvailable: true,
  published: false,
} as const;
// #endregion foundation-status

import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
  type AdmissionRequest,
} from "../../../packages/core/host/index";

type Caller = Readonly<{ kind: "screen" | "agent"; actorId: string }>;
type Todo = Readonly<{
  id: number;
  title: string;
  completed: boolean;
}>;

const CompleteInput = portableSchema<Readonly<{ id: number }>>({
  type: "object",
  properties: { id: { type: "integer", minimum: 1 } },
  required: ["id"],
  additionalProperties: false,
});
const EmptyInput = portableSchema<Readonly<Record<never, never>>>({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});
const TodoSchema = portableSchema<Todo>({
  type: "object",
  properties: {
    id: { type: "integer" },
    title: { type: "string" },
    completed: { type: "boolean" },
  },
  required: ["id", "title", "completed"],
  additionalProperties: false,
});
const ClearResult = portableSchema<Readonly<{ removed: number }>>({
  type: "object",
  properties: { removed: { type: "integer" } },
  required: ["removed"],
  additionalProperties: false,
});
const NotFound = portableSchema<Readonly<{ id: number }>>({
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
  additionalProperties: false,
});
const StaleTodoSchema = portableSchema<
  Readonly<{ id: number; title: string; completed: string }>
>({
  type: "object",
  properties: {
    id: { type: "integer" },
    title: { type: "string" },
    completed: { type: "string" },
  },
  required: ["id", "title", "completed"],
  additionalProperties: false,
});

// #region interaction
const interactions = {
  complete: defineInteraction({
    id: "todos.complete",
    input: CompleteInput,
    output: TodoSchema,
    errors: { notFound: NotFound },
    reads: ["todos"],
    changes: ["todos"],
  }),
  clear: defineInteraction({
    id: "todos.clear",
    input: EmptyInput,
    output: ClearResult,
    reads: ["todos"],
    changes: ["todos"],
  }),
} as const;
const staleInteractions = {
  complete: defineInteraction({
    id: "todos.complete",
    input: CompleteInput,
    output: StaleTodoSchema,
    errors: { notFound: NotFound },
    reads: ["todos"],
    changes: ["todos"],
  }),
} as const;
// #endregion interaction

function fixtureError(code: "INTERACTION_NOT_EXPOSED" | "STALE_CONTRACT") {
  return Object.assign(new Error(code), { code });
}

function completeInput(value: unknown): value is Readonly<{ id: number }> {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "number"
  );
}

/** Ordinary Host lifecycle proof: two callers share one interaction identity. */
export async function createHostLifecycleExample() {
  const compiled = await compileInteractions(interactions);

  // #region caller-projections
  const screenProjection = await projectInteractions(compiled, {
    complete: {
      interaction: compiled.handles.complete,
      modes: ["direct"],
    },
    clear: {
      interaction: compiled.handles.clear,
      modes: ["direct"],
    },
  });
  const agentProjection = await projectInteractions(compiled, {
    complete: {
      interaction: compiled.handles.complete,
      modes: ["direct"],
    },
  });
  // #endregion caller-projections

  const todos = new Map<number, Todo>([
    [1, { id: 1, title: "Ship Boundary", completed: false }],
    [2, { id: 2, title: "Teach Boundary", completed: false }],
  ]);
  const dispatches: string[] = [];
  const implementations = implementInteractions<typeof interactions, Caller>(
    interactions,
    {
      complete(input: Readonly<{ id: number }>) {
        dispatches.push("todos.complete");
        const current = todos.get(input.id);
        if (!current) {
          throw declaredInteractionError(interactions.complete, "notFound", {
            id: input.id,
          });
        }
        const completed = { ...current, completed: true };
        todos.set(input.id, completed);
        return completed;
      },
      clear(_input: Readonly<Record<never, never>>) {
        dispatches.push("todos.clear");
        const removed = todos.size;
        todos.clear();
        return { removed };
      },
    },
  );
  const { installation } = await installInteractions<typeof interactions, Caller>(
    compiled,
    {
      installationId: "todos:local:v1",
      implementations,
      realizationIds: {
        complete: { direct: "todos.complete:direct:v1" },
        clear: { direct: "todos.clear:direct:v1" },
      },
    },
  );

  const admissions: Array<
    Readonly<{ interactionId: string; kind: Caller["kind"]; actorId: string }>
  > = [];
  const admitKind = (expected: Caller["kind"]) =>
    (request: AdmissionRequest<Caller>) => {
      admissions.push({
        interactionId: request.handle.interactionId,
        kind: request.context.kind,
        actorId: request.context.actorId,
      });
      return request.context.kind === expected
        ? ({ decision: "allow" } as const)
        : ({ decision: "deny", reason: `${expected} caller required` } as const);
    };

  const screenResult = await bindProjection(screenProjection, installation, {
    admit: admitKind("screen"),
  });
  const agentResult = await bindProjection(agentProjection, installation, {
    admit: admitKind("agent"),
  });
  if (screenResult.status !== "bound" || agentResult.status !== "bound") {
    throw new Error("the Todo host did not realize both caller surfaces");
  }

  const screenCaller = screenResult.binding.connect();
  const agentCaller = agentResult.binding.connect();
  const screenClear = screenResult.binding.resolve("todos.clear");
  if (!screenClear) throw new Error("screen clear interaction was not bound");

  const staleCompiled = await compileInteractions(staleInteractions);
  const staleProjection = await projectInteractions(staleCompiled, {
    complete: {
      interaction: staleCompiled.handles.complete,
      modes: ["direct"],
    },
  });
  const staleResult = await bindProjection(staleProjection, installation, {
    admit: admitKind("agent"),
  });
  const completeReference = screenProjection.handles.complete;
  const clearReference = screenProjection.handles.clear;
  const staleCompleteReference = Object.freeze({
    interactionId: "todos.complete",
    status: "stale-contract",
  });
  const callAgent = async (reference: unknown, input: unknown) => {
    if (reference === clearReference) {
      try {
        await agentResult.binding.invoke(
          { interaction: screenClear, mode: "direct", input },
          { kind: "agent", actorId: "agent-7" },
        );
      } catch {
        throw fixtureError("INTERACTION_NOT_EXPOSED");
      }
      throw fixtureError("INTERACTION_NOT_EXPOSED");
    }
    if (reference === staleCompleteReference) {
      if (staleResult.status === "unrealized") {
        throw fixtureError("STALE_CONTRACT");
      }
      throw new Error("the stale contract unexpectedly bound");
    }
    if (reference !== completeReference || !completeInput(input)) {
      throw fixtureError("INTERACTION_NOT_EXPOSED");
    }
    const value = await agentCaller.call(
      agentProjection.handles.complete,
      input,
      { kind: "agent", actorId: "agent-7" },
    );
    return { kind: "returned" as const, value };
  };

  return {
    compiled,
    installation,
    screenProjection,
    agentProjection,
    screenBinding: screenResult.binding,
    agentBinding: agentResult.binding,
    admissions,
    dispatches,
    completeReference,
    clearReference,
    staleCompleteReference,
    callScreen: async (reference: unknown, input: unknown) => {
      if (reference !== completeReference || !completeInput(input)) {
        throw fixtureError("INTERACTION_NOT_EXPOSED");
      }
      const value = await screenCaller.call(
        screenProjection.handles.complete,
        input,
        { kind: "screen", actorId: "ada" },
      );
      return { kind: "returned" as const, value };
    },
    callAgent,
    callScreenComplete: (id: number) =>
      screenCaller.call(
        screenProjection.handles.complete,
        { id },
        { kind: "screen", actorId: "ada" },
      ),
    callAgentComplete: (id: number) =>
      agentCaller.call(
        agentProjection.handles.complete,
        { id },
        { kind: "agent", actorId: "agent-7" },
      ),
    callAgentAsScreen: (id: number) =>
      agentCaller.call(
        agentProjection.handles.complete,
        { id },
        { kind: "screen", actorId: "ada" },
      ),
    invokeAgentWithScreenClear: () =>
      agentResult.binding.invoke(
        { interaction: screenClear, mode: "direct", input: {} },
        { kind: "agent", actorId: "agent-7" },
      ),
  };
}

export async function runHostLifecycleExample() {
  const fixture = await createHostLifecycleExample();
  // #region identity-boundary
  const screen = await fixture.callScreen(fixture.completeReference, { id: 1 });
  const agent = await fixture.callAgent(fixture.completeReference, { id: 2 });
  let unselectedError: unknown;
  try {
    await fixture.callAgent(fixture.clearReference, {});
  } catch (error) {
    unselectedError = error;
  }
  let deniedError: unknown;
  try {
    await fixture.callAgentAsScreen(2);
  } catch (error) {
    deniedError = error;
  }
  let staleContractError: unknown;
  try {
    await fixture.callAgent(fixture.staleCompleteReference, { id: 2 });
  } catch (error) {
    staleContractError = error;
  }
  // #endregion identity-boundary
  return {
    screen,
    agent,
    unselectedError,
    deniedError,
    staleContractError,
    admissions: fixture.admissions,
    dispatches: fixture.dispatches,
  };
}
