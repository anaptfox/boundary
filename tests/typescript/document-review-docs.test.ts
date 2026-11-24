import { describe, expect, it } from "vitest";
import {
  createDocumentReviewExample,
  createQuickHostExample,
} from "../../examples/snippets/typescript/document-review";

describe("document review README example", () => {
  it("runs the quick createHost hero example with typed outcomes", async () => {
    const quick = createQuickHostExample();
    expect(await quick.runQuickReview()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
    expect(quick.application.dispatches).toEqual(["read", "suggest", "accept"]);
    expect("accept" in quick.host.callers.assistant).toBe(false);
    const denied = await quick.host.tryCallers.editor.accept(
      { suggestionId: "s1" },
      quick.assistantActor,
    );
    expect(denied.kind).toBe("denied");
  });

  it("runs the CLI, assistant, and editor story against one document", async () => {
    const example = createDocumentReviewExample();
    expect(await example.runReview()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
    expect(example.application.store.read()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
    expect(example.application.dispatches).toEqual(["read", "suggest", "suggest", "accept"]);
  });

  it("keeps suggestions separate from the document and refuses an unselected acceptance", async () => {
    const e = createDocumentReviewExample();
    await e.contributor.call(e.contributorSurface.handles.suggest, {
      id: "s1", text: "Launch on Tuesday.", basedOnRevision: 0,
    }, e.assistantActor);
    expect(e.application.store.read()).toEqual({ text: "Launch on Friday.", revision: 0 });
    expect(e.contributorBinding.resolve("document.accept")).toBeUndefined();
    const before = [...e.application.dispatches];
    // Even possession of the editor's handle cannot expand this connection.
    // @ts-expect-error The typed caller rejects this too; exercise the runtime boundary.
    await expect(e.contributor.call(e.editorSurface.handles.accept, {
      suggestionId: "s1",
    }, e.assistantActor)).rejects.toThrow();
    expect(e.application.dispatches).toEqual(before);
    expect(e.application.store.read().revision).toBe(0);
  });

  it("checks admission even on the editor connection", async () => {
    const e = createDocumentReviewExample();
    await expect(e.editor.call(e.editorSurface.handles.accept, {
      suggestionId: "s1",
    }, e.assistantActor)).rejects.toThrow();
    expect(e.application.dispatches).toEqual([]);
  });

  it("keeps self-acceptance and stale-review rules in the application", async () => {
    const e = createDocumentReviewExample();
    await e.editor.call(e.editorSurface.handles.suggest, {
      id: "own", text: "Launch on Monday.", basedOnRevision: 0,
    }, e.editorActor);
    await expect(e.editor.call(e.editorSurface.handles.accept, {
      suggestionId: "own",
    }, e.editorActor)).rejects.toThrow();
    expect(e.application.store.read().revision).toBe(0);
    await e.contributor.call(e.contributorSurface.handles.suggest, {
      id: "other", text: "Launch on Tuesday.", basedOnRevision: 0,
    }, e.assistantActor);
    await e.editor.call(e.editorSurface.handles.accept, { suggestionId: "other" }, e.editorActor);
    await expect(e.editor.call(e.editorSurface.handles.accept, {
      suggestionId: "own",
    }, { id: "another-editor", kind: "editor" })).rejects.toThrow();
    expect(e.application.store.read()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
  });

  it("binds fresh implementations explicitly without moving the existing caller", async () => {
    const e = createDocumentReviewExample();
    const replacement = e.replaceImplementation();
    await replacement.caller.call(e.contributorSurface.handles.suggest, {
      id: "replacement", text: "Launch on Wednesday.", basedOnRevision: 0,
    }, e.assistantActor);
    expect(replacement.dispatches).toEqual(["suggest"]);
    expect(e.application.dispatches).toEqual([]);
    await e.contributor.call(e.contributorSurface.handles.read, e.assistantActor);
    expect(e.application.dispatches).toEqual(["read"]);
    expect(await e.editor.call(e.editorSurface.handles.accept, {
      suggestionId: "replacement",
    }, e.editorActor)).toEqual({ text: "Launch on Wednesday.", revision: 1 });
  });

  it("refuses a broader declared write footprint before dispatching anything", () => {
    const e = createDocumentReviewExample();
    const changed = e.tryChangedContract();
    expect(changed.result.status).toBe("unrealized");
    if (changed.result.status !== "unrealized") throw new Error("Expected a contract refusal");
    expect(changed.result.report.issues).toEqual([
      expect.objectContaining({
        alias: "suggest", interactionId: "document.suggest", reason: "incompatible-contract",
      }),
    ]);
    expect(changed.dispatches).toEqual([]);
    expect(e.application.dispatches).toEqual([]);
    expect(e.application.store.read()).toEqual({ text: "Launch on Friday.", revision: 0 });
  });
});
