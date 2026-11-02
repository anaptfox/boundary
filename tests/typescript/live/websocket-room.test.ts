import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, startRoomServer } from "../../../examples/apps/typescript/websocket-room/server";
import { WebSocketChatTransport, readUIMessageStream, type UIMessage } from "../../../examples/apps/typescript/websocket-room/node_modules/ai";

const servers: Array<Awaited<ReturnType<typeof startRoomServer>>> = [];
const transports: WebSocketChatTransport<UIMessage>[] = [];
afterEach(async () => { for (const transport of transports.splice(0)) transport.close(); for (const server of servers.splice(0)) await server.close(); });
describe("native WebSocket SDK consumer", () => {
  it("streams over a real socket, replays without creating another proposal, and approves once over HTTP", async () => {
    const server = await startRoomServer({ port: 0 }); servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    class LocalSocket extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols, { origin }); } }
    const transport = new WebSocketChatTransport({ url: `${origin}/chat`, webSocket: LocalSocket }); transports.push(transport);
    const messages: UIMessage[] = [{ id: "user-1", role: "user", parts: [{ type: "text", text: "complete 1" }] }];
    const stream = await transport.sendMessages({ chatId: "chat-1", messageId: "user-1", trigger: "submit-message", messages, abortSignal: undefined });
    const responses: UIMessage[] = []; for await (const message of readUIMessageStream({ stream })) responses.push(message);
    expect(responses.at(-1)?.parts.some((part) => part.type === "text" && part.text.includes("approve"))).toBe(true);
    expect(server.host.snapshot().proposals).toHaveLength(1); expect(server.host.snapshot().todos[0]?.completed).toBe(false);
    transport.close(); const replay = await transport.reconnectToStream({ chatId: "chat-1" }); expect(replay).not.toBeNull();
    const replayed: UIMessage[] = []; for await (const message of readUIMessageStream({ stream: replay! })) replayed.push(message);
    expect(replayed.at(-1)).toEqual(responses.at(-1)); expect(server.host.snapshot().proposals).toHaveLength(1);
    const id = server.host.snapshot().proposals[0]!.id;
    const approve = () => fetch(`${origin}/approve`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ id }) });
    expect(await (await approve()).json()).toMatchObject({ state: "completed" }); expect(await (await approve()).json()).toMatchObject({ state: "completed" });
    expect(server.host.snapshot().todos[0]?.completed).toBe(true);
    const forged = await fetch(`${origin}/approve`, { method: "POST", headers: { origin: "https://foreign.invalid" }, body: JSON.stringify({ id }) }); expect(forged.status).toBe(403);
  });
});
