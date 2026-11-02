import type { ClearResult, Todo } from "./interactions";

export type TodoStore = Readonly<{
  list(): readonly Todo[];
  get(id: number): Todo | undefined;
  hasTitle(title: string): boolean;
  create(title: string): Todo;
  complete(id: number): Todo | undefined;
  reopen(id: number): Todo | undefined;
  clear(): ClearResult;
}>;

const seed: readonly Todo[] = [
  { id: 1, title: "Ship Boundary", completed: false },
  { id: 2, title: "Teach Boundary", completed: false },
];

export function createTodoStore(
  initial: readonly Todo[] = seed,
): TodoStore {
  const rows = new Map<number, Todo>(initial.map((todo) => [todo.id, todo]));
  let nextId = Math.max(0, ...rows.keys()) + 1;

  return {
    list() {
      return [...rows.values()];
    },
    get(id) {
      return rows.get(id);
    },
    hasTitle(title) {
      return [...rows.values()].some((todo) => todo.title === title);
    },
    create(title) {
      const todo: Todo = { id: nextId, title, completed: false };
      nextId += 1;
      rows.set(todo.id, todo);
      return todo;
    },
    complete(id) {
      const current = rows.get(id);
      if (!current) return undefined;
      const completed: Todo = { ...current, completed: true };
      rows.set(id, completed);
      return completed;
    },
    reopen(id) {
      const current = rows.get(id);
      if (!current) return undefined;
      const opened: Todo = { ...current, completed: false };
      rows.set(id, opened);
      return opened;
    },
    clear() {
      const removed = rows.size;
      rows.clear();
      return { removed };
    },
  };
}
