// #region read
import { z } from "zod";
import { defineInteraction } from "@foxworth/boundary";

const Document = z.strictObject({ text: z.string(), revision: z.number().int().nonnegative() });
const readDocument = defineInteraction({
  id: "document.read",
  input: z.strictObject({}),
  output: Document,
  reads: ["document"],
});
// #endregion read

// #region review-data
export const Suggestion = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  basedOnRevision: z.number().int().nonnegative(),
});
export const reviewRejected = z.strictObject({ reason: z.string() });
// #endregion review-data

// #region suggest
const suggestChange = defineInteraction({
  id: "document.suggest",
  input: Suggestion,
  output: Suggestion,
  errors: { reviewRejected },
  reads: ["document", "suggestions"],
  changes: ["suggestions"],
});
// #endregion suggest

// #region accept
const acceptSuggestion = defineInteraction({
  id: "document.accept",
  input: z.strictObject({ suggestionId: z.string() }),
  output: Document,
  errors: { reviewRejected },
  reads: ["document", "suggestions"],
  changes: ["document", "suggestions"],
});
// #endregion accept

// #region interactions
export const reviewInteractions = {
  read: readDocument,
  suggest: suggestChange,
  accept: acceptSuggestion,
};
// #endregion interactions

export type ReviewDocument = z.infer<typeof Document>;
export type ReviewSuggestion = z.infer<typeof Suggestion>;
