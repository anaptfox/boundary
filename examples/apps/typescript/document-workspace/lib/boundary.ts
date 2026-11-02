import { z } from "zod";
import { join } from "node:path";
import { contributeControlRequests } from "@foxworth/boundary/control/host";
import { admitAll, declaredInteractionError, defineInteraction, type Admission } from "@foxworth/boundary";
import { bindSurface, restrictBinding, compileInteractions, implementInteractions, installInteractions, projectInteractions, type InvocationObserver, type InteractionInstallation, createCaller } from "@foxworth/boundary/pipeline";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import { DocumentConflictError, readDocument, saveDocument } from "./documents";
import type { DemoContext } from "./context";
import { parseRichText } from "./rich-text";
import { recordActivity, recordObservation, tracedContext } from "./activity";
import type { EntryPoint } from "./activity-types";
import { createPublicationControl, publicationActor, PublishInput, Published, PublicationStatus } from "./publication";

const DocumentSchema = z.strictObject({
  id: z.literal("doc-1"),
  title: z.string(),
  body: z.string(),
  richText: z.string().max(100_000).optional(),
  revision: z.number().int().positive(),
});
const DocumentInput = z.strictObject({ id: z.literal("doc-1") });
const SaveInput = z.strictObject({
  id: z.literal("doc-1"),
  title: z.string().min(1),
  body: z.string().min(1),
  richText: z.string().max(100_000).optional(),
  expectedRevision: z.number().int().positive(),
});
const Conflict = z.strictObject({ expectedRevision: z.number().int().positive(), actualRevision: z.number().int().positive() });
export const documentSchemas = { read: DocumentInput, save: SaveInput, publish: PublishInput } as const;

const interactions = {
  publish: defineInteraction({ id: "documents.publish", input: PublishInput, output: Published, reads: ["documents"], changes: ["publications"], description: "Request human review of an exact saved revision. This does not publish or approve." }),
  publicationStatus: defineInteraction({ id: "documents.publicationStatus", input: DocumentInput, output: PublicationStatus, reads: ["publications"], changes: [], description: "Read public publication progress without administrative authority." }),
  get: defineInteraction({
    id: "documents.get",
    input: DocumentInput,
    output: DocumentSchema,
    reads: ["documents"],
    changes: [],
    description: "Read the selected document.",
  }),
  save: defineInteraction({
    id: "documents.save",
    input: SaveInput,
    output: DocumentSchema,
    errors: { conflict: Conflict },
    reads: [],
    changes: ["documents"],
    description: "Save one selected document revision.",
  }),
} as const;

