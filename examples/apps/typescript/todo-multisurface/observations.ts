import { canonicalJson, normalizeJson } from "@foxworth/boundary/program";
import type { ObservationSource, PointEvidence } from "@foxworth/boundary/observations";
import type { Todo } from "./interactions";
import type { TodoStore } from "./store";
import type { TodoCaller } from "./host";

export type TodoQuery = Readonly<{
  completed: boolean | null;
  order: "stored" | "id-asc";
  offset: number;
  limit: number | null;
}>;

/** This adapter owns complete query semantics. Content tokens are a simple
 * correct baseline; an indexed store can provide cheaper authoritative tokens. */
export function todoSnapshots(store: Pick<TodoStore, "list">):
  ObservationSource<TodoCaller, number, Todo, TodoQuery, readonly Todo[]> {
  return {
    async withSnapshot(_context, _scope, run) {
      const rows = normalizeJson(store.list()) as readonly Todo[];
      const point = (id: number): PointEvidence<Todo> => {
        const value = rows.find(row => row.id === id);
        return value === undefined
          ? { kind: "absent", token: canonicalJson({ kind: "absent" }) }
          : { kind: "present", value, token: canonicalJson({ kind: "present", value }) };
      };
      const query = (descriptor: TodoQuery) => {
        let result = rows.filter(row => descriptor.completed === null || row.completed === descriptor.completed);
        if (descriptor.order === "id-asc") result = [...result].sort((a, b) => a.id - b.id);
        result = result.slice(descriptor.offset, descriptor.limit === null ? undefined : descriptor.offset + descriptor.limit);
        return { value: result, token: canonicalJson(result) };
      };
      return run({
        read: point,
        query,
        validate(observation) {
          const current = observation.kind === "point" ? point(observation.key) : query(observation.query);
          return current.token === observation.token ? "matching" : "changed";
        },
      });
    },
  };
}
