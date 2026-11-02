import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import { mountSurface } from "@foxworth/boundary/frameworks/vite";
import { createTodoServing } from "../serve";
import { launchTodoDesktop } from "../electron/launch.ts";
import { TODO_UI_PORT } from "../endpoints";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "../../../..");

let servingPromise: ReturnType<typeof createTodoServing> | undefined;

function todoServing() {
  servingPromise ??= createTodoServing();
  return servingPromise;
}

function todoDesktopPlugin(): Plugin {
  return {
    name: "todo-desktop",
    async configureServer(server) {
      const serving = await todoServing();
      let desktop: ChildProcess | undefined;
      const openDesktop = () => {
        if (desktop) return;
        const address = server.httpServer?.address();
        const port =
          address && typeof address === "object" ? address.port : TODO_UI_PORT;
        desktop = launchTodoDesktop(`http://127.0.0.1:${port}/`);
      };
      if (server.httpServer?.listening) openDesktop();
      else server.httpServer?.once("listening", openDesktop);

      server.httpServer?.once("close", () => {
        serving.dispose();
        desktop?.kill();
      });
    },
  };
}

export default defineConfig(async () => {
  const serving = await todoServing();
  return {
    root: here,
    plugins: [
      mountSurface({ handler: serving.handler, mount: serving.paths }),
      todoDesktopPlugin(),
    ],
    server: {
      host: "127.0.0.1",
      port: TODO_UI_PORT,
      strictPort: true,
      open: true,
      fs: { allow: [workspace] },
    },
    resolve: {
      dedupe: ["react", "react-dom"],
    },
  };
});
