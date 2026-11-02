#![allow(clippy::missing_errors_doc)]
// Store traits return implementor-defined errors; each method documents the
// failed host action while the concrete adapter owns its recovery contract.

use std::{convert::Infallible, error::Error};

use super::{
    Actor, ApprovalRecord, AttemptId, AttemptRecord, ClaimId, ControlError, ControlFault,
    GrantRecord, LeaseId, LeaseRecord, NormalizedInput, ProposalRecord, ReceiptId, ReceiptRecord,
    Timestamp,
};

/// Stage-specific identifier requested from a host source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdKind {
    /// Proposal identity.
    Proposal,
    /// Approval identity.
    Approval,
    /// Grant identity.
    Grant,
    /// Attempt identity.
    Attempt,
    /// Lease identity.
    Lease,
    /// Claim identity.
    Claim,
    /// Receipt identity.
    Receipt,
}

/// A fallible source of typed time values.
pub trait Clock {
    /// Host clock error.
    type Error: Error + Send + Sync + 'static;

    /// Returns the current host time.
    fn now(&self) -> Result<Timestamp, Self::Error>;
}

/// A fallible source of durable identifiers.
pub trait IdSource {
    /// Host identifier-source error.
    type Error: Error + Send + Sync + 'static;

    /// Returns a fresh textual id for the requested stage.
    fn next_id(&mut self, kind: IdKind) -> Result<String, Self::Error>;
}

/// Result of inserting immutable authority state by id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreInsert<T> {
    /// The supplied record won the compare-and-swap.
    Inserted,
    /// The id was already occupied by this returned record.
    Existing(T),
}

/// Durable storage for the request, approval, and grant stages.
pub trait AuthorityStore {
    /// Storage error.
    type Error: Error + Send + Sync + 'static;

    /// Inserts an immutable proposal by id.
    fn insert_proposal(
        &mut self,
        record: ProposalRecord,
    ) -> Result<StoreInsert<ProposalRecord>, Self::Error>;

    /// Loads a proposal by id.
    fn proposal(&self, id: &super::ProposalId) -> Result<Option<ProposalRecord>, Self::Error>;

    /// Inserts an immutable approval by id.
    fn insert_approval(
        &mut self,
        record: ApprovalRecord,
    ) -> Result<StoreInsert<ApprovalRecord>, Self::Error>;

    /// Loads an approval by id.
    fn approval(&self, id: &super::ApprovalId) -> Result<Option<ApprovalRecord>, Self::Error>;

    /// Inserts an immutable grant by id.
    fn insert_grant(
        &mut self,
        record: GrantRecord,
    ) -> Result<StoreInsert<GrantRecord>, Self::Error>;

    /// Loads a grant by id.
    fn grant(&self, id: &super::GrantId) -> Result<Option<GrantRecord>, Self::Error>;
}

/// Compare-and-swap result for an idempotent attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BeginAttempt {
    /// This caller durably created the attempt and is allowed to seek a permit.
    Started(AttemptRecord),
    /// An attempt already owns this interaction-scoped idempotency key.
    Existing(AttemptRecord),
}

/// Request passed to the journal for atomic lease allocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseRequest {
    attempt_id: AttemptId,
    lease_id: LeaseId,
    claim_id: ClaimId,
    owner: Actor,
    now: Timestamp,
    expires_at: Timestamp,
}

impl LeaseRequest {
    pub(crate) fn new(
        attempt_id: AttemptId,
        lease_id: LeaseId,
        claim_id: ClaimId,
        owner: Actor,
        now: Timestamp,
        expires_at: Timestamp,
    ) -> Self {
        Self {
            attempt_id,
            lease_id,
            claim_id,
            owner,
            now,
            expires_at,
        }
    }

    /// Returns the target attempt.
    #[must_use]
    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }
    /// Returns the proposed lease id.
    #[must_use]
    pub fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }
    /// Returns the unique claim id.
    #[must_use]
    pub fn claim_id(&self) -> &ClaimId {
        &self.claim_id
    }
    /// Returns the claiming executor.
    #[must_use]
    pub fn owner(&self) -> &Actor {
        &self.owner
    }
    /// Returns the comparison time.
    #[must_use]
    pub const fn now(&self) -> Timestamp {
        self.now
    }
    /// Returns the desired exclusive expiration time.
    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }
}

