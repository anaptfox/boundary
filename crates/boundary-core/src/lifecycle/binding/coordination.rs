use super::{BindingManifest, Bound, BoundInteraction, InvocationCertainty};
use crate::handoff::{HandoffError, HandoffInvocation, HandoffOutcome, HandoffResult};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};
use thiserror::Error;

/// Host-owned coordination future; no executor, persistence or scheduler is implied.
pub type CoordinationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HandoffOutcome, CoordinationError>> + Send + 'a>>;

/// Sanitized host coordinator failure, whose consequential outcome stays unknown.
#[derive(Clone, Copy, Debug, Error)]
#[error("host invocation coordination failed")]
pub struct CoordinationError;

/// Exact checked portable input and identity, borrowing the host context unchanged.
pub struct CoordinatedInvocation<'a, C: Sync + ?Sized> {
    pub(super) manifest: &'a BindingManifest,
    pub(super) interaction: &'a BoundInteraction,
    pub(super) invocation: &'a HandoffInvocation,
    pub(super) context: &'a C,
}

impl<'a, C: Sync + ?Sized> CoordinatedInvocation<'a, C> {
    /// Returns all exact Binding, Projection and Installation identity pins.
    #[must_use]
    pub const fn manifest(&self) -> &'a BindingManifest {
        self.manifest
    }
    /// Returns the exact selected realization, mode and request/control identity.
    #[must_use]
    pub const fn interaction(&self) -> &'a BoundInteraction {
        self.interaction
    }
    /// Returns checked, immutable portable input.
    #[must_use]
    pub const fn input(&self) -> &'a Value {
        self.invocation.input()
    }
    /// Returns the exact invocation-scoped host context reference.
    #[must_use]
    pub const fn context(&self) -> &'a C {
        self.context
    }
    /// Constructs a pinned candidate outcome. Returned data is revalidated afterwards.
    ///
    /// # Errors
    /// Rejects contradictory result/certainty combinations.
    pub fn outcome(
        &self,
        certainty: InvocationCertainty,
        result: HandoffResult,
    ) -> Result<HandoffOutcome, HandoffError> {
        HandoffOutcome::new(self.invocation, certainty, result)
    }
}

/// Ownership-consuming continuation: an invocation can dispatch at most once.
/// Dropping it permits a host to return explicitly retained evidence instead.
pub struct InvocationContinuation<'a> {
    pub(super) run: Box<dyn FnOnce() -> CoordinationFuture<'a> + Send + 'a>,
}

impl<'a> InvocationContinuation<'a> {
    /// Rechecks live revocation and enters the next required hook or realization.
    /// Ownership prevents a second dispatch:
    ///
    /// ```compile_fail
    /// use boundary_core::lifecycle::InvocationContinuation;
    /// fn repeat(proceed: InvocationContinuation<'_>) {
    ///     let _first = proceed.proceed();
    ///     let _second = proceed.proceed();
    /// }
    /// ```
    #[must_use = "the continuation must be awaited to dispatch"]
    pub fn proceed(self) -> CoordinationFuture<'a> {
        (self.run)()
    }
}

/// Native host coordination after checked input and inherited admission.
/// Retained results must match every pin and schema. Errors remain unknown;
/// Boundary never retries coordination or dispatch.
pub trait InvocationCoordinator<C: Sync + ?Sized>: Send + Sync + 'static {
    /// Coordinates one invocation with an owned one-shot continuation.
    fn coordinate<'a>(
        &'a self,
        invocation: CoordinatedInvocation<'a, C>,
        proceed: InvocationContinuation<'a>,
    ) -> CoordinationFuture<'a>;
}

/// Adds a private host coordinator without changing declaration or Binding identity.
/// Required inherited coordinators are preserved, including on restricted children.
/// Native typed calls cross their codecs only when this is explicitly opted in.
///
/// # Errors
/// Refuses replacement of an already required coordinator, including inheritance.
pub fn coordinate_binding<C: Sync + ?Sized + 'static, A, K: InvocationCoordinator<C>>(
    mut bound: Bound<C, A>,
    coordinator: K,
) -> Result<Bound<C, A>, CoordinationError> {
    if !bound.binding.coordinators.is_empty() {
        return Err(CoordinationError);
    }
    bound.binding.coordinators.push(Arc::new(coordinator));
    Ok(bound)
}
