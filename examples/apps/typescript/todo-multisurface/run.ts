import { createTodoHost } from "./host";

export async function runTodoHost() {
  const host = await createTodoHost();
  const listed = await host.screenCaller.call(
    host.screen.handles.list,
    host.screenContext,
  );
  const created = await host.screenCaller.call(
    host.screen.handles.create,
    { title: "Ship the fixture" },
    host.screenContext,
  );
  const agentListed = await host.agentCaller.call(
    host.agent.handles.list,
    host.agentContext,
  );
  const agentCompleted = await host.agentCaller.call(
    host.agent.handles.complete,
    { id: created.id },
    host.agentContext,
  );
  const screenCompleted = await host.screenCaller.call(
    host.screen.handles.complete,
    { id: listed[0]!.id },
    host.screenContext,
  );
  const screenReopened = await host.screenCaller.call(
    host.screen.handles.reopen,
    { id: listed[0]!.id },
    host.screenContext,
  );
  const cleared = await host.screenCaller.call(
    host.screen.handles.clear,
    host.screenContext,
  );

  return {
    listed,
    created,
    agentListed,
    agentCompleted,
    screenCompleted,
    screenReopened,
    cleared,
  };
}
