//! The Draft workflow: turning a [`Draft`] into a Draft decision.
//!
//! Three interactions — propose, accept, and reject — over one host-supplied
//! [`DraftStore`] store. A worker proposes a full contract that does not
//! exist yet; an author accepts or rejects it. Accepting never mutates a
//! live [`Program`](crate::Program) and never writes source files: it
//! produces a decision, and the host separately recompiles a Program that
//! declares the accepted contract as an ordinary interaction.
//!
//! This module stays independent of [`crate::Interaction`] and the
//! `compile_interaction`/`select`/`project`/`install`/`bind` engine
//! elsewhere in this module, for the same reason
//! [`crate::control`] does: a Draft's contract embeds arbitrary nested
//! portable schema, so it has no fixed native shape [`crate::WireCodec`]
//! could derive, and the workflow around it — persist, decide, let the host
//! recompile — is a decision ledger, not a callable native interaction. A host
//! that wants `drafts.propose`/`drafts.accept`/`drafts.reject` reachable
//! as installed interactions wires these functions behind its own
//! [`crate::Interaction`] impls; this module does not assume that shape for
//! every host.
//!
//! Three capability types split the workflow by authority, mirroring
//! [`crate::control`]'s Reader/Admin split: [`DraftProposer`] can only
//! propose, [`DraftAuthor`] can only accept and reject, and
//! [`DraftRunner`] is a marker with neither. No type here hands out every
//! capability; a host that wants all three constructs more than one.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{ContractDigest, Draft, DraftDigest, InteractionContract, ProgramError};

/// Why a Draft is rejected. Closed: a host may not invent a third reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DraftRejectReason {
    /// This is a local helper, not an interaction.
    OrdinaryCode,
    /// Existing interactions already do this.
    CoveredByExisting,
}

/// One durable outcome of reviewing a Draft. Never mutates a live Program.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DraftDecision {
    /// The Draft's contract is accepted as a declared interaction.
    #[serde(rename = "accepted")]
    Accepted {
        /// The accepted Draft's digest.
        draft_digest: DraftDigest,
        /// The accepted contract's own digest.
        contract_digest: ContractDigest,
        /// Opaque host-supplied identity of the deciding author.
        decided_by: String,
        /// Host-supplied decision timestamp.
        decided_at: String,
    },
    /// The Draft is rejected.
    #[serde(rename = "rejected")]
    Rejected {
        /// The rejected Draft's digest.
        draft_digest: DraftDigest,
        /// Why the Draft is rejected.
        reason: DraftRejectReason,
        /// Opaque host-supplied identity of the deciding author.
        decided_by: String,
        /// Host-supplied decision timestamp.
        decided_at: String,
    },
}

/// Host-owned Draft storage and decision ledger.
///
/// This is the Draft workflow's equivalent of Control's journal: Boundary owns none of
/// it. `put` and `get` key exclusively on the Draft's own digest, so `put`
/// MUST be idempotent — persisting the same digest twice must not create a
/// second entry. `list` returns every pending Draft; this module never
/// filters, paginates, or scopes it. `record_decision` is a separate ledger
/// from Draft storage: accepting or rejecting a Draft never rewrites or
/// removes it from `list`.
#[allow(clippy::missing_errors_doc)]
pub trait DraftStore {
    /// Host storage error.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Persists a Draft. MUST be idempotent by `draft.draft_digest()`.
    fn put(&mut self, draft: Draft) -> Result<(), Self::Error>;
    /// Returns the Draft for an exact digest, or `None` if absent.
    fn get(&self, draft_digest: &DraftDigest) -> Result<Option<Draft>, Self::Error>;
    /// Returns every pending Draft. Never filtered or scoped by this module.
    fn list(&self) -> Result<Vec<Draft>, Self::Error>;
    /// Appends one accept or reject decision. Never rewrites `list`.
    fn record_decision(&mut self, decision: DraftDecision) -> Result<(), Self::Error>;
}

