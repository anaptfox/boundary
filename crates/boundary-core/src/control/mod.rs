//! Durable control for effects whose completion may be uncertain.
//!
//! Control is intentionally independent of [`crate::Interaction`] and the native
//! runtime. A host installs it around a changing interaction without adding
//! synthetic interactions to the program or changing the program digest.

mod handler;
mod outcome;
mod stores;
mod types;
mod validation;

#[cfg(feature = "test-util")]
mod test_util;

pub use handler::ControlledHandler;
pub use stores::{
    AllowAll, ApplyFailure, ApplyResult, AuthorityStore, BeginAttempt, Clock, CommitReceipt,
    ControlPolicy, ControlledEffect, ExecutionJournal, IdKind, IdSource, LeaseClaim, LeaseRequest,
    ReconcileContext, Reconciliation, StoreInsert, Verification,
};
pub use types::{
    Actor, ApplyPermit, ApprovalDecision, ApprovalId, ApprovalRecord, AttemptId, AttemptRecord,
    ClaimId, ControlError, ControlFault, ControlInteractionRef, ControlOutcome, DurationMillis,
    FenceToken, GrantId, GrantRecord, InputFingerprint, InteractionIdempotencyKey, LeaseId,
    LeaseRecord, NormalizedInput, ProposalId, ProposalRecord, ReceiptId, ReceiptOutcome,
    ReceiptRecord, Timestamp,
};

#[cfg(feature = "test-util")]
pub use test_util::{DeterministicIds, InMemoryControlStore, ManualClock, TestUtilError};
