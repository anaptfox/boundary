import { tool } from "ai";
import type { DemoContext } from "./context";
import { documentCaller, documentSchemas, projection } from "./boundary";
import { saveFailure } from "./save-result";
import type { Document } from "./documents";
import type { AgentId } from "./agents";

/** Tool schemas are the application's actual interaction schemas, not a parallel model. */
export function createDocumentTools(context: () => DemoContext, afterSave: () => void, signal?: AbortSignal, agent: AgentId = "editor", claimSave?: () => Promise<boolean>) {
  const caller = documentCaller(() => ({ ...context(), assistantAgent: agent }), afterSave, "assistant");
  let attemptedSave = false;
  let observed: Document | undefined;
  async function readCurrent() {
    if (signal?.aborted) throw new Error("turn aborted before read");
    observed = await caller.read.get({ id: "doc-1" });
    return observed;
  }
  return {
    readCurrent,
    attemptedSave: () => attemptedSave,
    tools: {
      request_publication: tool({
        description: "Request human review of an exact saved revision. Never approves or publishes. Alice reviews the publication card separately.",
        inputSchema: documentSchemas.publish,
        execute: async input => {
          if (signal?.aborted) return { status: "not-started" as const };
          return caller.action.propose.publish(input);
        },
      }),
      read_document: tool({
        description: "Read the current document, including its exact revision. Call this before answering questions or saving. The only document id is doc-1.",
        inputSchema: documentSchemas.read,
        execute: async () => {
          if (signal?.aborted) return { status: "not-started" as const };
          return readCurrent();
        },
      }),
      save_document: tool({
        description: "Save a document revision through documents.save. Use the exact expectedRevision you read. Never retry a save. Requires editor access and this room exchange's explicit approval of the exact draft.",
        inputSchema: documentSchemas.save,
        execute: async (input) => {
          if (attemptedSave || signal?.aborted) return { status: "not-started" as const, reason: "No further save attempt is permitted in this turn." };
          attemptedSave = true;
          if (claimSave && !await claimSave()) return { status: "not-started" as const, reason: "This room exchange has no remaining save permission." };
          // Preserve exact observed formatting for title-only edits. A body rewrite
          // without richText deliberately becomes plain text, as for other callers.
          const richText = input.richText ?? (observed && input.expectedRevision === observed.revision && input.body === observed.body ? observed.richText : undefined);
          try {
            const saved = await caller.action.save({ ...input, ...(richText ? { richText } : {}) });
            return { status: "saved" as const, revision: saved.revision, title: saved.title };
          } catch (error) {
            return saveFailure(error, projection.handles.save);
          }
        },
      }),
    },
  };
}
