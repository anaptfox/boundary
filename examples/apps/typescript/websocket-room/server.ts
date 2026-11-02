import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { agentStream, fixtureModel } from "./agent";
import { createRoomHost } from "./host";
import { WebSocketRoom, type RoomSink } from "./room";
import type { LanguageModel } from "ai";

export async function startRoomServer({ port = 4318, model = fixtureModel }: { port?: number; model?: LanguageModel } = {}) {
  const host = await createRoomHost();
  const room = new WebSocketRoom((messages, signal, checkpoint) => agentStream(host, messages, signal, checkpoint, model));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "dist");
  const server = createServer((request, response) => {
    void (async () => {
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url ?? "/", origin);
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) { response.writeHead(403).end(); return; }
      const path = url.pathname;
      if (request.method === "POST" && path === "/approve") {
        if (request.headers.origin !== origin) { response.writeHead(403).end(); return; }
        let text = "";
        for await (const chunk of request) { text += chunk.toString(); if (Buffer.byteLength(text) > 4096) { response.writeHead(413).end(); return; } }
        const input: unknown = JSON.parse(text);
        if (!input || typeof input !== "object" || !("id" in input) || typeof input.id !== "string") { response.writeHead(400).end(); return; }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(await host.approve(input.id))); return;
      }
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      if (path === "/snapshot") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(host.snapshot())); return; }
      const file = path === "/" ? resolve(root, "index.html") : resolve(root, `.${decodeURIComponent(path)}`);
      if (!file.startsWith(root + "/")) { response.writeHead(404).end(); return; }
      const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)];
      if (!type) { response.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(bytes);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end("Request unavailable"); });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const origin = `http://${request.headers.host}`;
    if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname) || request.url !== "/chat" || request.headers.origin !== origin) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (socket) => {
    const sink: RoomSink = { send(frame) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > 512 * 1024) { socket.close(1013, "Reconnect to replay the reply"); return false; }
      socket.send(JSON.stringify(frame)); return true;
    } };
    let queue = Promise.resolve();
    socket.on("message", (bytes) => {
      queue = queue.then(() => room.receive(JSON.parse(bytes.toString()), sink)).catch(() => { socket.close(1008, "Invalid or unavailable room request"); });
    });
    socket.on("close", () => room.disconnect(sink));
    socket.on("error", () => room.disconnect(sink));
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local address unavailable");
  return { host, room, port: address.port, async close() {
    room.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((done) => sockets.close(() => done()));
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  } };
}

// Re-export the native constructor for consumer fixtures using this workspace.
export { WebSocket };
