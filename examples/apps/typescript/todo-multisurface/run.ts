import { createTodoHost } from "./host";

export async function runTodoHost() {
  const host = await createTodoHost();
  const listed = await host.screenCaller.list(host.screenContext);
  const created = await host.screenCaller.create({ title: "Ship the fixture" }, host.screenContext);
  const agentListed = await host.agentCaller.list(host.agentContext);
  const agentCompleted = await host.agentCaller.complete({ id: created.id }, host.agentContext);
  const screenCompleted = await host.screenCaller.complete({ id: listed[0]!.id }, host.screenContext);
  const screenReopened = await host.screenCaller.reopen({ id: listed[0]!.id }, host.screenContext);
  const cleared = await host.screenCaller.clear(host.screenContext);

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
