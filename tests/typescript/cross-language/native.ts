import { z } from "zod";
import {
  bindProjection, compileInteractions, declaredInteractionError, defineInteraction,
  direct, directRealizationIds, implementInteractions, installInteractions, projectInteractions,
} from "@foxworth/boundary";

// Independent TypeScript declarations: never imported from Rust metadata.
export const Todo = z.strictObject({ completed: z.boolean(), id: z.string(), title: z.string() });
export const List = z.strictObject({ items: z.array(Todo) });
export const Create = z.strictObject({ title: z.string().min(1) });
const Id = z.strictObject({ id: z.string() });
const errors = { "todo_not_found": Id, "todo_unavailable": Id };
const change = { reads: ["todos"], changes: ["todos"], errors };
export const interactions = {
  list: defineInteraction({ id: "todos.list", input: z.strictObject({ filter: z.enum(["all", "active", "completed"]) }), output: List, reads: ["todos"], changes: [], errors }),
  create: defineInteraction({ id: "todos.create", input: Create, output: Todo, ...change }),
  rename: defineInteraction({ id: "todos.rename", input: z.strictObject({ id: z.string(), title: z.string().min(1) }), output: Todo, ...change }),
  setCompleted: defineInteraction({ id: "todos.setCompleted", input: z.strictObject({ completed: z.boolean(), id: z.string() }), output: Todo, ...change }),
  remove: defineInteraction({ id: "todos.remove", input: Id, output: Todo, ...change }),
  setAllCompleted: defineInteraction({ id: "todos.setAllCompleted", input: z.strictObject({ completed: z.boolean() }), output: z.strictObject({ count: z.string() }), ...change }),
  clearCompleted: defineInteraction({ id: "todos.clearCompleted", output: z.strictObject({ count: z.string() }), ...change }),
};

export async function nativeTodo() {
  const rows: z.output<typeof Todo>[] = [];
  let next = 1;
  function position(id: string, interaction: typeof interactions.rename | typeof interactions.remove | typeof interactions.setCompleted) {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw declaredInteractionError(interaction, "todo_not_found", { id });
    return index;
  }
  const compiled = compileInteractions(interactions);
  const implementations = implementInteractions(interactions, {
    list: ({ filter }) => ({ items: rows.filter((row) => filter === "all" || row.completed === (filter === "completed")) }),
    create({ title }) { const row = { completed: false, id: `todo-${next++}`, title }; rows.push(row); return row; },
    rename({ id, title }) { const index = position(id, interactions.rename); return rows[index] = { ...rows[index]!, title }; },
    setCompleted({ id, completed }) { const index = position(id, interactions.setCompleted); return rows[index] = { ...rows[index]!, completed }; },
    remove({ id }) { return rows.splice(position(id, interactions.remove), 1)[0]!; },
    setAllCompleted({ completed }) {
      let count = 0;
      for (const [index, row] of rows.entries()) {
        if (row.completed !== completed) { rows[index] = { ...row, completed }; count++; }
      }
      return { count: String(count) };
    },
    clearCompleted() {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index--) if (rows[index]!.completed) rows.splice(index, 1);
      return { count: String(before - rows.length) };
    },
  });
  const { installation } = installInteractions(compiled, {
    installationId: "fixture/ts-todo/v1", implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
  const projection = projectInteractions(compiled, {
    list: direct(compiled.handles.list), create: direct(compiled.handles.create),
    rename: direct(compiled.handles.rename), setCompleted: direct(compiled.handles.setCompleted),
    remove: direct(compiled.handles.remove), setAllCompleted: direct(compiled.handles.setAllCompleted),
    clearCompleted: direct(compiled.handles.clearCompleted),
  });
  const result = bindProjection(projection, installation, { admit: () => ({ decision: "allow" }) });
  if (result.status !== "bound") throw new Error("native fixture did not bind");
  return { compiled, projection, binding: result.binding };
}
