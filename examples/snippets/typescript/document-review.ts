/**
 * Executable README: local calls stand in for an editor, a CLI, and an assistant.
 * A real transport authenticates callers before constructing ReviewActor.
 */
import { reviewInteractions, reviewRejected, Suggestion } from "./document-review-interactions";
import { defineInteraction } from "@foxworth/boundary";

// #region imports
import { createReviewApplication } from "./document-review-host";
import type { ReviewActor } from "./document-review-store";
import { admitWhen, install, surface } from "@foxworth/boundary";
// #endregion imports

export async function createDocumentReviewExample() {
  // #region surfaces
  const editorSurface = surface(reviewInteractions, { call: ["read", "suggest", "accept"] });
  const contributorSurface = surface(reviewInteractions, { call: ["read", "suggest"] });
  // #endregion surfaces

  // #region installation
  const application = createReviewApplication();
  const app = await install(reviewInteractions, {
    id: "review:local:1",
    version: "release-1",
    handlers: application.handlers,
  });
  // #endregion installation

  // #region connections
  const editor = await app.connect(editorSurface, {
    admit: admitWhen((actor: ReviewActor) => actor.kind === "editor", "Editor required"),
  });
  const contributor = await app.connect(contributorSurface, {
    admit: admitWhen(
      (actor: ReviewActor) => actor.kind === "script" || actor.kind === "assistant",
      "Contributor required",
    ),
  });
  // #endregion connections

  // #region actors
  // Local fixture identities. A remote host derives these from authentication.
  const editorActor: ReviewActor = { id: "alex", kind: "editor" };
  const scriptActor: ReviewActor = { id: "review-cli", kind: "script" };
  const assistantActor: ReviewActor = { id: "assistant", kind: "assistant" };
  // #endregion actors

  async function runReview() {
    // #region review
    const original = await contributor.read({}, scriptActor);
    await contributor.suggest({
      id: "cli-1", text: "Launch on Monday.", basedOnRevision: original.revision,
    }, scriptActor);
    const suggestion = await contributor.suggest({
      id: "assistant-1", text: "Launch on Tuesday.", basedOnRevision: original.revision,
    }, assistantActor);
    // The document is still "Launch on Friday." Both changes are suggestions.

    const accepted = await editor.accept({ suggestionId: suggestion.id }, editorActor);
    // accepted: { text: "Launch on Tuesday.", revision: 1 }
    // #endregion review
    return accepted;
  }

  async function replaceImplementation() {
    // #region replacement
    // A fresh set of implementation functions shares the application-owned store.
    const replacementApplication = createReviewApplication(application.store);
    const replacement = await install(reviewInteractions, {
      id: "review:local:2",
      version: "release-2",
      handlers: replacementApplication.handlers,
    });
    const assistant = await replacement.connect(contributorSurface, {
      admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
    });
    // The editor and the contributor above stay attached to the first installation.
    // #endregion replacement
    return { caller: assistant, dispatches: replacementApplication.dispatches };
  }

  async function tryChangedContract() {
    // #region changed-contract
    // It now changes the document too. The old read-and-suggest surface must fail,
    // even though the interaction ID, inputs, and outputs have stayed the same.
    const changedInteractions = {
      ...reviewInteractions,
      suggest: defineInteraction({
        id: "document.suggest",
        input: Suggestion, output: Suggestion,
        errors: { reviewRejected },
        reads: ["document", "suggestions"],
        changes: ["suggestions", "document"],
      }),
    };
    const dispatches: string[] = [];
    const changed = await install(changedInteractions, {
      id: "review:auto-apply:1",
      version: "release-1",
      handlers: {
        read() { dispatches.push("read"); return application.store.read(); },
        suggest(input) { dispatches.push("suggest"); return input; },
        accept(input, actor: ReviewActor) { dispatches.push("accept"); return application.handlers.accept(input, actor); },
      },
    });
    const result = await changed.tryConnect(contributorSurface, {
      admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
    });
    // result.status === "unrealized": suggest's declared write footprint grew.
    // #endregion changed-contract
    return { result, dispatches };
  }

  return {
    application, app, editor, contributor, editorSurface, contributorSurface,
    editorActor, scriptActor, assistantActor, runReview, replaceImplementation, tryChangedContract,
  };
}
