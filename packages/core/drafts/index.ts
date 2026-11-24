/**
 * `@foxworth/boundary/drafts`: the workflow that turns a Draft into a
 * decision.
 *
 * Three ordinary Boundary interactions — `drafts.propose`, `drafts.accept`, and
 * `drafts.reject` — plus a host-supplied {@link DraftStore} port and three
 * Projection presets split by authority. Mirrors the private Host control contribution seam:
 * Boundary ships the Draft interactions; the host owns storage and admission.
 */
export {
  draftsAccept,
  draftsInteractions,
  draftsPropose,
  draftsReject,
} from "./definitions";

export {
  acceptDraft,
  proposeDraft,
  rejectDraft,
  type DraftAcceptOutput,
  type DraftDecisionInput,
  type DraftInput,
  type DraftProposeOutput,
  type DraftRejectInput,
  type DraftRejectOutput,
} from "./service";

export {
  authorProjection,
  proposerProjection,
  runnerProjection,
} from "./projections";

export {
  DRAFT_REJECT_REASONS,
  isDraftRejectReason,
  type DraftDecision,
  type DraftRejectReason,
  type DraftStore,
} from "./types";
