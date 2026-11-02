use serde_json::Value;

use super::{
    AdmissionDecision, AdmissionInput, AdmissionRequest, Caller, InstallationCallFault,
    InstallationInput, InstallationOutcome, InstallationRequestFault,
};
use crate::handoff::HandoffFaultCause;
use crate::lifecycle::{Admission, BoundInteraction, InteractionMode, InvocationCertainty};

#[derive(Clone)]
pub(crate) enum PortableInvocationOutcome {
    Returned(Value),
    Declared {
        code: String,
        details: Value,
    },
    Proposed(Value),
    Denied(String),
    Fault {
        cause: HandoffFaultCause,
        certainty: InvocationCertainty,
    },
}

impl<Context, A> Caller<'_, Context, A>
where
    Context: Sync + ?Sized + 'static,
    A: Admission<Context>,
{
    pub(crate) async fn invoke_portable(
        &self,
        context: &Context,
        bound: &BoundInteraction,
        input: Value,
    ) -> PortableInvocationOutcome {
        if self.check_live().is_err() {
            return fault(HandoffFaultCause::Revoked, InvocationCertainty::NotStarted);
        }
        if !self.binding.coordinators.is_empty() && !self.coordinated_input_valid(bound, &input) {
            return fault(
                HandoffFaultCause::InvalidInput,
                InvocationCertainty::NotStarted,
            );
        }
        let live = || !self.binding.is_revoked();
        match self
            .binding
            .admission
            .admit(AdmissionRequest {
                context,
                interaction: bound,
                mode: bound.mode(),
                input: AdmissionInput::Portable(&input),
                live: &live,
            })
            .await
        {
            AdmissionDecision::Admit => {}
            AdmissionDecision::Deny { code } => {
                return PortableInvocationOutcome::Denied(nonempty_code(code));
            }
        }
        if self.check_live().is_err() {
            return fault(HandoffFaultCause::Revoked, InvocationCertainty::NotStarted);
        }
        self.invoke_after_admission(context, bound, input).await
    }

    pub(super) async fn dispatch_portable(
        &self,
        context: &Context,
        bound: &BoundInteraction,
        input: Value,
    ) -> PortableInvocationOutcome {
        match bound.mode() {
            InteractionMode::Direct => self.invoke_direct(context, bound, input).await,
            InteractionMode::Request => self.invoke_request(context, bound, input).await,
        }
    }

    async fn invoke_direct(
        &self,
        context: &Context,
        bound: &BoundInteraction,
        input: Value,
    ) -> PortableInvocationOutcome {
        let Some(realization) = self
            .binding
            .installation
            .direct(bound.interaction_id(), bound.actual_contract_digest())
        else {
            return fault(
                HandoffFaultCause::RealizationFailed,
                InvocationCertainty::NotStarted,
            );
        };
        match realization
            .call(context, InstallationInput::Portable(input))
            .await
        {
            Ok(InstallationOutcome::PortableReturned(value)) => {
                PortableInvocationOutcome::Returned(value)
            }
            Ok(InstallationOutcome::PortableDeclared { code, details }) => {
                PortableInvocationOutcome::Declared { code, details }
            }
            Ok(InstallationOutcome::Denied(code)) => {
                PortableInvocationOutcome::Denied(nonempty_code(code))
            }
            Ok(InstallationOutcome::Returned(_) | InstallationOutcome::Declared(_))
            | Err(InstallationCallFault::InvalidOutcome) => fault(
                HandoffFaultCause::InvalidRealizationOutcome,
                InvocationCertainty::Unknown,
            ),
            Err(InstallationCallFault::InvalidInput) => fault(
                HandoffFaultCause::InvalidInput,
                InvocationCertainty::NotStarted,
            ),
            Err(InstallationCallFault::NotStarted) => fault(
                HandoffFaultCause::RealizationFailed,
                InvocationCertainty::NotStarted,
            ),
            Err(InstallationCallFault::NotCompleted) => fault(
                HandoffFaultCause::RealizationFailed,
                InvocationCertainty::NotCompleted,
            ),
            Err(InstallationCallFault::Unknown) => fault(
                HandoffFaultCause::RealizationFailed,
                InvocationCertainty::Unknown,
            ),
        }
    }

    async fn invoke_request(
        &self,
        context: &Context,
        bound: &BoundInteraction,
        input: Value,
    ) -> PortableInvocationOutcome {
        let Some(realization) = self
            .binding
            .installation
            .request(bound.interaction_id(), bound.actual_contract_digest())
        else {
            return fault(
                HandoffFaultCause::RequestFailed,
                InvocationCertainty::NotStarted,
            );
        };
        match realization.request(context, input).await {
            Ok(proposal)
                if bound
                    .request_identity()
                    .is_some_and(|request| request.preview_schema().accepts(&proposal)) =>
            {
                PortableInvocationOutcome::Proposed(proposal)
            }
            Ok(_) | Err(InstallationRequestFault::Unknown) => fault(
                HandoffFaultCause::RequestFailed,
                InvocationCertainty::NotStarted,
            ),
            Err(InstallationRequestFault::InvalidInput) => fault(
                HandoffFaultCause::InvalidInput,
                InvocationCertainty::NotStarted,
            ),
            Err(InstallationRequestFault::Denied(code)) => {
                PortableInvocationOutcome::Denied(nonempty_code(code))
            }
        }
    }
}

fn nonempty_code(code: String) -> String {
    if code.trim().is_empty() {
        "denied".to_owned()
    } else {
        code
    }
}

fn fault(cause: HandoffFaultCause, certainty: InvocationCertainty) -> PortableInvocationOutcome {
    PortableInvocationOutcome::Fault { cause, certainty }
}