/// Draft workflow failure. A store failure is always a fault, never a
/// silent success.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum DraftFault<E> {
    /// The Draft failed to verify: its digest does not match its content,
    /// or its contract is invalid.
    #[error("invalid draft: {0}")]
    InvalidDraft(#[from] ProgramError),
    /// No Draft is stored under the requested digest.
    #[error("draft not found: {0}")]
    DraftNotFound(DraftDigest),
    /// The stored Draft verifies but is not the Draft that was asked for.
    /// A decision names a digest; the content behind it must be that digest.
    #[error(
        "draft {requested} is stored as {stored}; the approval names content it was never bound to"
    )]
    DraftSubstituted {
        /// The digest the caller (and the approver) named.
        requested: DraftDigest,
        /// The digest the stored Draft computes for itself.
        stored: DraftDigest,
    },
    /// The host-supplied draft store failed.
    #[error("the draft store failed: {0}")]
    Store(E),
}

/// `drafts.propose` output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposeOutcome {
    draft_digest: DraftDigest,
}

impl ProposeOutcome {
    /// Returns the proposed Draft's digest.
    #[must_use]
    pub const fn draft_digest(&self) -> &DraftDigest {
        &self.draft_digest
    }
}

/// `drafts.accept` output.
#[derive(Clone, Debug, PartialEq)]
pub struct AcceptOutcome {
    contract: InteractionContract,
    contract_digest: ContractDigest,
}

impl AcceptOutcome {
    /// Returns the accepted contract.
    #[must_use]
    pub const fn contract(&self) -> &InteractionContract {
        &self.contract
    }

    /// Returns the accepted contract's own digest.
    #[must_use]
    pub const fn contract_digest(&self) -> &ContractDigest {
        &self.contract_digest
    }
}

/// `drafts.reject` output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RejectOutcome {
    draft_digest: DraftDigest,
    reason: DraftRejectReason,
}

impl RejectOutcome {
    /// Returns the rejected Draft's digest.
    #[must_use]
    pub const fn draft_digest(&self) -> &DraftDigest {
        &self.draft_digest
    }

    /// Returns why the Draft was rejected.
    #[must_use]
    pub const fn reason(&self) -> DraftRejectReason {
        self.reason
    }
}

/// `drafts.propose`: verify and persist a Draft. Never changes what is
/// declared — it only ever calls `store.put`.
///
/// # Errors
///
/// Returns [`DraftFault::InvalidDraft`] when the Draft fails to verify, or
/// [`DraftFault::Store`] when the store fails to persist it.
pub fn propose<S: DraftStore>(
    store: &mut S,
    draft: Draft,
) -> Result<ProposeOutcome, DraftFault<S::Error>> {
    draft.verify()?;
    let draft_digest = draft.draft_digest().clone();
    store.put(draft).map_err(DraftFault::Store)?;
    Ok(ProposeOutcome { draft_digest })
}

/// Reads the Draft stored under `draft_digest` and proves it is that Draft.
///
/// The store is host-supplied, and `drafts.accept` is request mode: what a
/// person approved is a *digest*, not a contract. Verifying the Draft alone
/// catches a tampered one but not a substituted one — a self-consistent
/// Draft filed under someone else's digest verifies perfectly well. So the
/// digest a caller asked for must equal the digest the returned Draft
/// computes for itself, or the approval names content it was never bound to.
fn require_draft<S: DraftStore>(
    store: &S,
    draft_digest: &DraftDigest,
) -> Result<Draft, DraftFault<S::Error>> {
    let draft = store
        .get(draft_digest)
        .map_err(DraftFault::Store)?
        .ok_or_else(|| DraftFault::DraftNotFound(draft_digest.clone()))?;
    draft.verify()?;
    if draft.draft_digest() != draft_digest {
        return Err(DraftFault::DraftSubstituted {
            requested: draft_digest.clone(),
            stored: draft.draft_digest().clone(),
        });
    }
    Ok(draft)
}