const compiled = await compileInteractions(interactions);
let currentInstallation: InteractionInstallation<DemoContext>;
export const publications = await createPublicationControl({ interaction: compiled.handles.publish,
  installation: () => currentInstallation,
  database: process.env.BOUNDARY_FOLIO_PUBLICATIONS ?? join(process.cwd(), "data/publications.sqlite"),
  sourceRoot: process.env.BOUNDARY_FOLIO_SOURCE_ROOT ?? process.cwd(),
  readDocument: async () => { const document = await readDocument("doc-1"); if (!document) throw new Error("Document not found"); return document; },
});
const implementations = implementInteractions<typeof interactions, DemoContext>(interactions, {
  publish() { throw new Error("Publication is available only through exact Control review"); },
  publicationStatus: (_input, context) => publications.view(context),
  async get(input, context) {
    if (input.id !== context.documentId) throw new Error("document is outside the session scope");
    const document = await readDocument(input.id);
    if (!document) throw new Error("document not found");
    return document;
  },
  async save(input, context) {
    if (input.id !== context.documentId || !context.canEdit) throw new Error("save is not allowed for this session");
    try {
      const saved = await saveDocument(input);
      await recordActivity(context, { stage: "state", interactionId: "documents.save", detail: "Application storage persisted the new revision.", revision: saved.revision });
      return saved;
    } catch (error) {
      if (error instanceof DocumentConflictError) {
        throw declaredInteractionError(interactions.save, "conflict", {
          expectedRevision: input.expectedRevision,
          actualRevision: error.actualRevision,
        });
      }
      throw error;
    }
  },
});
const { installation } = await installInteractions<typeof interactions, DemoContext>(compiled, {
  installationId: "next-native-demo:documents:rich-text",
  implementations,
  requests: contributeControlRequests(compiled, publications.requester, { publish: { interaction: compiled.handles.publish, control: publications.control, executionRealizationId: "folio:publish:execute:1", actor: publicationActor } }),
  realizationIds: {
    publish: { direct: "folio:publish:disabled", request: "folio:publish:request:1" },
    publicationStatus: { direct: "folio:publication-status:1" },
    get: { direct: "next-native-demo:documents.get:1" },
    save: { direct: "next-native-demo:documents.save:rich-text" },
  },
});
currentInstallation = installation;
export const projection = await projectInteractions(compiled, {
  publish: { interaction: compiled.handles.publish, modes: ["request"] },
  publicationStatus: { interaction: compiled.handles.publicationStatus, modes: ["direct"] },
  get: { interaction: compiled.handles.get, modes: ["direct"] },
  save: { interaction: compiled.handles.save, modes: ["direct"] },
});
// A read-only agent gets its own CompiledSurface and a restricted Binding. Narrowing
// happens here, where it is enforced, not in a tool list a model happens to
// receive: an interaction absent from this CompiledSurface is absent from the
// Binding and cannot be reached through it at all.
export const readProjection = await projectInteractions(compiled, {
  publicationStatus: { interaction: compiled.handles.publicationStatus, modes: ["direct"] },
  get: { interaction: compiled.handles.get, modes: ["direct"] },
});
const bindOptions: Readonly<{
  admit: Admission<DemoContext>;
  observation: InvocationObserver<DemoContext>;
}> = {
  observation: {
    correlate: (context) => context.trace ? { ...context.trace, session: context.session } : null,
    publish: recordObservation,
  },
  admit: async ({ context, handle, input }) => {
    const id = (input as { id?: unknown }).id;
    const expectedRevision = (input as { expectedRevision?: number }).expectedRevision;
    await recordActivity(context, { stage: "invocation", interactionId: handle.interactionId,
      detail: `Selected ${String(id)}; ${context.canEdit ? "editor" : "reader"} session derived by the server.`,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    let reason: string | undefined;
    if (context.delegation?.workspace && context.delegation.workspace !== "folio") reason = "document is outside delegated workspace";
    if (handle.interactionId === "documents.save" && context.delegation && !context.delegation.mayDraft) reason = "this delegation is read-only";
    if (handle.interactionId === "documents.publish" && (!context.canEdit || context.assistantAgent === "scout" || (context.delegation && !context.delegation.mayDraft))) reason = "publication requests require editor scope";
    if (id !== context.documentId) reason = "document is outside session scope";
    if (handle.interactionId === "documents.save" && !context.canEdit) reason = "this demo session is read-only";
    if (handle.interactionId === "documents.save" && context.trace?.source === "assistant" && !context.assistantMaySave) reason = "this assistant turn is read-only";
    if (handle.interactionId === "documents.save" && context.assistantAgent === "scout") reason = "Scout has read access only";
    if (handle.interactionId === "documents.save") {
      const richText = (input as { richText?: string }).richText;
      if (richText !== undefined && !parseRichText(richText)) {
        reason = "invalid rich-text document";
      }
    }
    const decision = reason ? "deny" : "allow";
    await recordActivity(context, { stage: "policy", interactionId: handle.interactionId, decision, detail: reason ?? "Host policy permits this interaction in the current session." });
    return reason ? { decision: "deny", reason } : { decision: "allow" };
  },
};
const result = await bindSurface(projection, installation, bindOptions);
if (result.status !== "bound") throw new Error("next-native demo Binding was not realized");
export const binding = result.binding;
export const caller = createCaller(binding);
const readResult = await restrictBinding(binding, { projection: readProjection, admit: admitAll });
if (readResult.status !== "bound") throw new Error("next-native demo read Binding was not realized");
export const readBinding = readResult.binding;
export const readCaller = createCaller(readBinding);

export function documentCaller(
  context: () => DemoContext | Promise<DemoContext>,
  afterAction?: () => void | Promise<void>,
  source?: EntryPoint,
) {
  return createNextServerCaller({ caller,
    context: async () => { const current = await context(); return source ? tracedContext(current, source) : current; },
    afterAction: async (completion) => {
      if (!afterAction) return;
      await afterAction();
      await recordActivity(completion.context, { stage: "refresh", interactionId: completion.interactionId, detail: "Next.js revalidatePath('/') completed after the successful interaction." });
    },
  });
}
