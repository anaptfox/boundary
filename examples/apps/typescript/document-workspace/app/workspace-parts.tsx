"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "./icons";

export function Brand() {
  return <div className="brand"><span className="brand-mark">f<span>.</span></span><span>folio<span className="brand-caption">A BOUNDARY WORKSPACE</span></span></div>;
}

export function SessionMenu({ session, dirty, disabled }: { session: "alice" | "bob"; dirty: boolean; disabled: boolean }) {
  return <Menu.Root>
    <Menu.Trigger className="session-trigger" disabled={disabled} aria-label="Switch demo session">
      <span className={`avatar ${session}`}>{session === "alice" ? "A" : "B"}</span>
      <span className="session-name">{session === "alice" ? "Alice" : "Bob"}<small>{session === "alice" ? "Editor" : "Reader"}</small></span>
      <Icon name="chevron" />
    </Menu.Trigger>
    <Menu.Portal><Menu.Positioner sideOffset={8} align="end"><Menu.Popup className="menu-popup">
      <div className="menu-label">SEE ANOTHER PERSPECTIVE</div>
      <form action="/demo-session" method="post" onSubmit={(event) => {
        if (dirty && !window.confirm("Switch session and discard your unsaved changes?")) event.preventDefault();
      }}>
        <Menu.Item render={<button type="submit" name="session" value="alice" />} className="menu-item"><span className="avatar alice">A</span><span>Alice<small>Can read and save</small></span>{session === "alice" && <Icon name="check" />}</Menu.Item>
        <Menu.Item render={<button type="submit" name="session" value="bob" />} className="menu-item"><span className="avatar bob">B</span><span>Bob<small>Can read only</small></span>{session === "bob" && <Icon name="check" />}</Menu.Item>
      </form>
      <p className="menu-note">Local demo sessions, not production sign-in.</p>
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

export function ConnectionDialog() {
  return <Dialog.Root>
    <Dialog.Trigger className="text-button">Inspect the interface <Icon name="arrow" /></Dialog.Trigger>
    <Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="dialog-popup">
      <div className="dialog-top"><span className="eyebrow">UNDER THE SURFACE</span><Dialog.Close className="icon-button" aria-label="Close interface details"><Icon name="close" /></Dialog.Close></div>
      <Dialog.Title>One document. Three ways in.</Dialog.Title>
      <Dialog.Description>The form calls a Boundary Binding from a Next Server Action. Scout can read; Editor can read and save. Local MCP and browser WebMCP reach selected interactions through the same host rules. Every invocation checks the caller’s delegation or signed-in session on the server.</Dialog.Description>
      <div className="interaction-row"><code>documents.get</code><span>Read the document</span><span className="badge">direct</span></div>
      <div className="interaction-row"><code>documents.save</code><span>Save an exact revision</span><span className="badge">direct</span></div>
      <a className="endpoint-link" href="/api/boundary/manifest" target="_blank" rel="noreferrer"><Icon name="code" /><span>Open the live protocol manifest<small>/api/boundary/manifest</small></span><Icon name="arrow" /></a>
      <p className="fine-print">MCP verifies local credential fixtures through the host verifier; WebMCP is optional browser registration and never an approval surface. Ollama runs locally through the AI SDK. The application owns the UI, room coordination, storage and permission decisions.</p>
      <Dialog.Close className="button primary">Back to the document</Dialog.Close>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}

export function Inspector({ canEdit, revision }: { canEdit: boolean; revision: number }) {
  return <aside className="inspector" aria-label="Document access and connections">
    <div className="inspector-heading"><Icon name="lock" /><h2>Access & connections</h2></div>
    <section><div className="eyebrow">YOUR ACCESS</div><div className="access-title">{canEdit ? "Room to make it yours." : "A different point of view."}</div><p>{canEdit ? "You can read and save this document as Alice." : "You can read this document as Bob. Saving is blocked by the server."}</p>
      <div className="permission"><span>Read document</span><span className="allowed"><Icon name="check" /> Allowed</span></div>
      <div className="permission"><span>Save revision</span><span className={canEdit ? "allowed" : "muted"}><Icon name={canEdit ? "check" : "lock"} />{canEdit ? "Allowed" : "Read only"}</span></div>
    </section>
    <section><div className="eyebrow">CONNECTED SURFACES</div>
      <div className="surface"><span className="surface-icon"><Icon name="document" /></span><div>Document editor<small>Next.js Server Action</small></div><span className="status-dot" /></div>
      <div className="surface"><span className="surface-icon"><Icon name="code" /></span><div>Protocol interface<small>Selected interactions over HTTP</small></div><span className="status-dot" /></div>
      <ConnectionDialog />
    </section>
    <section><div className="eyebrow">PERSISTED STATE</div><div className="revision-display">{String(revision).padStart(2, "0")}<span>current revision</span></div><p>Each save checks your starting revision. An older draft cannot silently overwrite a newer one.</p></section>
    <div className="boundary-note"><Icon name="bolt" /><p>Same interactions.<br /><strong>Permissions checked every time.</strong></p></div>
  </aside>;
}
