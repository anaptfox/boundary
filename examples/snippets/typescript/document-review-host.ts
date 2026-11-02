import { declaredInteractionError } from "@foxworth/boundary";
import { reviewInteractions, type ReviewSuggestion } from "./document-review-interactions";
import { createReviewStore, ReviewRejected, type ReviewActor } from "./document-review-store";

/** The application supplies state, implementations, and rejection semantics. */
export function createReviewApplication(store = createReviewStore()) {
  const dispatches: string[] = [];
  const handlers = {
    read() {
      dispatches.push("read");
      return store.read();
    },
    suggest(input: ReviewSuggestion, actor: ReviewActor) {
      dispatches.push("suggest");
      try { return store.suggest(input, actor); }
      catch (error) {
        if (error instanceof ReviewRejected) {
          throw declaredInteractionError(reviewInteractions.suggest, "reviewRejected", { reason: error.message });
        }
        throw error;
      }
    },
    accept({ suggestionId }: { suggestionId: string }, actor: ReviewActor) {
      dispatches.push("accept");
      try { return store.accept(suggestionId, actor); }
      catch (error) {
        if (error instanceof ReviewRejected) {
          throw declaredInteractionError(reviewInteractions.accept, "reviewRejected", { reason: error.message });
        }
        throw error;
      }
    },
  };
  return { store, handlers, dispatches };
}
