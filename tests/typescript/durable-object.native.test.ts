import { describe, expect, it, vi } from "vitest";
import { WorkspaceComposition } from "../fixtures/runtimes/durable-object/workspace";

describe("application-owned Durable Object composition", () => {
  it("keeps the checked CompiledSurface handler as ordinary application state", async () => {
    const state = { sqlite: "application" };
    const environment = { deployment: "workspace-v1" };
    const createHandler = vi.fn(
      (receivedState: typeof state, receivedEnvironment: typeof environment) =>
        async () => new Response(`${receivedState.sqlite}:${receivedEnvironment.deployment}`),
    );
    const workspace = new WorkspaceComposition(state, environment, createHandler);

    await expect(
      (await workspace.fetch(new Request("https://workspace.test/boundary"))).text(),
    ).resolves.toBe("application:workspace-v1");
    expect(createHandler).toHaveBeenCalledWith(state, environment);
  });
});
