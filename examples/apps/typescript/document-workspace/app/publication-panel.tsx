"use client";
import { useActionState, useEffect, useState } from "react";
import {
  publicationAction,
  type PublicationActionResult,
} from "./publication-actions";
import type { PublicationView } from "../lib/publication";
import { DraftContent } from "./draft-content";

export function PublicationPanel(
  { revision, canEdit, draftBusy, initialView }: {
    revision: number;
    canEdit: boolean;
    draftBusy: boolean;
    initialView: PublicationView;
  },
) {
  const [state, action, pending] = useActionState(
    publicationAction,
    {} as PublicationActionResult,
  );
  const [view, setView] = useState(initialView);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    setView(state.view ?? initialView);
  }, [state.view, initialView]);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let fetching = false;
    const timer = setInterval(() => {
      if (pending || fetching) return;
      fetching = true;
      void fetch("/api/publication-status", {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Publication status unavailable");
          const next: PublicationView = await response.json();
          if (!stopped) {
            setView(next);
            setDisconnected(false);
          }
        }).catch(() => {
          if (!stopped) setDisconnected(true);
        }).finally(() => {
          fetching = false;
        });
    }, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [pending]);
  return (
    <section className="publication-panel" aria-label="Publication review">
      <div className="publication-heading">
        <div>
          <div className="eyebrow">FROM WORKING DRAFT TO PUBLISHED</div>
          <h2>Make it official.</h2>
          <p>
            {view.published
              ? `Published: ${view.published.title} · revision ${view.published.revision}`
              : "Nothing published yet. Saved drafts stay private to this demo workspace."}
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="mode" value="request" />
          <input type="hidden" name="revision" value={revision} />
          <button
            className="button primary"
            disabled={!canEdit || draftBusy || pending}
          >
            Review revision {revision}
          </button>
        </form>
      </div>
      {disconnected && (
        <p role="status">
          Publication updates disconnected. Showing the last observed status; no
          action was retried.
        </p>
      )}
      {draftBusy && (
        <p>
          Save your draft before requesting publication review.
        </p>
      )}
      {view.proposals.map((proposal) => (
        <form key={proposal.id} action={action} className="publication-review">
          <input type="hidden" name="proposal" value={proposal.id} />
          <input type="hidden" name="digest" value={proposal.digest} />
          <div>
            <strong>{proposal.title} · revision {proposal.revision}</strong>
            <p>Requested by {proposal.requestedBy} · {proposal.state}</p>
            <small>
              Approval applies only to this exact saved revision. Publishing
              updates this demo’s local publication record, not an external
              site.
            </small>
            <details>
              <summary>Review exact content</summary>
              <DraftContent body={proposal.body} richText={proposal.richText} />
            </details>
          </div>
          {proposal.state === "needs-review" && (
            <button
              className="button secondary"
              name="mode"
              value="approve"
              disabled={!canEdit || draftBusy || pending ||
                proposal.revision !== revision}
            >
              Approve & publish exact revision
            </button>
          )}
          {proposal.state === "uncertain" && (
            <button
              className="button secondary"
              name="mode"
              value="reconcile"
              disabled={!canEdit || pending}
            >
              Reconcile result
            </button>
          )}
        </form>
      ))}
      <form action={action}>
        <button
          className="text-button"
          name="mode"
          value="inspect"
          disabled={pending}
        >
          {pending ? "Checking…" : "Inspect publication status ↗"}
        </button>
      </form>
      {state.message && <p role="alert">{state.message}</p>}
    </section>
  );
}
