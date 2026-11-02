/** Ordinary application state and rules; no Boundary runtime or dispatcher. */
export type ReviewActor = Readonly<{
  id: string;
  kind: "editor" | "script" | "assistant";
}>;
type Suggestion = { id: string; text: string; basedOnRevision: number };

export class ReviewRejected extends Error {}

export function createReviewStore() {
  let document = { text: "Launch on Friday.", revision: 0 };
  const suggestions = new Map<string, Suggestion & { authorId: string; accepted: boolean }>();

  return {
    read() { return { ...document }; },
    suggest(input: Suggestion, actor: ReviewActor) {
      if (suggestions.has(input.id)) throw new ReviewRejected("Suggestion ID already exists");
      if (input.basedOnRevision !== document.revision) throw new ReviewRejected("Document has changed");
      suggestions.set(input.id, { ...input, authorId: actor.id, accepted: false });
      return { ...input };
    },
    accept(suggestionId: string, actor: ReviewActor) {
      if (actor.kind !== "editor") throw new ReviewRejected("Only an editor can accept");
      const suggestion = suggestions.get(suggestionId);
      if (!suggestion) throw new ReviewRejected("Suggestion does not exist");
      if (suggestion.authorId === actor.id) throw new ReviewRejected("Another editor must review your suggestion");
      if (suggestion.accepted) throw new ReviewRejected("Suggestion was already accepted");
      if (suggestion.basedOnRevision !== document.revision) throw new ReviewRejected("Document has changed");
      document = { text: suggestion.text, revision: document.revision + 1 };
      suggestion.accepted = true;
      return { ...document };
    },
  };
}
