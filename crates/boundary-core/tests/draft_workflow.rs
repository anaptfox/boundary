//! Draft propose / accept / reject over a host-supplied draft store.
//!
//! Accepting never mutates a Program and never writes source. Authority is
//! split across capability types: a proposer cannot accept, an author cannot
//! propose, and a runner has neither method.
#![allow(clippy::expect_used)]

use std::{collections::BTreeMap, convert::Infallible};

use boundary_core::lifecycle::{
    DraftAuthor, DraftDecision, DraftFault, DraftProposer, DraftRejectReason, DraftRunner,
    DraftStore, accept, propose, reject,
};
use boundary_core::{Draft, DraftDigest, InteractionContract, PortableSchema};

fn sample_contract() -> InteractionContract {
    InteractionContract::builder("docs.render", PortableSchema::any(), PortableSchema::any())
        .finish()
        .expect("contract builds")
}

fn sample_draft() -> Draft {
    Draft::new(
        sample_contract(),
        "no interaction renders a document today",
        "bot-1",
        "2026-09-06T00:00:00Z",
    )
    .expect("draft builds")
}

#[derive(Default)]
struct MemoryDraftStore {
    drafts: BTreeMap<String, Draft>,
    decisions: Vec<DraftDecision>,
}

impl DraftStore for MemoryDraftStore {
    type Error = Infallible;

    fn put(&mut self, draft: Draft) -> Result<(), Self::Error> {
        self.drafts
            .insert(draft.draft_digest().as_str().to_owned(), draft);
        Ok(())
    }

    fn get(&self, draft_digest: &DraftDigest) -> Result<Option<Draft>, Self::Error> {
        Ok(self.drafts.get(draft_digest.as_str()).cloned())
    }

    fn list(&self) -> Result<Vec<Draft>, Self::Error> {
        Ok(self.drafts.values().cloned().collect())
    }

    fn record_decision(&mut self, decision: DraftDecision) -> Result<(), Self::Error> {
        self.decisions.push(decision);
        Ok(())
    }
}

#[derive(Debug)]
struct StoreUnavailable;

impl std::fmt::Display for StoreUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("store unavailable")
    }
}

impl std::error::Error for StoreUnavailable {}

struct FailingDraftStore;

impl DraftStore for FailingDraftStore {
    type Error = StoreUnavailable;

    fn put(&mut self, _draft: Draft) -> Result<(), Self::Error> {
        Err(StoreUnavailable)
    }

    fn get(&self, _draft_digest: &DraftDigest) -> Result<Option<Draft>, Self::Error> {
        Err(StoreUnavailable)
    }

    fn list(&self) -> Result<Vec<Draft>, Self::Error> {
        Err(StoreUnavailable)
    }

    fn record_decision(&mut self, _decision: DraftDecision) -> Result<(), Self::Error> {
        Err(StoreUnavailable)
    }
}

#[test]
fn propose_never_changes_the_what_is_declared_and_is_idempotent_in_list() {
    let mut store = MemoryDraftStore::default();
    let draft = sample_draft();

    let first = propose(&mut store, draft.clone()).expect("first proposal succeeds");
    assert_eq!(first.draft_digest(), draft.draft_digest());
    assert_eq!(store.list().expect("list").len(), 1);

    let second = propose(&mut store, draft.clone()).expect("second proposal succeeds");
    assert_eq!(second.draft_digest(), draft.draft_digest());
    assert_eq!(store.list().expect("list").len(), 1);
    assert_eq!(
        store.decisions,
        [] as [boundary_core::lifecycle::DraftDecision; 0]
    );
}

#[test]
fn accept_returns_the_contract_and_digest_without_touching_a_program() {
    let mut store = MemoryDraftStore::default();
    let draft = sample_draft();
    propose(&mut store, draft.clone()).expect("propose succeeds");

    let outcome = accept(
        &mut store,
        draft.draft_digest(),
        "author-1",
        "2026-09-06T01:00:00Z",
    )
    .expect("accept succeeds");

    assert_eq!(outcome.contract(), draft.contract());
    assert_eq!(
        outcome.contract_digest(),
        &draft.contract().digest().expect("contract digest")
    );
    assert_eq!(store.decisions.len(), 1);
    match &store.decisions[0] {
        DraftDecision::Accepted { draft_digest, .. } => {
            assert_eq!(draft_digest, draft.draft_digest());
        }
        rejected @ DraftDecision::Rejected { .. } => {
            unreachable!("expected an accepted decision, got {rejected:?}")
        }
    }
    assert_eq!(store.list().expect("list").len(), 1);
}

#[test]
fn accept_reports_an_unknown_draft_rather_than_inventing_an_acceptance() {
    let mut store = MemoryDraftStore::default();
    let digest = sample_draft().draft_digest().clone();

    let error = accept(&mut store, &digest, "author-1", "2026-09-06T01:00:00Z")
        .expect_err("unknown draft must fault");
    assert!(matches!(error, DraftFault::DraftNotFound(found) if found == digest));
}

