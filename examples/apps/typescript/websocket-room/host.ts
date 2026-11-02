import { randomUUID } from "node:crypto";
import { admitWhen, bindProjection, pickProjection } from "@foxworth/boundary";
import { createTodoHost, type TodoCaller } from "../todo-multisurface/host";

export async function createRoomHost() {
  const todos = await createTodoHost();
  const readProjection = await pickProjection(todos.screen, "list");
  const selected = await bindProjection(readProjection, todos.installation, {
    admit: admitWhen((context: TodoCaller) => context.kind === "agent", "agent only"),
  });
  if (selected.status !== "bound") throw new Error("read-only room Binding unavailable");
  const read = selected.binding.connect();
  type Proposal = { id: string; todoId: number; title: string; base: string; state: "pending" | "executing" | "completed" | "stale" | "uncertain" };
  const proposals = new Map<string, Proposal>();
  return {
    readProjection,
    async list() { return read.call(readProjection.handles.list, todos.agentContext); },
    propose(todoId: number) {
      if (proposals.size >= 256) throw new Error("proposal capacity reached; restart this local demo");
      const todo = todos.store.get(todoId);
      if (!todo || todo.completed) throw new Error("choose an open todo");
      const proposal: Proposal = { id: randomUUID(), todoId, title: todo.title, base: JSON.stringify(todo), state: "pending" };
      proposals.set(proposal.id, proposal);
      return { id: proposal.id, todoId, title: todo.title, state: proposal.state };
    },
    async approve(id: string) {
      const proposal = proposals.get(id);
      if (!proposal) throw new Error("proposal not found");
      if (proposal.state !== "pending") return { ...proposal };
      if (JSON.stringify(todos.store.get(proposal.todoId)) !== proposal.base) { proposal.state = "stale"; return { ...proposal }; }
      proposal.state = "executing";
      try {
        await todos.screenCaller.complete({ id: proposal.todoId }, todos.screenContext);
        proposal.state = "completed";
      } catch { proposal.state = "uncertain"; }
      return { ...proposal };
    },
    snapshot() { return { todos: todos.store.list(), proposals: [...proposals.values()].map(({ base: _base, ...proposal }) => ({ ...proposal })) }; },
  };
}
export type RoomHost = Awaited<ReturnType<typeof createRoomHost>>;
