"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { saveDocumentAction, type SaveDocumentActionResult } from "./actions";
import { editorExtensions, parseRichText, plainDocument } from "../lib/rich-text";
import type { Document } from "../lib/documents";
import { Icon } from "./icons";
import { EditorToolbar } from "./editor-toolbar";
import { ConnectionDialog, SessionMenu } from "./workspace-parts";
import { AssistantPanel } from "./assistant-panel";
import { ActivityPanel } from "./activity-panel";
import { PublicationPanel } from "./publication-panel";
import type { PublicationView } from "../lib/publication";
import { FolioWebMcp } from "./webmcp";

const initial: SaveDocumentActionResult = { status: "idle" };

export function SaveForm({ document, canEdit, session, publicationView }: { document: Document; canEdit: boolean; session: "alice" | "bob"; publicationView: PublicationView }) {
  const [state, action, pending] = useActionState(saveDocumentAction, initial, "/");
  const [title, setTitle] = useState(document.title);
  const [body, setBody] = useState(document.body);
  const [richText, setRichText] = useState(() => JSON.stringify(
    (document.richText ? parseRichText(document.richText)?.json : undefined) ?? plainDocument(document.body),
  ));
  const [baseRevision, setBaseRevision] = useState(document.revision);
  const [dirty, setDirty] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const savedDraft = useRef({ title: document.title, richText });
  const form = useRef<HTMLFormElement>(null);
  const blocked = !canEdit || pending || state.status === "uncertain" || state.status === "conflict";
  const editor = useEditor({
    extensions: editorExtensions,
    immediatelyRender: false,
    content: JSON.parse(richText),
    editable: !blocked,
    editorProps: { attributes: { class: "document-prose", role: "textbox", "aria-label": "Document body", "aria-multiline": "true" } },
    onUpdate: ({ editor }) => {
      const value = JSON.stringify(editor.getJSON());
      setRichText(value);
      setBody(parseRichText(value)?.body ?? editor.getText());
      setDirty(value !== savedDraft.current.richText || title !== savedDraft.current.title);
    },
  });
  useEffect(() => { editor?.setEditable(!blocked, false); }, [editor, blocked]);
  useEffect(() => {
    if (state.status === "saved") {
      savedDraft.current = { title, richText };
      setBaseRevision(state.revision); setDirty(false);
    }
  }, [state]);
  useEffect(() => {
    if (document.revision === baseRevision || dirty || pending || state.status === "uncertain" || state.status === "conflict") return;
    const json = (document.richText ? parseRichText(document.richText)?.json : undefined) ?? plainDocument(document.body);
    const nextRichText = JSON.stringify(json);
    savedDraft.current = { title: document.title, richText: nextRichText };
    setTitle(document.title); setBody(document.body); setRichText(nextRichText); setBaseRevision(document.revision);
    editor?.commands.setContent(json, { emitUpdate: false });
  }, [document, baseRevision, dirty, pending, state.status, editor]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const needsReview = state.status === "conflict" || state.status === "uncertain";
  return <div className="workspace-shell single-document">
    <FolioWebMcp session={session} />
    <main className="workspace-main">
      <header className="topbar"><div className="folio-wordmark">folio<span>.</span><small>ONE DOCUMENT, TOGETHER</small></div><div className="topbar-tools"><a href="#activity" className="text-button">Live Boundary activity ↗</a><SessionMenu session={session} dirty={dirty} disabled={pending || assistantBusy} /></div></header>
      <div className="workspace-heading"><div><div className="eyebrow">NEXT.JS × BOUNDARY × OLLAMA</div><h1>Room to think together<span>.</span></h1><p>Your words. A couple of thoughtful collaborators. One shared document.</p></div><a className="chat-jump" href="#assistant">Meet your collaborators ↗</a></div>
      <div className="work-area">
        <form id="document" ref={form} action={action} className="document-form" onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (!blocked && dirty) form.current?.requestSubmit();
          }
        }}>
          <input type="hidden" name="id" value={document.id} />
          <input type="hidden" name="expectedRevision" value={baseRevision} />
          <input type="hidden" name="body" value={body} disabled={!editor} />
          <input type="hidden" name="richText" value={richText} disabled={!editor} />
          <div className="document-chrome"><span><Icon name="document" /> WORKING DOCUMENT</span><span className="revision-pill">REV {String(baseRevision).padStart(2, "0")}</span></div>
          <EditorToolbar editor={editor} disabled={blocked} />
          {!canEdit && <div className="notice read-only"><Icon name="lock" /><span>You’re reading as Bob. Switch to Alice to make changes.</span></div>}
          {document.revision > baseRevision && dirty && <div className="notice warning">A newer revision ({document.revision}) is saved. Your draft is preserved at revision {baseRevision}; saving it will check that starting revision. Copy your draft before reloading.</div>}
          <div className="paper">
            <div className="document-category"><span className="document-dot" /> FIELD NOTES <span className="category-line" /></div>
            <label className="sr-only" htmlFor="document-title">Document title</label>
            <textarea id="document-title" className="document-title" name="title" rows={1} value={title} onChange={(event) => { setTitle(event.target.value); setDirty(event.target.value !== savedDraft.current.title || richText !== savedDraft.current.richText); }} readOnly={blocked} required maxLength={500} placeholder="Untitled document" />
            <div className="document-byline"><span className={`tiny-avatar ${session}`}>{session === "alice" ? "A" : "B"}</span><span>Demo session: <strong>{session}</strong></span><span className="byline-dot">·</span><span>{canEdit ? "Editing access" : "Read-only access"}</span></div>
            <div className="paper-rule" />
            {editor ? <EditorContent editor={editor} /> : <textarea name="body" className="plain-editor" aria-label="Document body" value={body} readOnly={blocked} onChange={(event) => { setBody(event.target.value); setRichText(JSON.stringify(plainDocument(event.target.value))); setDirty(true); }} />}
            {canEdit && body.length < 100 && <p className="writing-hint">A good place to start: what are we making, and why does it matter?</p>}
          </div>
          <footer className="document-footer"><span>{words} {words === 1 ? "word" : "words"}<span className="footer-dot">·</span>{Math.max(1, Math.ceil(words / 200))} min read</span><span><Icon name={canEdit ? "check" : "lock"} /> {canEdit ? "Your changes stay yours until you save" : "Protected by server-side permissions"}</span></footer>
          <div className="save-bar"><div className={`save-state ${dirty ? "has-draft" : ""}`} role="status"><span className="status-dot" />{pending ? "Saving your revision…" : needsReview ? "Needs your attention" : dirty ? "Unsaved changes" : state.status === "saved" ? `Saved revision ${state.revision}.` : `Persisted revision ${baseRevision}`}<small>{dirty ? "Save when you’re ready." : "A clear starting point for your next change."}</small></div><button className="button primary" type="submit" disabled={blocked || !title.trim() || !body.trim()}><Icon name={canEdit ? "check" : "lock"} />{pending ? "Saving…" : canEdit ? "Save revision" : "Read only"}<kbd>⌘ S</kbd></button></div>
          {state.status === "conflict" && <div className="notice warning" role="alert"><div><strong>Document changed; current revision is {state.actualRevision}.</strong><p>Your draft is still here. Copy it before reloading to review the newer document. We haven’t retried the save.</p><a href="/" onClick={(event) => { if (!window.confirm("Reload the saved document? Copy your draft first; unsaved changes will be lost.")) event.preventDefault(); }}>Reload saved document →</a></div></div>}
          {state.status === "rejected" && !pending && <div className="notice warning" role="alert">Save was not accepted. Your draft is still here; check your session and document content.</div>}
          {state.status === "uncertain" && <div className="notice warning" role="alert"><div><strong>Save outcome is unknown.</strong><p>Copy your draft, then inspect the persisted revision before making another change. No automatic retry will run.</p><a href="/" target="_blank" rel="noreferrer">Inspect saved document in another tab →</a></div></div>}
        </form>
        <div className="workspace-rail"><AssistantPanel canEdit={canEdit} session={session} draftBusy={dirty || pending || needsReview} onBusyChange={setAssistantBusy} /></div>
      </div>
      <PublicationPanel revision={baseRevision} canEdit={canEdit} draftBusy={dirty || pending || needsReview || assistantBusy} initialView={publicationView} />
      <ActivityPanel revision={document.revision} disabled={pending || assistantBusy} />
      <footer className="workspace-footer"><span>FOLIO / NEXT.JS + BOUNDARY</span><ConnectionDialog /><span>Interface by the app. Interactions connected by Boundary.</span></footer>
    </main>
  </div>;
}
