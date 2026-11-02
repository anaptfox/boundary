import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createProjectionElectronMain } from "@foxworth/boundary/electron";
import { createTodoServing } from "../../../examples/apps/typescript/todo-multisurface/serve";
import { fakeElectron } from "../helpers/electron";

describe("Todo MVP localhost transport", () => {
  it("mounts the same serving on an Electron HTTP door", async () => {
    const serving = await createTodoServing();
    try {
      const main = await createProjectionElectronMain({
        electron: fakeElectron().electron,
        handler: serving.handler,
        port: 0,
        scheme: false,
        ipcChannel: false,
        partition: "persist:boundary-todo",
        openWindow: false,
      });
      try {
        const transport = new StreamableHTTPClientTransport(
          new URL(`${main.baseUrl}/mcp`),
        );
        const client = new Client(
          { name: "todo-electron-test", version: "0.0.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        try {
          await client.connect(transport);
          const listed = await client.listTools();
          expect(listed.tools.map((entry) => entry.name).sort()).toEqual([
            "todos.complete",
            "todos.list",
            "todos.reopen",
          ]);
        } finally {
          await client.close();
        }
      } finally {
        await main.close();
      }
    } finally {
      serving.dispose();
    }
  });
});
