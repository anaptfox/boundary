use super::{
    Admission, BoundInteraction, Caller, CallerError, PortableInvocationOutcome, RequestError,
};
use crate::handoff::{
    HandoffFaultCause, HandoffInvocation, HandoffOutcome, HandoffResult, input_is_valid,
    validate_outcome, validate_response,
};
use crate::lifecycle::{
    CoordinatedInvocation, CoordinationError, CoordinationFuture, InvocationCertainty,
    InvocationContinuation,
};
use crate::{Interaction, WireCodec};
use serde_json::Value;
use std::{
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::atomic::{AtomicBool, Ordering},
    task::{Context as TaskContext, Poll},
};

struct GuardedFuture<'a>(CoordinationFuture<'a>);
impl Future for GuardedFuture<'_> {
    type Output = Result<HandoffOutcome, CoordinationError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        catch_unwind(AssertUnwindSafe(|| self.0.as_mut().poll(cx)))
            .unwrap_or(Poll::Ready(Err(CoordinationError)))
    }
}

impl<C, A> Caller<'_, C, A>
where
    C: Sync + ?Sized + 'static,
    A: Admission<C>,
{
    pub(super) fn coordinated_input_valid(&self, bound: &BoundInteraction, input: &Value) -> bool {
        HandoffInvocation::new(
            &self.binding.manifest,
            bound.interaction_id(),
            bound.mode(),
            input.clone(),
        )
        .is_ok_and(|invocation| input_is_valid(&self.binding.manifest, &invocation))
    }

    pub(super) async fn invoke_after_admission(
        &self,
        context: &C,
        bound: &BoundInteraction,
        input: Value,
    ) -> PortableInvocationOutcome {
        if self.binding.coordinators.is_empty() {
            return self.dispatch_portable(context, bound, input).await;
        }
        let Ok(invocation) = HandoffInvocation::new(
            &self.binding.manifest,
            bound.interaction_id(),
            bound.mode(),
            input,
        ) else {
            return unknown();
        };
        let dispatched = AtomicBool::new(false);
        match self
            .coordinate_at(context, bound, &invocation, 0, &dispatched)
            .await
        {
            Ok(outcome) => from_handoff(outcome),
            Err(_) => unknown(),
        }
    }

    fn coordinate_at<'a>(
        &'a self,
        context: &'a C,
        bound: &'a BoundInteraction,
        invocation: &'a HandoffInvocation,
        index: usize,
        dispatched: &'a AtomicBool,
    ) -> CoordinationFuture<'a> {
        Box::pin(async move {
            // Every owned continuation rechecks revocation after any host queue awaits.
            if self.check_live().is_err() {
                return HandoffOutcome::new(
                    invocation,
                    InvocationCertainty::NotStarted,
                    HandoffResult::Fault {
                        cause: HandoffFaultCause::Revoked,
                        issues: Vec::new(),
                    },
                )
                .map_err(|_| CoordinationError);
            }
            let Some(coordinator) = self.binding.coordinators.get(index) else {
                dispatched.store(true, Ordering::Release);
                let result = self
                    .dispatch_portable(context, bound, invocation.input().clone())
                    .await;
                return into_handoff(result, invocation);
            };
            let next = InvocationContinuation {
                run: Box::new(move || {
                    self.coordinate_at(context, bound, invocation, index + 1, dispatched)
                }),
            };
            let request = CoordinatedInvocation {
                manifest: &self.binding.manifest,
                interaction: bound,
                invocation,
                context,
            };
            let future = catch_unwind(AssertUnwindSafe(|| coordinator.coordinate(request, next)))
                .map_err(|_| CoordinationError)?;
            let outcome = GuardedFuture(future).await?;
            // A queued retained disclosure remains subject to live revocation.
            // Once dispatch entered, preserve its observed execution truth.
            if !dispatched.load(Ordering::Acquire) && self.check_live().is_err() {
                return HandoffOutcome::new(
                    invocation,
                    InvocationCertainty::NotStarted,
                    HandoffResult::Fault {
                        cause: HandoffFaultCause::Revoked,
                        issues: Vec::new(),
                    },
                )
                .map_err(|_| CoordinationError);
            }
            validate_response(invocation, &outcome).map_err(|_| CoordinationError)?;
            validate_outcome(&self.binding.manifest, &outcome).map_err(|_| CoordinationError)?;
            Ok(outcome)
        })
    }

    pub(super) async fn call_coordinated<O: Interaction>(
        &self,
        context: &C,
        bound: &BoundInteraction,
        input: Value,
    ) -> Result<O::Output, CallerError<O::Error>> {
        match self.invoke_portable(context, bound, input).await {
            PortableInvocationOutcome::Returned(value) => {
                O::OutputCodec::decode(value).map_err(|_| CallerError::Unknown)
            }
            PortableInvocationOutcome::Declared { code, details } => Err(CallerError::Declared(
                crate::codec::decode_declared::<O::Error, O::ErrorCodec>(&code, details)
                    .map_err(|_| CallerError::Unknown)?,
            )),
            PortableInvocationOutcome::Denied(code) => Err(CallerError::Denied { code }),
            PortableInvocationOutcome::Fault {
                certainty: InvocationCertainty::Unknown,
                ..
            } => Err(CallerError::Unknown),
            PortableInvocationOutcome::Fault {
                certainty: InvocationCertainty::NotCompleted,
                ..
            } => Err(CallerError::NotCompleted),
            PortableInvocationOutcome::Fault {
                cause: HandoffFaultCause::Revoked,
                ..
            } => Err(CallerError::Revoked),
            PortableInvocationOutcome::Fault {
                cause: HandoffFaultCause::InvalidInput,
                ..
            } => Err(CallerError::InvalidInput),
            PortableInvocationOutcome::Fault {
                certainty: InvocationCertainty::NotStarted,
                ..
            } => Err(CallerError::NotStarted),
            _ => Err(CallerError::Unknown),
        }
    }

    pub(super) async fn request_coordinated(
        &self,
        context: &C,
        bound: &BoundInteraction,
        input: Value,
    ) -> Result<Value, RequestError> {
        match self.invoke_portable(context, bound, input).await {
            PortableInvocationOutcome::Proposed(value) => Ok(value),
            PortableInvocationOutcome::Denied(code) => Err(RequestError::Denied { code }),
            PortableInvocationOutcome::Fault {
                certainty: InvocationCertainty::Unknown,
                ..
            } => Err(RequestError::Uncertain),
            PortableInvocationOutcome::Fault {
                cause: HandoffFaultCause::Revoked,
                ..
            } => Err(RequestError::Revoked),
            PortableInvocationOutcome::Fault {
                cause: HandoffFaultCause::InvalidInput,
                ..
            } => Err(RequestError::InvalidInput),
            _ => Err(RequestError::Unknown),
        }
    }
}

