// #region hero-interactions
import { b, defineInteraction, type InferSchema } from "@foxworth/boundary";

const Document = b.object({ text: b.string(), revision: b.integer({ minimum: 0 }) });
export const Suggestion = b.object({
  id: b.string({ minLength: 1 }),
  text: b.string({ minLength: 1 }),
  basedOnRevision: b.integer({ minimum: 0 }),
});
export const reviewRejected = b.object({ reason: b.string() });

export const reviewInteractions = {
  read: defineInteraction({
    id: "document.read",
    output: Document,
    reads: ["document"],
  }),
  suggest: defineInteraction({
    id: "document.suggest",
    input: Suggestion,
    output: Suggestion,
    errors: { reviewRejected },
    reads: ["document", "suggestions"],
    changes: ["suggestions"],
  }),
  accept: defineInteraction({
    id: "document.accept",
    input: b.object({ suggestionId: b.string() }),
    output: Document,
    errors: { reviewRejected },
    reads: ["document", "suggestions"],
    changes: ["document", "suggestions"],
  }),
} as const;
// #endregion hero-interactions

export type ReviewDocument = InferSchema<typeof Document>;
export type ReviewSuggestion = InferSchema<typeof Suggestion>;
