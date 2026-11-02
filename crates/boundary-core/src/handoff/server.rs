use super::protocol::{
    HandoffError, HandoffFaultCause, HandoffInvocation, HandoffOutcome, HandoffResult,
    HandoffValidationIssue, input_is_valid, validate_invocation, validate_outcome,
};
use crate::lifecycle::{
    Admission, Binding, BindingManifest, InteractionMode, InvocationCertainty,
    PortableInvocationOutcome,
};

/// Checked transport-neutral server boundary over one live Binding.
pub struct CheckedHandoff<'a, Context: Sync + ?Sized, A> {
    binding: &'a Binding<Context, A>,
}

impl<Context: Sync + ?Sized, A> CheckedHandoff<'_, Context, A> {
    /// Returns the exact data-only handshake manifest.
    #[must_use]
    pub const fn manifest(&self) -> &BindingManifest {
        self.binding.manifest()
    }
}

impl<Context, A> CheckedHandoff<'_, Context, A>
where
    Context: Sync + ?Sized + 'static,
    A: Admission<Context>,
{
    /// Validates and executes one exact invocation without retry or rebinding.
    ///
    /// The caller context is invocation-scoped and reaches admission and the
    /// installed realization by exact reference.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] for identity drift before dispatch. Invalid
    /// live outcomes are converted into identity-bearing sanitized faults.
    pub async fn invoke(
        &self,
        invocation: HandoffInvocation,
        context: &Context,
    ) -> Result<HandoffOutcome, HandoffError> {
        let interaction = validate_invocation(self.binding.manifest(), &invocation)?;
        if !input_is_valid(self.binding.manifest(), &invocation) {
            return HandoffOutcome::new(
                &invocation,
                InvocationCertainty::NotStarted,
                HandoffResult::Fault {
                    cause: HandoffFaultCause::InvalidInput,
                    issues: vec![HandoffValidationIssue::invalid_input()],
                },
            );
        }
        let portable = self
            .binding
            .caller()
            .invoke_portable(context, interaction, invocation.input().clone())
            .await;
        let (certainty, result) = portable_result(portable);
        if let Ok(outcome) = HandoffOutcome::new(&invocation, certainty, result)
            && validate_outcome(self.binding.manifest(), &outcome).is_ok()
        {
            return Ok(outcome);
        }
        invalid_live_outcome(&invocation)
    }
}

fn invalid_live_outcome(invocation: &HandoffInvocation) -> Result<HandoffOutcome, HandoffError> {
    let (certainty, cause) = match invocation.mode() {
        InteractionMode::Direct => (
            InvocationCertainty::Unknown,
            HandoffFaultCause::InvalidRealizationOutcome,
        ),
        InteractionMode::Request => (
            InvocationCertainty::NotStarted,
            HandoffFaultCause::RequestFailed,
        ),
    };
    HandoffOutcome::new(
        invocation,
        certainty,
        HandoffResult::Fault {
            cause,
            issues: Vec::new(),
        },
    )
}

/// Creates a checked server boundary over one exact live Binding.
#[must_use]
pub const fn checked_handoff<Context: Sync + ?Sized, A>(
    binding: &Binding<Context, A>,
) -> CheckedHandoff<'_, Context, A> {
    CheckedHandoff { binding }
}

fn portable_result(outcome: PortableInvocationOutcome) -> (InvocationCertainty, HandoffResult) {
    match outcome {
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
    }
}