fn unknown() -> PortableInvocationOutcome {
    PortableInvocationOutcome::Fault {
        cause: HandoffFaultCause::RealizationFailed,
        certainty: InvocationCertainty::Unknown,
    }
}

fn into_handoff(
    outcome: PortableInvocationOutcome,
    invocation: &HandoffInvocation,
) -> Result<HandoffOutcome, CoordinationError> {
    let (certainty, result) = match outcome {
        PortableInvocationOutcome::Returned(value) => (
            InvocationCertainty::Completed,
            HandoffResult::Returned { value },
        ),
        PortableInvocationOutcome::Declared { code, details } => (
            InvocationCertainty::Completed,
            HandoffResult::DeclaredError { code, details },
        ),
        PortableInvocationOutcome::Proposed(proposal) => (
            InvocationCertainty::NotStarted,
            HandoffResult::Proposed { proposal },
        ),
        PortableInvocationOutcome::Denied(code) => (
            InvocationCertainty::NotStarted,
            HandoffResult::Denied { code },
        ),
        PortableInvocationOutcome::Fault { cause, certainty } => (
            certainty,
            HandoffResult::Fault {
                cause,
                issues: Vec::new(),
            },
        ),
    };
    HandoffOutcome::new(invocation, certainty, result).map_err(|_| CoordinationError)
}

fn from_handoff(outcome: HandoffOutcome) -> PortableInvocationOutcome {
    let certainty = outcome.certainty();
    match outcome.into_result() {
        HandoffResult::Returned { value } => PortableInvocationOutcome::Returned(value),
        HandoffResult::DeclaredError { code, details } => {
            PortableInvocationOutcome::Declared { code, details }
        }
        HandoffResult::Proposed { proposal } => PortableInvocationOutcome::Proposed(proposal),
        HandoffResult::Denied { code } => PortableInvocationOutcome::Denied(code),
        HandoffResult::Fault { cause, .. } => PortableInvocationOutcome::Fault { cause, certainty },
    }
}