#[test]
fn reject_requires_a_reason_from_the_closed_set() {
    let mut store = MemoryDraftStore::default();
    let draft = sample_draft();
    propose(&mut store, draft.clone()).expect("propose succeeds");

    let malformed: Result<DraftRejectReason, _> = serde_json::from_str("\"because-i-said-so\"");
    assert!(malformed.is_err());

    let outcome = reject(
        &mut store,
        draft.draft_digest(),
        DraftRejectReason::CoveredByExisting,
        "author-1",
        "2026-09-06T01:00:00Z",
    )
    .expect("reject succeeds");
    assert_eq!(outcome.draft_digest(), draft.draft_digest());
    assert_eq!(outcome.reason(), DraftRejectReason::CoveredByExisting);
    assert_eq!(store.decisions.len(), 1);
}

#[test]
fn a_store_failure_is_a_fault_rather_than_a_silent_success() {
    let mut store = FailingDraftStore;
    let draft = sample_draft();

    let error = propose(&mut store, draft.clone()).expect_err("store failure must fault");
    assert!(matches!(error, DraftFault::Store(StoreUnavailable)));

    let error = accept(
        &mut store,
        draft.draft_digest(),
        "author-1",
        "2026-09-06T01:00:00Z",
    )
    .expect_err("store failure must fault");
    assert!(matches!(error, DraftFault::Store(StoreUnavailable)));

    let error = reject(
        &mut store,
        draft.draft_digest(),
        DraftRejectReason::OrdinaryCode,
        "author-1",
        "2026-09-06T01:00:00Z",
    )
    .expect_err("store failure must fault");
    assert!(matches!(error, DraftFault::Store(StoreUnavailable)));
}

#[test]
fn capability_types_expose_exactly_the_authority_they_claim() {
    let mut store = MemoryDraftStore::default();
    let draft = sample_draft();

    let mut proposer = DraftProposer::new(&mut store);
    proposer
        .propose(draft.clone())
        .expect("proposer can propose");

    let mut author = DraftAuthor::new(&mut store);
    author
        .accept(draft.draft_digest(), "author-1", "2026-09-06T01:00:00Z")
        .expect("author can accept");

    let runner = DraftRunner;
    assert_eq!(core::mem::size_of_val(&runner), 0);
}

/// A widened contract, self-consistent as its own Draft, filed under a
/// digest a person already approved. This is the substitution the accept
/// path has to catch: verifying the stored Draft alone would pass, because
/// the Draft really is a valid Draft — just not the one that was reviewed.
fn widened_draft() -> Draft {
    let contract =
        InteractionContract::builder("docs.render", PortableSchema::any(), PortableSchema::any())
            .changes(["documents", "secrets"])
            .finish()
            .expect("widened contract builds");
    Draft::new(
        contract,
        "no interaction renders a document today",
        "bot-1",
        "2026-09-06T00:00:00Z",
    )
    .expect("draft builds")
}

/// `drafts.accept` is request mode: what a person approved is a *digest*,
/// not a contract. If the store's entry for that digest is replaced between
/// review and apply, accept must refuse rather than hand back a contract the
/// approval was never bound to. Mirrored in
/// `tests/typescript/host-drafts.test.ts`.
#[test]
fn accept_refuses_a_draft_substituted_under_an_approved_digest() {
    let approved = sample_draft();
    let approved_digest = approved.draft_digest().clone();
    let substituted = widened_draft();
    assert_ne!(
        substituted.draft_digest(),
        &approved_digest,
        "the substitution must be a genuinely different Draft"
    );

    let mut store = MemoryDraftStore::default();
    propose(&mut store, approved).expect("propose the reviewed draft");
    // The store is host-supplied; this is any writer with access to it.
    store
        .drafts
        .insert(approved_digest.as_str().to_owned(), substituted);

    let fault = accept(
        &mut store,
        &approved_digest,
        "person",
        "2026-09-06T01:00:00Z",
    )
    .expect_err("a substituted draft must not be accepted");
    assert!(
        matches!(fault, DraftFault::DraftSubstituted { .. }),
        "expected a substitution fault, got {fault:?}"
    );
    assert!(
        store.decisions.is_empty(),
        "nothing may be recorded as accepted"
    );
}

/// The same protection covers rejection: a decision names a digest, and the
/// content behind that digest has to be that digest either way.
#[test]
fn reject_refuses_a_substituted_draft_too() {
    let approved = sample_draft();
    let approved_digest = approved.draft_digest().clone();
    let mut store = MemoryDraftStore::default();
    propose(&mut store, approved).expect("propose");
    store
        .drafts
        .insert(approved_digest.as_str().to_owned(), widened_draft());

    let fault = reject(
        &mut store,
        &approved_digest,
        DraftRejectReason::OrdinaryCode,
        "person",
        "2026-09-06T01:00:00Z",
    )
    .expect_err("a substituted draft must not be rejected either");
    assert!(matches!(fault, DraftFault::DraftSubstituted { .. }));
}