/// Atomic lease-claim result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseClaim {
    /// The journal allocated a new monotonic fence to this claim.
    Acquired(LeaseRecord),
    /// Another executor retains a live lease.
    Live(LeaseRecord),
}

/// Atomic receipt-commit result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitReceipt {
    /// The receipt was committed under the supplied fence.
    Committed(ReceiptRecord),
    /// Another terminal or uncertain receipt already occupies the slot.
    Existing(ReceiptRecord),
    /// The supplied lease no longer owns the current fence.
    LeaseLost,
}

/// Durable journal for attempts, fenced leases, and receipts.
pub trait ExecutionJournal {
    /// Journal error.
    type Error: Error + Send + Sync + 'static;

    /// Atomically creates an attempt by `(interaction, idempotency_key)`.
    fn begin_attempt(&mut self, attempt: AttemptRecord) -> Result<BeginAttempt, Self::Error>;

    /// Loads an attempt by id for explicit recovery.
    fn attempt(&self, attempt_id: &AttemptId) -> Result<Option<AttemptRecord>, Self::Error>;

    /// Atomically claims an unleased or expired attempt and allocates its next fence.
    fn claim_lease(&mut self, request: LeaseRequest) -> Result<LeaseClaim, Self::Error>;

    /// Loads the current receipt for an attempt.
    fn receipt(&self, attempt_id: &AttemptId) -> Result<Option<ReceiptRecord>, Self::Error>;

    /// Commits a receipt if the lease still owns the current fence.
    ///
    /// `expected` is `None` for the first receipt or the prior uncertain receipt
    /// id when reconciliation resolves it.
    fn commit_receipt(
        &mut self,
        expected: Option<&ReceiptId>,
        lease: &LeaseRecord,
        receipt: ReceiptRecord,
    ) -> Result<CommitReceipt, Self::Error>;
}

/// Policy hooks evaluated independently at request, approval, and grant time.
pub trait ControlPolicy {
    /// Policy evaluation error or rejection.
    type Error: Error + Send + Sync + 'static;

    /// Evaluates a fully formed proposal before it is stored.
    fn request(&self, proposal: &ProposalRecord) -> Result<(), Self::Error>;

    /// Evaluates an approval or denial before it is stored.
    fn approve(
        &self,
        proposal: &ProposalRecord,
        approval: &ApprovalRecord,
    ) -> Result<(), Self::Error>;

    /// Evaluates a bounded grant before it is stored.
    fn grant(
        &self,
        proposal: &ProposalRecord,
        approval: &ApprovalRecord,
        grant: &GrantRecord,
    ) -> Result<(), Self::Error>;

    /// Evaluates an executor and idempotency key before an attempt is created.
    fn execute(
        &self,
        proposal: &ProposalRecord,
        grant: &GrantRecord,
        owner: &Actor,
        idempotency_key: &super::InteractionIdempotencyKey,
    ) -> Result<(), Self::Error>;

    /// Evaluates recovery before an expired attempt lease is claimed.
    fn reconcile(
        &self,
        attempt: &AttemptRecord,
        previous: Option<&ReceiptRecord>,
        owner: &Actor,
    ) -> Result<(), Self::Error>;
}

