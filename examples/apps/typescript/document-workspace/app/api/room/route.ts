import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requestContext, boundedJson } from "../../../lib/demo-request";
import { documentRoom } from "../../../lib/room";
import { documentRoomDriver } from "../../../lib/room-driver";
import { localModels } from "../../../lib/ollama";
import type { RoomEvent } from "../../../lib/room-types";

export const maxDuration = 300;
const messageSchema = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(4000), model: z.string().min(1).max(200), allowSave: z.boolean().default(false), answer: z.object({ questionId: z.uuid(), value: z.string().trim().min(1).max(4000) }).strict().optional() }).strict();

export async function GET(request: Request) {
  try { requestContext(request); } catch { return Response.json({ error: "Choose a demo session." }, { status: 401 }); }
  const room = await documentRoom();
  if (new URL(request.url).searchParams.get("stream") !== "1") return Response.json(room.snapshot(), { headers: { "cache-control": "no-store" } });
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval>;
      const close = () => { if (closed) return; closed = true; unsubscribe(); clearInterval(heartbeat); request.signal.removeEventListener("abort", close); try { controller.close(); } catch {} };
      cleanup = close;
      const send = (event: RoomEvent) => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < 0) { close(); return; }
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { close(); }
      };
      send({ type: "snapshot", snapshot: room.snapshot() });
      unsubscribe = room.subscribe(send);
      heartbeat = setInterval(() => { if (!closed) { if ((controller.desiredSize ?? 0) < 0) { close(); return; } try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { close(); } } }, 15000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    }, cancel() { cleanup(); },
  }, { highWaterMark: 8_000_000, size: (chunk) => chunk.byteLength });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" } });
}

export async function POST(request: Request) {
  let context;
  try { context = requestContext(request); } catch { return Response.json({ error: "A same-origin demo session is required." }, { status: 403 }); }
  let input;
  try { input = messageSchema.parse(await boundedJson(request)); } catch { return Response.json({ error: "Provide a message, request id, local model and save choice." }, { status: 400 }); }
  try {
    // Exact-draft approval requires no inference and still works if Ollama goes offline.
    if (!input.answer) {
      const available = await localModels();
      if (!available.models.includes(input.model)) return Response.json({ error: "Choose an installed local model." }, { status: 400 });
    }
    const room = await documentRoom();
    const accepted = await room.submit(context, input);
    after(() => room.work(documentRoomDriver(() => revalidatePath("/"))));
    return Response.json({ id: input.id, ...accepted }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Question")) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: error instanceof Error && /message id|100-message/.test(error.message) ? error.message : "The room could not confirm acceptance. Reconnect and inspect your message before sending again." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  try { requestContext(request); } catch { return Response.json({ error: "A same-origin demo session is required." }, { status: 403 }); }
  const room = await documentRoom(); await room.stop();
  return Response.json({ status: "stopping" });
}

export async function DELETE(request: Request) {
  try { requestContext(request); } catch { return Response.json({ error: "A same-origin demo session is required." }, { status: 403 }); }
  try {
    const room = await documentRoom();
    const status = await room.reset();
    if (status === "busy") return Response.json({ error: "Stop the exchange and wait for it to finish before resetting." }, { status: 409 });
    if (status === "uncertain") return Response.json({ error: "A save outcome is still unknown. Reconcile it before clearing its evidence." }, { status: 409 });
    return Response.json({ status });
  } catch { return Response.json({ error: "Reset could not be confirmed. Reconnect to inspect the conversation." }, { status: 503 }); }
}
