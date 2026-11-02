import { describe, expect, it } from "vitest";
import { createDocumentReviewExample } from "../../examples/snippets/typescript/document-review";

describe("document review README example", () => {
  it("runs the CLI, assistant, and editor story against one document", async () => {
    const example = await createDocumentReviewExample();
    expect(await example.runReview()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
    expect(example.application.store.read()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
    expect(example.application.dispatches).toEqual(["read", "suggest", "suggest", "accept"]);
  });

  it("keeps suggestions separate from the document and refuses an unselected acceptance", async () => {
    const e = await createDocumentReviewExample();
    await e.contributor.suggest({ id: "s1", text: "Launch on Tuesday.", basedOnRevision: 0 }, e.assistantActor);
    expect(e.application.store.read()).toEqual({ text: "Launch on Friday.", revision: 0 });
    expect(Object.keys(e.contributor)).toEqual(["read", "suggest"]);
    expect(e.app.binding(e.contributor).resolve("document.accept")).toBeUndefined();
    const before = [...e.application.dispatches];
    // The contributor has no accept method; even reaching for one at runtime dispatches nothing.
    // @ts-expect-error The typed caller rejects this too; exercise the runtime boundary.
    expect(e.contributor.accept).toBeUndefined();
    expect(e.application.dispatches).toEqual(before);
    expect(e.application.store.read().revision).toBe(0);
  });

  it("checks admission even on the editor connection", async () => {
    const e = await createDocumentReviewExample();
    await expect(e.editor.accept({ suggestionId: "s1" }, e.assistantActor)).rejects.toThrow();
    expect(e.application.dispatches).toEqual([]);
  });

  it("keeps self-acceptance and stale-review rules in the application", async () => {
    const e = await createDocumentReviewExample();
    await e.editor.suggest({ id: "own", text: "Launch on Monday.", basedOnRevision: 0 }, e.editorActor);
    await expect(e.editor.accept({ suggestionId: "own" }, e.editorActor)).rejects.toThrow();
    expect(e.application.store.read().revision).toBe(0);
    await e.contributor.suggest({ id: "other", text: "Launch on Tuesday.", basedOnRevision: 0 }, e.assistantActor);
    await e.editor.accept({ suggestionId: "other" }, e.editorActor);
    await expect(e.editor.accept({ suggestionId: "own" }, { id: "another-editor", kind: "editor" })).rejects.toThrow();
    expect(e.application.store.read()).toEqual({ text: "Launch on Tuesday.", revision: 1 });
  });

  it("connects fresh implementations explicitly without moving the existing caller", async () => {
    const e = await createDocumentReviewExample();
    const replacement = await e.replaceImplementation();
    await replacement.caller.suggest({ id: "replacement", text: "Launch on Wednesday.", basedOnRevision: 0 }, e.assistantActor);
    expect(replacement.dispatches).toEqual(["suggest"]);
    expect(e.application.dispatches).toEqual([]);
    await e.contributor.read({}, e.assistantActor);
    expect(e.application.dispatches).toEqual(["read"]);
    expect(await e.editor.accept({ suggestionId: "replacement" }, e.editorActor)).toEqual({ text: "Launch on Wednesday.", revision: 1 });
  });

  it("refuses a broader declared write footprint before dispatching anything", async () => {
    const e = await createDocumentReviewExample();
    const changed = await e.tryChangedContract();
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
