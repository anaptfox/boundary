import { z } from "zod";
import { defineInteraction } from "@foxworth/boundary";

export type Todo = Readonly<{
  id: number;
  title: string;
  completed: boolean;
}>;

export type CreateTodoInput = Readonly<{ title: string }>;
export type CompleteTodoInput = Readonly<{ id: number }>;
export type ClearResult = Readonly<{ removed: number }>;

const todo = z.strictObject({
  id: z.number().int(),
  title: z.string(),
  completed: z.boolean(),
});
const todoId = z.strictObject({ id: z.number().int().min(1) });
const notFound = z.strictObject({ id: z.number().int() });

export const interactions = {
  list: defineInteraction({
    id: "todos.list",
    description: "List every todo on the board.",
    output: z.array(todo),
    reads: ["todos"],
    changes: [],
  }),
  create: defineInteraction({
    id: "todos.create",
    description: "Create a todo with a unique title.",
    input: z.strictObject({ title: z.string().min(1) }),
    output: todo,
    errors: { duplicateTitle: z.strictObject({ title: z.string() }) },
    reads: ["todos"],
    changes: ["todos"],
  }),
  complete: defineInteraction({
    id: "todos.complete",
    description: "Mark one todo complete.",
    input: todoId,
    output: todo,
    errors: { notFound },
    reads: ["todos"],
    changes: ["todos"],
  }),
  reopen: defineInteraction({
    id: "todos.reopen",
    description: "Mark one completed todo open again.",
    input: todoId,
    output: todo,
    errors: { notFound },
    reads: ["todos"],
    changes: ["todos"],
  }),
  clear: defineInteraction({
    id: "todos.clear",
    description: "Remove every todo.",
    output: z.strictObject({ removed: z.number().int() }),
    reads: ["todos"],
    changes: ["todos"],
  }),
} as const;