/// Policy that accepts every well-formed transition.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl ControlPolicy for AllowAll {
    type Error = Infallible;

    fn request(&self, _proposal: &ProposalRecord) -> Result<(), Self::Error> {
        Ok(())
    }

    fn approve(
        &self,
        _proposal: &ProposalRecord,
        _approval: &ApprovalRecord,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    fn grant(
        &self,
        _proposal: &ProposalRecord,
        _approval: &ApprovalRecord,
        _grant: &GrantRecord,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    fn execute(
        &self,
        _proposal: &ProposalRecord,
        _grant: &GrantRecord,
        _owner: &Actor,
        _idempotency_key: &super::InteractionIdempotencyKey,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    fn reconcile(
        &self,
        _attempt: &AttemptRecord,
        _previous: Option<&ReceiptRecord>,
        _owner: &Actor,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Successful application data awaiting independent verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyResult {
    output: Vec<u8>,
    evidence: Vec<u8>,
}

impl ApplyResult {
    /// Constructs encoded output plus host-defined verification evidence.
    pub fn new(output: Vec<u8>, evidence: Vec<u8>) -> Result<Self, ControlError> {
        if output.len() > 16 * 1024 * 1024 {
            return Err(ControlError::InvalidValue("output exceeds size limit"));
        }
        if evidence.len() > 4 * 1024 * 1024 {
            return Err(ControlError::InvalidValue("evidence exceeds size limit"));
        }
        Ok(Self { output, evidence })
    }

    /// Returns encoded interaction output.
    #[must_use]
    pub fn output(&self) -> &[u8] {
        &self.output
    }
    /// Returns host-defined verification evidence.
    #[must_use]
    pub fn evidence(&self) -> &[u8] {
        &self.evidence
    }
}

/// Failure classification returned from the mutation boundary.
#[derive(Debug)]
pub enum ApplyFailure<E> {
    /// The effect is known not to have happened.
    NotApplied(E),
    /// The effect may have happened.
    Uncertain(E),
}

/// Independent verification result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verification {
    /// Evidence and observed state establish completion.
    Completed,
    /// Observed state establishes that the effect did not happen.
    NotApplied(ControlFault),
    /// Observed state cannot establish either result.
    Uncertain(ControlFault),
}

/// Recovery classification. It deliberately has no apply capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reconciliation {
    /// Recovery found an applied result, which must still be verified.
    Applied(ApplyResult),
    /// Recovery established that the effect did not happen.
    NotApplied(ControlFault),
    /// Recovery remains unable to classify the attempt.
    Uncertain(ControlFault),
}

/// Read-only context available to recovery code.
#[derive(Clone, Copy, Debug)]
pub struct ReconcileContext<'a> {
    attempt: &'a AttemptRecord,
    previous: Option<&'a ReceiptRecord>,
    now: Timestamp,
}

impl<'a> ReconcileContext<'a> {
    pub(crate) fn new(
        attempt: &'a AttemptRecord,
        previous: Option<&'a ReceiptRecord>,
        now: Timestamp,
    ) -> Self {
        Self {
            attempt,
            previous,
            now,
        }
    }

    /// Returns the attempt being recovered.
    #[must_use]
    pub const fn attempt(&self) -> &AttemptRecord {
        self.attempt
    }
    /// Returns the prior uncertain receipt, if one exists.
    #[must_use]
    pub const fn previous_receipt(&self) -> Option<&ReceiptRecord> {
        self.previous
    }
    /// Returns the recovery clock instant.
    #[must_use]
    pub const fn now(&self) -> Timestamp {
        self.now
    }
}

/// Changing-interaction adapter used by [`super::ControlledHandler`].
pub trait ControlledEffect {
    /// Classified apply fault converted into a sanitized durable fault.
    type ApplyError: Into<ControlFault>;
    /// Verification fault converted into a sanitized durable fault.
    type VerifyError: Into<ControlFault>;
    /// Reconciliation fault converted into a sanitized durable fault.
    type ReconcileError: Into<ControlFault>;

    /// Applies the effect. The non-cloneable permit must reach the fenced mutation.
    fn apply(
        &mut self,
        input: &NormalizedInput,
        permit: super::ApplyPermit,
    ) -> Result<ApplyResult, ApplyFailure<Self::ApplyError>>;

    /// Independently verifies a reported applied result.
    fn verify(
        &mut self,
        input: &NormalizedInput,
        applied: &ApplyResult,
    ) -> Result<Verification, Self::VerifyError>;

    /// Classifies a previous attempt without applying it again.
    fn reconcile(
        &mut self,
        input: &NormalizedInput,
        context: ReconcileContext<'_>,
    ) -> Result<Reconciliation, Self::ReconcileError>;
}
