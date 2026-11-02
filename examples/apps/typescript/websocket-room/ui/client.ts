import { WebSocketChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import "./style.css";
const transport = new WebSocketChatTransport({ url: "/chat" });
const chatId = crypto.randomUUID();
let messages: UIMessage[] = [];
let current: AbortController | undefined;
const reply = document.querySelector<HTMLPreElement>("#reply")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const send = document.querySelector<HTMLButtonElement>("#composer button")!;
async function snapshot() {
  const response = await fetch("/snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error("Board unavailable");
  const data: { todos: Array<{ id: number; title: string; completed: boolean }>; proposals: Array<{ id: string; title: string; state: string }> } = await response.json();
  const board = document.querySelector("#board")!; board.replaceChildren();
  for (const todo of data.todos) { const row = document.createElement("p"); row.textContent = `${todo.id}. ${todo.title} — ${todo.completed ? "complete" : "open"}`; board.appendChild(row); }
  const proposals = document.querySelector("#proposals")!; proposals.replaceChildren();
  for (const proposal of data.proposals) {
    const row = document.createElement("p"); row.textContent = `Complete “${proposal.title}”: ${proposal.state} `;
    if (proposal.state === "pending") {
      const button = document.createElement("button"); button.textContent = "Approve completion";
      button.onclick = () => { button.disabled = true; void fetch("/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: proposal.id }) }).then(async (response) => { if (!response.ok) throw new Error("Approval unavailable"); await snapshot(); }).catch(() => { status.textContent = "Approval outcome unavailable. Inspect the board before trying anything else."; }); };
      row.appendChild(button);
    }
    proposals.appendChild(row);
  }
}
async function consume(stream: ReadableStream<UIMessageChunk>) {
  let response: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    response = message;
    reply.textContent = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  if (response) messages = [...messages.filter((message) => message.id !== response.id), response];
  await snapshot();
}
document.querySelector<HTMLFormElement>("#composer")!.onsubmit = (event) => {
  event.preventDefault(); if (current) return;
  const input = document.querySelector<HTMLInputElement>("#prompt")!;
  const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: input.value }] };
  messages.push(message); input.value = ""; current = new AbortController(); stop.disabled = false; send.disabled = true;
  status.textContent = "Guide is replying…";
  void transport.sendMessages({ chatId, messageId: message.id, trigger: "submit-message", messages, abortSignal: current.signal }).then(consume).then(() => { status.textContent = "Reply complete; proposals still require approval."; }).catch(() => { status.textContent = "Reply interrupted. Reconnect to inspect its replay."; }).finally(() => { current = undefined; stop.disabled = true; send.disabled = false; void snapshot().catch(() => {}); });
};
stop.onclick = () => current?.abort();
document.querySelector<HTMLButtonElement>("#resume")!.onclick = () => {
  if (current) return;
  current = new AbortController(); send.disabled = true;
  transport.close(); reply.textContent = "";
  void transport.reconnectToStream({ chatId, abortSignal: current.signal }).then(async (stream) => { if (stream) await consume(stream); status.textContent = stream ? "Reply replayed; no work repeated." : "No reply in this server process."; }).catch(() => { status.textContent = "Replay unavailable."; }).finally(() => { current = undefined; send.disabled = false; });
};
void snapshot().catch(() => { status.textContent = "Board unavailable."; });
window.addEventListener("pagehide", () => transport.close());