/// `drafts.accept`: return the accepted contract and its digest and record
/// the decision. Never mutates a live Program and never writes source
/// files; the host separately recompiles a Program that declares the
/// accepted contract.
///
/// # Errors
///
/// Returns [`DraftFault::DraftNotFound`] when no Draft is stored under
/// `draft_digest`, [`DraftFault::InvalidDraft`] when the stored Draft no
/// longer verifies, [`DraftFault::DraftSubstituted`] when the stored Draft
/// is a different Draft than the one named, or [`DraftFault::Store`] when
/// the store fails to read or record the decision.
pub fn accept<S: DraftStore>(
    store: &mut S,
    draft_digest: &DraftDigest,
    decided_by: impl Into<String>,
    decided_at: impl Into<String>,
) -> Result<AcceptOutcome, DraftFault<S::Error>> {
    let draft = require_draft(store, draft_digest)?;
    let contract = draft.contract().clone();
    let contract_digest = contract.digest()?;
    store
        .record_decision(DraftDecision::Accepted {
            draft_digest: draft.draft_digest().clone(),
            contract_digest: contract_digest.clone(),
            decided_by: decided_by.into(),
            decided_at: decided_at.into(),
        })
        .map_err(DraftFault::Store)?;
    Ok(AcceptOutcome {
        contract,
        contract_digest,
    })
}

/// `drafts.reject`: record that a Draft is rejected for a reason from the
/// closed [`DraftRejectReason`] set.
///
/// # Errors
///
/// Returns [`DraftFault::DraftNotFound`] when no Draft is stored under
/// `draft_digest`, or [`DraftFault::Store`] when the store fails to read
/// or record the decision.
pub fn reject<S: DraftStore>(
    store: &mut S,
    draft_digest: &DraftDigest,
    reason: DraftRejectReason,
    decided_by: impl Into<String>,
    decided_at: impl Into<String>,
) -> Result<RejectOutcome, DraftFault<S::Error>> {
    let draft = require_draft(store, draft_digest)?;
    store
        .record_decision(DraftDecision::Rejected {
            draft_digest: draft.draft_digest().clone(),
            reason,
            decided_by: decided_by.into(),
            decided_at: decided_at.into(),
        })
        .map_err(DraftFault::Store)?;
    Ok(RejectOutcome {
        draft_digest: draft.draft_digest().clone(),
        reason,
    })
}

/// A worker's authority: propose only. Never accept or reject.
pub struct DraftProposer<'store, S: DraftStore> {
    store: &'store mut S,
}

impl<'store, S: DraftStore> DraftProposer<'store, S> {
    /// Grants proposing authority over `store`.
    pub fn new(store: &'store mut S) -> Self {
        Self { store }
    }

    /// `drafts.propose`. See [`propose`].
    ///
    /// # Errors
    ///
    /// See [`propose`].
    pub fn propose(&mut self, draft: Draft) -> Result<ProposeOutcome, DraftFault<S::Error>> {
        propose(self.store, draft)
    }
}

/// An author's authority: accept and reject. Never propose.
pub struct DraftAuthor<'store, S: DraftStore> {
    store: &'store mut S,
}

impl<'store, S: DraftStore> DraftAuthor<'store, S> {
    /// Grants accept/reject authority over `store`.
    pub fn new(store: &'store mut S) -> Self {
        Self { store }
    }

    /// `drafts.accept`. See [`accept`].
    ///
    /// # Errors
    ///
    /// See [`accept`].
    pub fn accept(
        &mut self,
        draft_digest: &DraftDigest,
        decided_by: impl Into<String>,
        decided_at: impl Into<String>,
    ) -> Result<AcceptOutcome, DraftFault<S::Error>> {
        accept(self.store, draft_digest, decided_by, decided_at)
    }

    /// `drafts.reject`. See [`reject`].
    ///
    /// # Errors
    ///
    /// See [`reject`].
    pub fn reject(
        &mut self,
        draft_digest: &DraftDigest,
        reason: DraftRejectReason,
        decided_by: impl Into<String>,
        decided_at: impl Into<String>,
    ) -> Result<RejectOutcome, DraftFault<S::Error>> {
        reject(self.store, draft_digest, reason, decided_by, decided_at)
    }
}

/// No Draft authority at all: neither propose, nor accept, nor reject.
/// For a host that only needs to gate invocation of interactions already
/// declared and must prove it grants no Draft-deciding capability.
#[derive(Clone, Copy, Debug, Default)]
pub struct DraftRunner;
