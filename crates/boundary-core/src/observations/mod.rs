//! Host-owned immutable observations and validated read reuse.
//!
//! Snapshot adapters own observation completeness. Point tokens cover presence
//! and content; query tokens cover membership, ordering, and returned values.
//! Capturing ambient I/O or proving evaluator purity is outside this capability.

mod executor;
mod view;

use std::future::Future;

use thiserror::Error;

use crate::{Interaction, ReadOnly};

pub(crate) use executor::{ObservedExecutor, ReadFailure};
pub use view::{Observation, ObservationView};

/// Whether a prior observation still establishes the same answer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceValidation {
    /// The evidence still matches in this snapshot.
    Matching,
    /// An observed fact changed.
    Changed,
    /// The adapter cannot establish whether the evidence matches.
    Unavailable,
}

/// Failure of the host-owned observation mechanism or fresh authorization.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ObservationFault {
    /// Fresh host authorization denied this read before evaluation.
    #[error("observed read denied: {0}")]
    Denied(String),
    /// A snapshot or read could not be acquired.
    #[error("observation adapter unavailable")]
    Unavailable,
}

/// One point read with explicit absence and its host-issued evidence token.
#[derive(Clone, Debug)]
pub struct PointObservation<V, T> {
    /// `None` means absence; `Some` can contain a native null-like value.
    pub value: Option<V>,
    /// Evidence covering both presence and exact observed content.
    pub token: T,
}

/// One query answer with its host-issued evidence token.
#[derive(Clone, Debug)]
pub struct QueryObservation<V, T> {
    /// Native query result, including its ordering.
    pub value: V,
    /// Evidence covering membership, ordering, and returned values.
    pub token: T,
}

/// An immutable host snapshot supporting complete point and query observations.
pub trait ObservationSnapshot: Sync {
    /// Host-native point key.
    type Key: Clone + Send + Sync;
    /// Owned query descriptor, including filters, order, and pagination.
    type Query: Clone + Send + Sync;
    /// Host-native point value.
    type Value;
    /// Host-native ordered query result.
    type QueryResult;
    /// Owned evidence with no mandatory portable representation.
    type Token: Clone + Send + Sync;

    /// Reads one point and produces complete presence/content evidence.
    ///
    /// # Errors
    /// Returns a sanitized failure when the read cannot be observed.
    fn get(
        &self,
        key: &Self::Key,
    ) -> Result<PointObservation<Self::Value, Self::Token>, ObservationFault>;

    /// Executes one query and produces complete membership/order/content evidence.
    ///
    /// # Errors
    /// Returns a sanitized failure when the query cannot be observed.
    fn query(
        &self,
        query: &Self::Query,
    ) -> Result<QueryObservation<Self::QueryResult, Self::Token>, ObservationFault>;

    /// Checks evidence against this same immutable snapshot.
    ///
    /// # Errors
    /// Returns a sanitized failure when validation itself fails. This causes
    /// fresh evaluation, just as `Unavailable` does.
    fn validate(
        &self,
        evidence: &Observation<Self::Key, Self::Query, Self::Token>,
    ) -> Result<EvidenceValidation, ObservationFault>;
}

/// Host-owned acquisition retaining one immutable snapshot through callback return.
pub trait SnapshotSource<C: Sync + ?Sized = ()>: Send + Sync + 'static {
    /// Native immutable view. Implementations may hold a transaction or lock.
    type Snapshot: ObservationSnapshot;

    /// Runs validation, evaluation, and result use in one snapshot boundary.
    ///
    /// # Errors
    /// Returns a sanitized failure if the boundary cannot be established.
    fn with_snapshot<'a, R, F>(
        &'a self,
        context: &'a C,
        use_snapshot: F,
    ) -> impl Future<Output = Result<R, ObservationFault>> + Send + 'a
    where
        R: Send + 'a,
        F: FnOnce(&Self::Snapshot) -> R + Send + 'a;
}

/// Host-owned policy, evaluation, and native output validation for one read.
pub trait ReadEvaluator<O, C, S>: Send + Sync + 'static
where
    O: Interaction<Effect = ReadOnly>,
    C: Sync + ?Sized,
    S: ObservationSnapshot,
{
    /// Exact visibility context identity used to isolate retained observations.
    type Scope: Clone + Eq + Send + Sync;

    /// Returns an owned host visibility identity for this request.
    fn scope(&self, input: &O, context: &C) -> Self::Scope;

    /// Checks fresh host authorization before every evaluation or reuse.
    fn authorize<'a>(
        &'a self,
        input: &'a O,
        context: &'a C,
    ) -> impl Future<Output = Result<(), ObservationFault>> + Send + 'a;

    /// Computes a native result using the capturing snapshot view.
    ///
    /// # Errors
    /// Returns the interaction's declared domain error. Failed computations
    /// and failed reads are never retained.
    fn evaluate(
        &self,
        input: &O,
        context: &C,
        view: &mut ObservationView<'_, S>,
    ) -> Result<O::Output, O::Error>;

    /// Checks application output constraints without crossing a wire codec.
    fn valid_output(&self, _output: &O::Output) -> bool {
        true
    }

    /// Receives private, best-effort counters. A panic here does not change results.
    fn diagnostic(&self, _diagnostic: ReadDiagnostic) {}
}

/// Explicit read-reuse policy.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ReadReuse {
    /// Always evaluate freshly and retain no entries.
    #[default]
    Off,
    /// Reuse only after checking complete evidence in the current snapshot.
    Validated,
}

/// Installation-local retained-read configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObservedReadOptions {
    /// Reuse is off unless explicitly selected.
    pub reuse: ReadReuse,
    /// FIFO retention bound. Zero disables retention.
    pub max_entries: usize,
}

impl Default for ObservedReadOptions {
    fn default() -> Self {
        Self {
            reuse: ReadReuse::Off,
            max_entries: 128,
        }
    }
}

/// Why one successful invocation evaluated or reused its result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadReason {
    /// Reuse was disabled.
    ReuseOff,
    /// No retained entry matched exact input and visibility scope.
    Miss,
    /// Every retained observation matched.
    Matching,
    /// At least one observed fact changed.
    Changed,
    /// At least one observation could not be validated.
    Unavailable,
}

/// Private host counters; never an invocation or portable evidence envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReadDiagnostic {
    /// Whether evaluation was skipped after successful validation.
    pub reused: bool,
    /// Number of evidence items validated this invocation.
    pub validations: usize,
    /// Number of observations captured or reused.
    pub observations: usize,
    /// Why this invocation evaluated or reused.
    pub reason: ReadReason,
}
