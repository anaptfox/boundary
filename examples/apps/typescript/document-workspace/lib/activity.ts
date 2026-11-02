import { randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import path from "node:path";
import type { InvocationObservation } from "@foxworth/boundary/program";
import type { DemoContext } from "./context";
import type { ActivityEvent, EntryPoint } from "./activity-types";

export function tracedContext(context: DemoContext, source: EntryPoint): DemoContext {
  return { ...context, trace: { id: randomUUID(), source, ...(context.assistantAgent ? { agent: context.assistantAgent } : {}) } };
}
const logPath = () => path.join(process.env.BOUNDARY_FOLIO_DATA_DIR ?? path.join(process.cwd(), "data"), "activity.jsonl");

/** Bounded public diagnostic fields only: never prompts, document bodies, or cookies. */
export async function recordActivity(context: DemoContext, event: Omit<ActivityEvent, "id" | "time" | "callId" | "source" | "session">): Promise<void> {
  if (!context.trace) return;
  const entry: ActivityEvent = {
    ...event, id: randomUUID(), time: new Date().toISOString(),
    callId: context.trace.id, source: context.trace.source, session: context.session,
    ...(context.trace.agent ? { agent: context.trace.agent } : {}),
  };
  try { await appendFile(logPath(), `${JSON.stringify(entry)}\n`, "utf8"); }
  catch { /* Diagnostic delivery cannot rewrite an interaction's outcome. */ }
}

export async function recordObservation(event: InvocationObservation): Promise<void> {
  const correlation = event.correlation;
  if (!correlation || typeof correlation !== "object" || Array.isArray(correlation) || !("id" in correlation) || !("source" in correlation) || !("session" in correlation)) return;
  const { id, source, session } = correlation;
  if (typeof id !== "string" || typeof source !== "string" || (session !== "alice" && session !== "bob")) return;
  const agent = "agent" in correlation && (correlation.agent === "scout" || correlation.agent === "editor") ? correlation.agent : undefined;
  await recordActivity({ session, canEdit: false, documentId: "doc-1", trace: { id, source: source as EntryPoint, ...(agent ? { agent } : {}) } }, {
    stage: "outcome", interactionId: event.interactionId,
    detail: event.resultKind === "declared-error" ? "Declared revision conflict; document was not overwritten."
      : event.resultKind === "denied" ? "Host admission denied this invocation before execution."
      : event.resultKind === "returned" ? "The bound interaction returned successfully."
      : "Inspect the reported certainty before another attempt.",
    bindingDigest: event.bindingDigest, projectionDigest: event.projectionDigest,
    resultKind: event.resultKind, certainty: event.certainty,
  });
}

/** Read only a bounded tail. This is local diagnostic history, not a durable receipt journal. */
export async function readActivity(): Promise<ActivityEvent[]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(logPath(), "r");
    const { size } = await file.stat();
    const start = Math.max(0, size - 128_000);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines: string[] = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => { try { return line ? [JSON.parse(line) as ActivityEvent] : []; } catch { return []; } }).slice(-100);
  } catch { return []; }
  finally { await file?.close(); }
}
