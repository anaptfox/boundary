"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { useEditorState, type Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { Icon } from "./icons";

function Tool({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger className={`tool ${active ? "selected" : ""}`} aria-label={label} aria-pressed={active} disabled={disabled} type="button" onClick={onClick}>
    {children}
  </Tooltip.Trigger><Tooltip.Portal><Tooltip.Positioner sideOffset={8}><Tooltip.Popup className="tooltip">{label}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal></Tooltip.Root>;
}

export function EditorToolbar({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const state = useEditorState({ editor, selector: ({ editor }) => ({
    bold: editor?.isActive("bold"), italic: editor?.isActive("italic"),
    heading: editor?.isActive("heading", { level: 2 }), list: editor?.isActive("bulletList"),
    quote: editor?.isActive("blockquote"), code: editor?.isActive("code"),
    undo: editor?.can().undo(), redo: editor?.can().redo(),
  }) });
  const blocked = disabled || !editor;
  return <Tooltip.Provider><div className="editor-toolbar" role="group" aria-label="Text formatting">
    <Tool label="Heading" active={state?.heading} disabled={blocked} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><span className="heading-tool">H<span>2</span></span></Tool>
    <span className="toolbar-divider" />
    <Tool label="Bold" active={state?.bold} disabled={blocked} onClick={() => editor?.chain().focus().toggleBold().run()}><strong>B</strong></Tool>
    <Tool label="Italic" active={state?.italic} disabled={blocked} onClick={() => editor?.chain().focus().toggleItalic().run()}><em>I</em></Tool>
    <Tool label="Inline code" active={state?.code} disabled={blocked} onClick={() => editor?.chain().focus().toggleCode().run()}><Icon name="code" /></Tool>
    <span className="toolbar-divider" />
    <Tool label="Bullet list" active={state?.list} disabled={blocked} onClick={() => editor?.chain().focus().toggleBulletList().run()}><Icon name="list" /></Tool>
    <Tool label="Block quote" active={state?.quote} disabled={blocked} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Icon name="quote" /></Tool>
    <span className="toolbar-spacer" />
    <Tool label="Undo" disabled={blocked || !state?.undo} onClick={() => editor?.chain().focus().undo().run()}><Icon name="undo" /></Tool>
    <Tool label="Redo" disabled={blocked || !state?.redo} onClick={() => editor?.chain().focus().redo().run()}><Icon name="redo" /></Tool>
  </div></Tooltip.Provider>;
}
