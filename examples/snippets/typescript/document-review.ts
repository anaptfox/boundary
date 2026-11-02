/**
 * Executable README: local calls stand in for an editor, a CLI, and an assistant.
 * A real transport authenticates callers before constructing ReviewActor.
 */
import { reviewInteractions, reviewRejected, Suggestion } from "./document-review-interactions";
import { defineInteraction } from "@foxworth/boundary";

// #region imports
import { createReviewApplication } from "./document-review-host";
import type { ReviewActor } from "./document-review-store";
import {
  admitWhen, bindProjection, compileInteractions, direct,
  directRealizationIds, implementInteractions, installInteractions, projectInteractions,
} from "@foxworth/boundary";
// #endregion imports

export async function createDocumentReviewExample() {
  // #region surfaces
  const compiled = await compileInteractions(reviewInteractions);
  const editorSurface = await projectInteractions(compiled, {
    read: direct(compiled.handles.read),
    suggest: direct(compiled.handles.suggest),
    accept: direct(compiled.handles.accept),
  });
  const contributorSurface = await projectInteractions(compiled, {
    read: direct(compiled.handles.read),
    suggest: direct(compiled.handles.suggest),
  });
  // #endregion surfaces

  // #region installation
  const application = createReviewApplication();
  const implementations = implementInteractions<typeof reviewInteractions, ReviewActor>(reviewInteractions, {
    read: application.handlers.read,
    suggest: application.handlers.suggest,
    accept: application.handlers.accept,
  });
  const { installation } = await installInteractions(compiled, {
    installationId: "review:local:1",
    implementations,
    realizationIds: directRealizationIds(compiled, "release-1"),
  });
  // #endregion installation

  // #region connections
  const editorResult = await bindProjection(editorSurface, installation, {
    admit: admitWhen((actor: ReviewActor) => actor.kind === "editor", "Editor required"),
  });
  const contributorResult = await bindProjection(contributorSurface, installation, {
    admit: admitWhen(
      (actor: ReviewActor) => actor.kind === "script" || actor.kind === "assistant",
      "Contributor required",
    ),
  });
  if (editorResult.status !== "bound" || contributorResult.status !== "bound") {
    throw new Error("Review interfaces are unavailable");
  }
  const editor = editorResult.binding.connect();
  const contributor = contributorResult.binding.connect();
  // #endregion connections

  // #region actors
  // Local fixture identities. A remote host derives these from authentication.
  const editorActor: ReviewActor = { id: "alex", kind: "editor" };
  const scriptActor: ReviewActor = { id: "review-cli", kind: "script" };
  const assistantActor: ReviewActor = { id: "assistant", kind: "assistant" };
  // #endregion actors

  async function runReview() {
    // #region review
    const original = await contributor.call(contributorSurface.handles.read, {}, scriptActor);
    await contributor.call(contributorSurface.handles.suggest, {
      id: "cli-1", text: "Launch on Monday.", basedOnRevision: original.revision,
    }, scriptActor);
    const suggestion = await contributor.call(contributorSurface.handles.suggest, {
      id: "assistant-1", text: "Launch on Tuesday.", basedOnRevision: original.revision,
    }, assistantActor);
    // The document is still "Launch on Friday." Both changes are suggestions.

    const accepted = await editor.call(editorSurface.handles.accept, {
      suggestionId: suggestion.id,
    }, editorActor);
    // accepted: { text: "Launch on Tuesday.", revision: 1 }
    // #endregion review
    return accepted;
  }

  async function replaceImplementation() {
    // A fresh set of implementation functions shares the application-owned store.
    const replacementApplication = createReviewApplication(application.store);
    const { installation: replacement } = await installInteractions(compiled, {
      installationId: "review:local:2",
      implementations: implementInteractions<typeof reviewInteractions, ReviewActor>(reviewInteractions, replacementApplication.handlers),
      realizationIds: directRealizationIds(compiled, "release-2"),
    });
    const result = await bindProjection(contributorSurface, replacement, {
      admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
    });
    if (result.status !== "bound") throw new Error("Replacement is unavailable");
    return { caller: result.binding.connect(), dispatches: replacementApplication.dispatches };
  }

  async function tryChangedContract() {
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
    const changed = await compileInteractions(changedInteractions);
    const dispatches: string[] = [];
    const { installation: changedInstallation } = await installInteractions(changed, {
      installationId: "review:auto-apply:1",
      implementations: implementInteractions<typeof changedInteractions, ReviewActor>(changedInteractions, {
        read() { dispatches.push("read"); return application.store.read(); },
        suggest(input) { dispatches.push("suggest"); return input; },
        accept(input, actor) { dispatches.push("accept"); return application.handlers.accept(input, actor); },
      }),
      realizationIds: directRealizationIds(changed, "release-1"),
    });
    const result = await bindProjection(contributorSurface, changedInstallation, {
      admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
    });
    return { result, dispatches };
  }

  return {
    application, editor, contributor, editorSurface, contributorSurface,
    editorBinding: editorResult.binding, contributorBinding: contributorResult.binding,
    editorActor, scriptActor, assistantActor, runReview, replaceImplementation, tryChangedContract,
  };
}
