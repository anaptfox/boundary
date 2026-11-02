import { expect, it } from "vitest";
import { createInteractionCacheScope, watchInteraction } from "@foxworth/boundary/client/cache";
import { createScopedObservationExample } from "../../examples/snippets/typescript/scoped-observations";

it("wires the documented typed read, change, and observations through one explicit scope", async () => {
  let rendered: readonly { id: number; title: string }[] = [];
  let waiting: { title: string; resolve: () => void } | undefined;
  const render = (snapshot: { data: readonly { id: number; title: string }[] | undefined }) => {
    if (snapshot.data) rendered = snapshot.data;
    if (waiting && rendered.some((todo) => todo.title === waiting!.title)) waiting.resolve();
  };
  const shown = (title: string) => new Promise<void>((resolve) => { waiting = { title, resolve }; });
  const example = await createScopedObservationExample(render);
  const { screenClient, otherClient, handles, createTodo, subscription } = example;
  const isolated = watchInteraction(screenClient, handles.list, { scope: createInteractionCacheScope() });
  const stopIsolated = isolated.subscribe(() => {});
  try {
    await isolated.refresh();
    expect(rendered).toEqual([]);
    expect(subscription.state).toBe("connected");
    const localChangeShown = shown("From screen");
    await example.addFromScreen();
    await localChangeShown;
    expect(createTodo.getSnapshot()).toMatchObject({ phase: "succeeded", availability: "available" });
    expect(isolated.getSnapshot().data).toEqual([]);

    const remoteChangeShown = shown("From another caller");
    await otherClient.call(handles.create, { title: "From another caller" });
    await remoteChangeShown;
    expect(rendered.map((todo) => todo.title)).toEqual(["From screen", "From another caller"]);
    expect(isolated.getSnapshot().data).toEqual([]);

    subscription.disconnect();
    await otherClient.call(handles.create, { title: "During delivery gap" });
    expect(rendered).toHaveLength(2);
    await subscription.reconnect();
    expect(rendered).toHaveLength(3);
    expect(example.rows).toHaveLength(3); // Reconnection did not repeat any change.
    expect(isolated.getSnapshot().data).toEqual([]);
  } finally {
    example.disposeView();
    stopIsolated(); isolated.dispose();
  }
  await Promise.resolve();
  expect(example.subscriberCount).toBe(0);
});
