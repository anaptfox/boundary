//! Deterministic host adapters for examples and tests.
//!
//! The store is process-local and is not durable. Production hosts should
//! implement the same CAS contracts using transactional persistence.

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

use super::{
    Actor, ApprovalId, ApprovalRecord, AttemptId, AttemptRecord, AuthorityStore, BeginAttempt,
    Clock, CommitReceipt, ControlError, ControlInteractionRef, DurationMillis, ExecutionJournal,
    FenceToken, GrantId, GrantRecord, IdKind, IdSource, InteractionIdempotencyKey, LeaseClaim,
    LeaseRecord, LeaseRequest, ProposalId, ProposalRecord, ReceiptId, ReceiptOutcome,
    ReceiptRecord, StoreInsert, Timestamp,
};

/// Error raised by deterministic test adapters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestUtilError(String);

impl fmt::Display for TestUtilError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for TestUtilError {}

impl From<ControlError> for TestUtilError {
    fn from(error: ControlError) -> Self {
        Self(error.to_string())
    }
}

/// Process-local implementation of both control persistence stores.
///
/// It preserves interaction-scoped idempotency, live-lease exclusion, monotonic
/// fencing, and receipt compare-and-swap behavior, but not process durability.
#[derive(Default)]
pub struct InMemoryControlStore {
    proposals: HashMap<ProposalId, ProposalRecord>,
    approvals: HashMap<ApprovalId, ApprovalRecord>,
    grants: HashMap<GrantId, GrantRecord>,
    attempts: HashMap<AttemptId, AttemptRecord>,
    keys: HashMap<(ControlInteractionRef, InteractionIdempotencyKey), AttemptId>,
    leases: HashMap<AttemptId, LeaseRecord>,
    receipts: HashMap<AttemptId, ReceiptRecord>,
}

impl InMemoryControlStore {
    /// Returns the number of idempotent attempts retained by the store.
    #[must_use]
    pub fn attempt_count(&self) -> usize {
        self.attempts.len()
    }

    /// Returns the number of current receipts retained by the store.
    #[must_use]
    pub fn receipt_count(&self) -> usize {
        self.receipts.len()
    }

    /// Returns the current lease for an attempt.
    #[must_use]
    pub fn lease_for(&self, attempt_id: &AttemptId) -> Option<&LeaseRecord> {
        self.leases.get(attempt_id)
    }

    /// Returns the current receipt for an attempt.
    #[must_use]
    pub fn receipt_for(&self, attempt_id: &AttemptId) -> Option<&ReceiptRecord> {
        self.receipts.get(attempt_id)
    }
}

impl AuthorityStore for InMemoryControlStore {
    type Error = TestUtilError;

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

impl ExecutionJournal for InMemoryControlStore {
    type Error = TestUtilError;

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
                .ok_or_else(|| TestUtilError("fence overflow".to_owned()))?,
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
        if receipt.attempt_id() != lease.attempt_id() || receipt.fence() != lease.fence() {
            return Err(TestUtilError(
                "receipt does not match lease fence".to_owned(),
            ));
        }
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

/// Cloneable manually controlled clock for deterministic recovery tests.
#[derive(Clone, Debug)]
pub struct ManualClock(Arc<AtomicU64>);

impl ManualClock {
    /// Creates a clock at `millis` since the test's chosen epoch.
    #[must_use]
    pub fn new(millis: u64) -> Self {
        Self(Arc::new(AtomicU64::new(millis)))
    }

    /// Sets the current test time.
    pub fn set(&self, millis: u64) {
        self.0.store(millis, Ordering::SeqCst);
    }

    /// Advances the clock with overflow checking.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when the timestamp would overflow.
    pub fn advance(&self, duration: DurationMillis) -> Result<Timestamp, ControlError> {
        let mut current = self.0.load(Ordering::SeqCst);
        loop {
            let next = Timestamp::from_millis(current)
                .checked_add(duration)?
                .as_millis();
            match self
                .0
                .compare_exchange(current, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return Ok(Timestamp::from_millis(next)),
                Err(observed) => current = observed,
            }
        }
    }
}

impl Clock for ManualClock {
    type Error = Infallible;

    fn now(&self) -> Result<Timestamp, Self::Error> {
        Ok(Timestamp::from_millis(self.0.load(Ordering::SeqCst)))
    }
}

/// Deterministic, fallible identifier source for examples and tests.
#[derive(Clone, Debug)]
pub struct DeterministicIds {
    prefix: String,
    next: u64,
}

impl DeterministicIds {
    /// Creates an id source using a validated prefix.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when `prefix` is not a valid bounded token.
    pub fn new(prefix: impl Into<String>) -> Result<Self, ControlError> {
        let prefix = Actor::new(prefix)?.as_str().to_owned();
        Ok(Self { prefix, next: 0 })
    }
}

impl Default for DeterministicIds {
    fn default() -> Self {
        Self {
            prefix: "test".to_owned(),
            next: 0,
        }
    }
}

impl IdSource for DeterministicIds {
    type Error = TestUtilError;

    fn next_id(&mut self, kind: IdKind) -> Result<String, Self::Error> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| TestUtilError("identifier sequence overflow".to_owned()))?;
        Ok(format!("{}-{kind:?}-{}", self.prefix, self.next))
    }
}
