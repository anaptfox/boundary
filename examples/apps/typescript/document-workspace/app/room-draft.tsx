"use client";

import { startTransition, useId, useState, ViewTransition } from "react";
import type { RoomDraft as Draft } from "../lib/room-types";
import { DraftContent } from "./draft-content";

/** Review the stored proposal without changing its bytes or granting a save. */
export function RoomDraft({ draft }: { draft: Draft }) {
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  return <section className="room-draft" aria-label="Proposed document">
    <small>PROPOSED DOCUMENT · BASE REVISION {draft.expectedRevision}</small>
    <h4>{draft.title}</h4>
    <button type="button" className="text-button draft-review-toggle" aria-expanded={expanded} aria-controls={previewId}
      onClick={() => startTransition(() => setExpanded((value) => !value))}>
      {expanded ? "Compact preview" : "Read full draft"}
    </button>
    <ViewTransition default="none" update="folio-draft-review">
      <div id={previewId} className={expanded ? "room-draft-preview expanded" : "room-draft-preview"}>
        <DraftContent body={draft.body} richText={draft.richText} />
      </div>
    </ViewTransition>
    <small>{draft.richText ? "Formatted draft" : "Plain-text draft"} · not saved</small>
  </section>;
}
