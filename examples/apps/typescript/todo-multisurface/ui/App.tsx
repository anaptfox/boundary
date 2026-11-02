import { useEffect, useState } from "react";
import type { ProjectionClient } from "@foxworth/boundary/client";
import { describeInteractionError, useInteraction } from "@foxworth/boundary/react";
import type { Todo } from "../interactions";
import type { TodoUiRuntime } from "./client";

type Desk = "screen" | "agent";
type Handles = TodoUiRuntime["handles"];

function TodoRow(props: {
  todo: Todo;
  pending: boolean;
  onToggle: (todo: Todo) => Promise<void>;
}) {
  return (
    <li className={props.todo.completed ? "row done" : "row"}>
      <button
        type="button"
        className="check"
        disabled={props.pending}
        onClick={() => void props.onToggle(props.todo)}
        aria-label={
          props.todo.completed
            ? `Reopen ${props.todo.title}`
            : `Complete ${props.todo.title}`
        }
      >
        <span>{props.todo.completed ? "✓" : ""}</span>
      </button>
      <p className="title">{props.todo.title}</p>
    </li>
  );
}

function CreateForm({
  client,
  handle,
}: {
  client: ProjectionClient;
  handle: Handles["create"];
}) {
  const [draft, setDraft] = useState("");
  const create = useInteraction(client, handle);
  return (
    <>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const title = draft.trim();
          if (!title) return;
          void create.call({ title }).then(() => setDraft(""));
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What needs doing?"
          aria-label="New todo title"
        />
        <button type="submit" disabled={create.isPending || !draft.trim()}>
          Add
        </button>
      </form>
      {create.error ? (
        <p className="fault">{describeInteractionError(create.error).message}</p>
      ) : null}
    </>
  );
}

function ClearButton({
  client,
  handle,
  empty,
}: {
  client: ProjectionClient;
  handle: Handles["clear"];
  empty: boolean;
}) {
  const clear = useInteraction(client, handle);
  return (
    <button
      type="button"
      className="ghost"
      disabled={clear.isPending || empty}
      onClick={() => void clear.call()}
    >
      Clear all
    </button>
  );
}

function DeskView({
  name,
  note,
  client,
  handles,
  canCreate,
  canClear,
}: {
  name: string;
  note: string;
  client: ProjectionClient;
  handles: Handles;
  canCreate: boolean;
  canClear: boolean;
}) {
  const list = useInteraction(client, handles.list);
  const complete = useInteraction(client, handles.complete);
  const reopen = useInteraction(client, handles.reopen);
  const error = list.error ?? complete.error ?? reopen.error;
  const todos = list.data ?? [];
  useEffect(() => {
    const refresh = () => {
      void list.refetch();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [list.refetch]);

  return (
    <section className="desk" data-desk={name.toLowerCase()}>
      <header className="desk-head">
        <p className="stamp">{name}</p>
        <p className="stamp-note">{note}</p>
      </header>
      {canCreate ? (
        <CreateForm client={client} handle={handles.create} />
      ) : null}
      {error ? (
        <p className="fault">{describeInteractionError(error).message}</p>
      ) : null}
      <ul className="rows">
        {todos.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            pending={complete.isPending || reopen.isPending}
            onToggle={async (item) => {
              if (item.completed) await reopen.call({ id: item.id });
              else await complete.call({ id: item.id });
            }}
          />
        ))}
      </ul>
      <footer className="desk-foot">
        <p>
          {canClear
            ? `${todos.length} on the board`
            : `${todos.filter((todo) => !todo.completed).length} still open`}
        </p>
        {canClear ? (
          <ClearButton
            client={client}
            handle={handles.clear}
            empty={todos.length === 0}
          />
        ) : null}
      </footer>
    </section>
  );
}

export function App({ runtime }: { runtime: TodoUiRuntime }) {
  const [desk, setDesk] = useState<Desk>("screen");

  return (
    <main className="board">
      <header className="mast">
        <p className="eyebrow">One Installation · two Bindings</p>
        <h1>Todos</h1>
        <p className="lede">
          The screen talks Handoff. The agent is regular MCP at{" "}
          <code>http://127.0.0.1:4173/mcp</code>
          {runtime.webmcp ? ", WebMCP on this page," : ","} and this
          desktop or browser window. Same Installation
          {runtime.webmcp
            ? "."
            : ". This browser has no document.modelContext, so WebMCP stays dark."}
        </p>
        <div className="switch" role="tablist" aria-label="Caller">
          <button
            type="button"
            role="tab"
            aria-selected={desk === "screen"}
            className={desk === "screen" ? "on" : ""}
            onClick={() => setDesk("screen")}
          >
            Screen
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={desk === "agent"}
            className={desk === "agent" ? "on" : ""}
            onClick={() => setDesk("agent")}
          >
            Agent
          </button>
        </div>
      </header>
      {desk === "screen" ? (
        <DeskView
          name="Screen"
          note="list · create · complete · reopen · clear"
          client={runtime.screenClient}
          handles={runtime.handles}
          canCreate
          canClear
        />
      ) : (
        <DeskView
          name="Agent"
          note="list · complete · reopen — no create, no clear"
          client={runtime.agentClient}
          handles={runtime.handles}
          canCreate={false}
          canClear={false}
        />
      )}
    </main>
  );
}
