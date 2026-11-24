/**
 * Executable README: local calls stand in for an editor, a CLI, and an assistant.
 * A real transport authenticates callers before constructing ReviewActor.
 */
import { createReviewApplication } from "./document-review-host";
import { reviewInteractions, reviewRejected, Suggestion } from "./document-review-interactions";
import type { ReviewActor } from "./document-review-store";
import {
  admitWhen,
  bindProjection,
  compileInteractions,
  createHost,
  defineInteraction,
  installInteractions,
  pickProjection,
  realizeDirect,
} from "@foxworth/boundary";

export function createQuickHostExample() {
  const application = createReviewApplication();
  const editorActor: ReviewActor = { id: "alex", kind: "editor" };
  const assistantActor: ReviewActor = { id: "assistant", kind: "assistant" };

  // #region hero-host
  const host = createHost(reviewInteractions, {
    installationId: "review:local:1",
    realizationVersion: "release-1",
    handlers: application.handlers,
    callers: {
      editor: {
        direct: ["read", "suggest", "accept"],
        admit: (actor: ReviewActor) => actor.kind === "editor",
      },
      assistant: {
        direct: ["read", "suggest"], // no `accept` — absent at compile time and runtime
        admit: (actor: ReviewActor) => actor.kind === "assistant",
      },
    },
  });
  // #endregion hero-host

  async function runQuickReview() {
    // #region hero-calls
    const doc = await host.callers.assistant.read(assistantActor);
    const proposal = await host.callers.assistant.suggest(
      { id: "s1", text: "Launch on Tuesday.", basedOnRevision: doc.revision },
      assistantActor,
    );
    // Document still says "Launch on Friday." — only suggestions changed.

    const outcome = await host.tryCallers.editor.accept(
      { suggestionId: proposal.id },
      editorActor,
    );
    if (outcome.kind === "ok") {
      return outcome.value; // { text: "Launch on Tuesday.", revision: 1 }
    }
    throw new Error(`Accept did not complete: ${outcome.kind}`);
    // #endregion hero-calls
  }

  return { host, application, editorActor, assistantActor, runQuickReview };
}

export function createDocumentReviewExample() {
  // #region algebra
  const compiled = compileInteractions(reviewInteractions);

  const editorSurface = compiled.projectAll("direct");
  const contributorSurface = pickProjection(editorSurface, "read", "suggest");
  // Pure, synchronous values — no handlers or runtime required yet.
  // #endregion algebra

  const application = createReviewApplication();
  const { installation } = installInteractions<typeof reviewInteractions, ReviewActor>(compiled, {
    installationId: "review:local:1",
    realizations: {
      read: realizeDirect(application.handlers.read, "read:release-1"),
      suggest: realizeDirect(application.handlers.suggest, "suggest:release-1"),
      accept: realizeDirect(application.handlers.accept, "accept:release-1"),
    },
  });

  const editorResult = bindProjection(editorSurface, installation, {
    admit: admitWhen((actor: ReviewActor) => actor.kind === "editor", "Editor required"),
  });
  const contributorResult = bindProjection(contributorSurface, installation, {
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

  // Local fixture identities. A remote host derives these from authentication.
  const editorActor: ReviewActor = { id: "alex", kind: "editor" };
  const scriptActor: ReviewActor = { id: "review-cli", kind: "script" };
  const assistantActor: ReviewActor = { id: "assistant", kind: "assistant" };

  async function runReview() {
    const original = await contributor.call(contributorSurface.handles.read, scriptActor);
    await contributor.call(contributorSurface.handles.suggest, {
      id: "cli-1", text: "Launch on Monday.", basedOnRevision: original.revision,
    }, scriptActor);
    const suggestion = await contributor.call(contributorSurface.handles.suggest, {
      id: "assistant-1", text: "Launch on Tuesday.", basedOnRevision: original.revision,
    }, assistantActor);

    const accepted = await editor.call(editorSurface.handles.accept, {
      suggestionId: suggestion.id,
    }, editorActor);
    return accepted;
  }

  function replaceImplementation() {
    const replacementApplication = createReviewApplication(application.store);
    const { installation: replacement } = installInteractions<typeof reviewInteractions, ReviewActor>(compiled, {
      installationId: "review:local:2",
      realizations: {
        read: realizeDirect(replacementApplication.handlers.read, "read:release-2"),
        suggest: realizeDirect(replacementApplication.handlers.suggest, "suggest:release-2"),
        accept: realizeDirect(replacementApplication.handlers.accept, "accept:release-2"),
      },
    });
    const result = bindProjection(contributorSurface, replacement, {
      admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
    });
    if (result.status !== "bound") throw new Error("Replacement is unavailable");
    return { caller: result.binding.connect(), dispatches: replacementApplication.dispatches };
  }

  function tryChangedContract() {
    // `suggest` now claims to change the document too. Even though its ID,
    // input, and output are unchanged, binding the existing contributor surface
    // must fail before dispatching anything.
    const changedInteractions = {
      ...reviewInteractions,
      suggest: defineInteraction({
        id: "document.suggest",
        input: Suggestion,
        output: Suggestion,
        errors: { reviewRejected },
        reads: ["document", "suggestions"],
        changes: ["suggestions", "document"],
      }),
    } as const;
    const changed = compileInteractions(changedInteractions);
    const dispatches: string[] = [];
    const { installation: changedInstallation } = installInteractions<typeof changedInteractions, ReviewActor>(changed, {
      installationId: "review:auto-apply:1",
      realizations: {
        read: realizeDirect(() => { dispatches.push("read"); return application.store.read(); }, "read:v1"),
        suggest: realizeDirect((input: unknown) => { dispatches.push("suggest"); return input; }, "suggest:v1"),
        accept: realizeDirect(
          (input: { suggestionId: string }, actor: ReviewActor) => {
            dispatches.push("accept");
            return application.handlers.accept(input, actor);
          },
          "accept:v1",
        ),
      },
    });
    const result = bindProjection(contributorSurface, changedInstallation, {
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
