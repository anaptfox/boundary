#![allow(dead_code)]
#![doc = "Private support adapters for controlled-effect integration tests."]

use std::{
    collections::HashMap,
    convert::Infallible,
    error::Error,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use boundary_core::control::{
    Actor, AllowAll, ApplyFailure, ApplyPermit, ApplyResult, ApprovalId, ApprovalRecord, AttemptId,
    AttemptRecord, AuthorityStore, BeginAttempt, Clock, CommitReceipt, ControlError, ControlFault,
    ControlInteractionRef, ControlPolicy, ControlledEffect, ControlledHandler, ExecutionJournal,
    FenceToken, GrantId, GrantRecord, IdKind, IdSource, InteractionIdempotencyKey, LeaseClaim,
    LeaseRecord, LeaseRequest, NormalizedInput, ProposalId, ProposalRecord, ReceiptId,
    ReceiptOutcome, ReceiptRecord, ReconcileContext, Reconciliation, StoreInsert, Timestamp,
    Verification,
};

#[derive(Debug)]
pub(crate) struct TestStoreError(String);

impl fmt::Display for TestStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for TestStoreError {}

impl From<ControlError> for TestStoreError {
    fn from(error: ControlError) -> Self {
        Self(error.to_string())
    }
}

#[derive(Default)]
pub(crate) struct TestStore {
    proposals: HashMap<ProposalId, ProposalRecord>,
    approvals: HashMap<ApprovalId, ApprovalRecord>,
    grants: HashMap<GrantId, GrantRecord>,
    pub(crate) attempts: HashMap<AttemptId, AttemptRecord>,
    keys: HashMap<(ControlInteractionRef, InteractionIdempotencyKey), AttemptId>,
    leases: HashMap<AttemptId, LeaseRecord>,
    receipts: HashMap<AttemptId, ReceiptRecord>,
}

impl AuthorityStore for TestStore {
    type Error = TestStoreError;

    fn insert_proposal(
        &mut self,
        record: ProposalRecord,
    ) -> Result<StoreInsert<ProposalRecord>, Self::Error> {
        if let Some(existing) = self.proposals.get(record.id()) {
            return Ok(StoreInsert::Existing(existing.clone()));
        }
        self.proposals.insert(record.id().clone(), record);
        Ok(StoreInsert::Inserted)
    }

    fn proposal(&self, id: &ProposalId) -> Result<Option<ProposalRecord>, Self::Error> {
        Ok(self.proposals.get(id).cloned())
    }

    fn insert_approval(
        &mut self,
        record: ApprovalRecord,
    ) -> Result<StoreInsert<ApprovalRecord>, Self::Error> {
        if let Some(existing) = self.approvals.get(record.id()) {
            return Ok(StoreInsert::Existing(existing.clone()));
        }
        self.approvals.insert(record.id().clone(), record);
        Ok(StoreInsert::Inserted)
    }

    fn approval(&self, id: &ApprovalId) -> Result<Option<ApprovalRecord>, Self::Error> {
        Ok(self.approvals.get(id).cloned())
    }

    fn insert_grant(
        &mut self,
        record: GrantRecord,
    ) -> Result<StoreInsert<GrantRecord>, Self::Error> {
        if let Some(existing) = self.grants.get(record.id()) {
            return Ok(StoreInsert::Existing(existing.clone()));
        }
        self.grants.insert(record.id().clone(), record);
        Ok(StoreInsert::Inserted)
    }

    fn grant(&self, id: &GrantId) -> Result<Option<GrantRecord>, Self::Error> {
        Ok(self.grants.get(id).cloned())
    }
}

impl ExecutionJournal for TestStore {
    type Error = TestStoreError;

    fn begin_attempt(&mut self, attempt: AttemptRecord) -> Result<BeginAttempt, Self::Error> {
        let key = (
            attempt.interaction().clone(),
            attempt.idempotency_key().clone(),
        );
        if let Some(id) = self.keys.get(&key)
            && let Some(existing) = self.attempts.get(id)
        {
            return Ok(BeginAttempt::Existing(existing.clone()));
        }
        self.keys.insert(key, attempt.id().clone());
        self.attempts.insert(attempt.id().clone(), attempt.clone());
        Ok(BeginAttempt::Started(attempt))
    }

    fn attempt(&self, attempt_id: &AttemptId) -> Result<Option<AttemptRecord>, Self::Error> {
        Ok(self.attempts.get(attempt_id).cloned())
    }

    fn claim_lease(&mut self, request: LeaseRequest) -> Result<LeaseClaim, Self::Error> {
        if let Some(current) = self.leases.get(request.attempt_id())
            && current.expires_at() > request.now()
        {
            return Ok(LeaseClaim::Live(current.clone()));
        }
        let next = match self.leases.get(request.attempt_id()) {
            Some(current) => current
                .fence()
                .get()
                .checked_add(1)
                .ok_or_else(|| TestStoreError("fence overflow".to_owned()))?,
            None => 1,
        };
        let lease = LeaseRecord::new(
            request.lease_id().clone(),
            request.attempt_id().clone(),
            request.claim_id().clone(),
            request.owner().clone(),
            request.now(),
            request.expires_at(),
            FenceToken::new(next)?,
        )?;
        self.leases
            .insert(request.attempt_id().clone(), lease.clone());
        Ok(LeaseClaim::Acquired(lease))
    }

    fn receipt(&self, attempt_id: &AttemptId) -> Result<Option<ReceiptRecord>, Self::Error> {
        Ok(self.receipts.get(attempt_id).cloned())
    }

    fn commit_receipt(
        &mut self,
        expected: Option<&ReceiptId>,
        lease: &LeaseRecord,
        receipt: ReceiptRecord,
    ) -> Result<CommitReceipt, Self::Error> {
        if self.leases.get(lease.attempt_id()) != Some(lease) {
            return Ok(CommitReceipt::LeaseLost);
        }
        match self.receipts.get(lease.attempt_id()) {
            None if expected.is_none() => {
                self.receipts
                    .insert(lease.attempt_id().clone(), receipt.clone());
                Ok(CommitReceipt::Committed(receipt))
            }
            Some(current)
                if expected == Some(current.id())
                    && matches!(current.outcome(), ReceiptOutcome::Uncertain { .. }) =>
            {
                self.receipts
                    .insert(lease.attempt_id().clone(), receipt.clone());
                Ok(CommitReceipt::Committed(receipt))
            }
            Some(current) => Ok(CommitReceipt::Existing(current.clone())),
            None => Ok(CommitReceipt::LeaseLost),
        }
    }
}

#[derive(Clone)]
pub(crate) struct TestClock(pub Arc<AtomicU64>);

impl TestClock {
    pub(crate) fn new(millis: u64) -> Self {
        Self(Arc::new(AtomicU64::new(millis)))
    }
    pub(crate) fn set(&self, millis: u64) {
        self.0.store(millis, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    type Error = Infallible;
    fn now(&self) -> Result<Timestamp, Self::Error> {
        Ok(Timestamp::from_millis(self.0.load(Ordering::SeqCst)))
    }
}

#[derive(Default)]
pub(crate) struct TestIds(u64);

impl IdSource for TestIds {
    type Error = Infallible;
    fn next_id(&mut self, kind: IdKind) -> Result<String, Self::Error> {
        self.0 += 1;
        Ok(format!("{kind:?}-{}", self.0))
    }
}

pub(crate) type Handler<P = AllowAll> = ControlledHandler<TestStore, TestClock, TestIds, P>;

pub(crate) enum ApplyMode {
    Applied(ApplyResult),
    NotApplied(ControlFault),
    Uncertain(ControlFault),
}
pub(crate) enum VerifyMode {
    Completed,
    NotApplied(ControlFault),
    Uncertain(ControlFault),
    Failed(ControlFault),
}
pub(crate) enum ReconcileMode {
    Applied(ApplyResult),
    NotApplied(ControlFault),
    Uncertain(ControlFault),
    Failed(ControlFault),
}

pub(crate) struct TestEffect {
    pub(crate) apply_calls: usize,
    pub(crate) verify_calls: usize,
    pub(crate) reconcile_calls: usize,
    pub(crate) fences: Vec<FenceToken>,
    pub(crate) apply_mode: ApplyMode,
    pub(crate) verify_mode: VerifyMode,
    pub(crate) reconcile_mode: ReconcileMode,
}

impl ControlledEffect for TestEffect {
    type ApplyError = ControlFault;
    type VerifyError = ControlFault;
    type ReconcileError = ControlFault;

    fn apply(
        &mut self,
        _input: &NormalizedInput,
        permit: ApplyPermit,
    ) -> Result<ApplyResult, ApplyFailure<Self::ApplyError>> {
        self.apply_calls += 1;
        self.fences.push(permit.fence());
        match &self.apply_mode {
            ApplyMode::Applied(result) => Ok(result.clone()),
            ApplyMode::NotApplied(fault) => Err(ApplyFailure::NotApplied(fault.clone())),
            ApplyMode::Uncertain(fault) => Err(ApplyFailure::Uncertain(fault.clone())),
        }
    }

    fn verify(
        &mut self,
        _input: &NormalizedInput,
        _applied: &ApplyResult,
    ) -> Result<Verification, Self::VerifyError> {
        self.verify_calls += 1;
        match &self.verify_mode {
            VerifyMode::Completed => Ok(Verification::Completed),
            VerifyMode::NotApplied(fault) => Ok(Verification::NotApplied(fault.clone())),
            VerifyMode::Uncertain(fault) => Ok(Verification::Uncertain(fault.clone())),
            VerifyMode::Failed(fault) => Err(fault.clone()),
        }
    }

    fn reconcile(
        &mut self,
        _input: &NormalizedInput,
        _context: ReconcileContext<'_>,
    ) -> Result<Reconciliation, Self::ReconcileError> {
        self.reconcile_calls += 1;
        match &self.reconcile_mode {
            ReconcileMode::Applied(result) => Ok(Reconciliation::Applied(result.clone())),
            ReconcileMode::NotApplied(fault) => Ok(Reconciliation::NotApplied(fault.clone())),
            ReconcileMode::Uncertain(fault) => Ok(Reconciliation::Uncertain(fault.clone())),
            ReconcileMode::Failed(fault) => Err(fault.clone()),
        }
    }
}

pub(crate) fn fault(code: &str) -> Result<ControlFault, ControlError> {
    ControlFault::new(code, format!("{code} fault"))
}

pub(crate) fn interaction() -> Result<ControlInteractionRef, ControlError> {
    ControlInteractionRef::new("todos.create", "sha256:contract-v1")
}

pub(crate) fn input() -> Result<NormalizedInput, ControlError> {
    NormalizedInput::new("application/json", br#"{"title":"ship"}"#.to_vec())
}

pub(crate) fn actor(name: &str) -> Result<Actor, ControlError> {
    Actor::new(name)
}

pub(crate) fn key(value: &str) -> Result<InteractionIdempotencyKey, ControlError> {
    InteractionIdempotencyKey::new(value)
}

pub(crate) fn policy_handler<P: ControlPolicy>(
    policy: P,
    clock: TestClock,
) -> Result<Handler<P>, ControlError> {
    Ok(ControlledHandler::new(
        interaction()?,
        TestStore::default(),
        clock,
        TestIds::default(),
        policy,
    ))
}
