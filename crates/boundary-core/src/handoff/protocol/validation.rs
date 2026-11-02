use super::{
    HandoffDiagnosticCode, HandoffError, HandoffFaultCause, HandoffInvocation, HandoffOutcome,
    HandoffResult, HandoffValidationIssue,
};
use crate::{
    InteractionId,
    lifecycle::{
        BindingDigest, BindingManifest, BoundInteraction, InstallationId, InteractionMode,
        InvocationCertainty,
    },
};

pub(crate) fn validate_invocation<'a>(
    manifest: &'a BindingManifest,
    invocation: &HandoffInvocation,
) -> Result<&'a BoundInteraction, HandoffError> {
    validate_pins(
        manifest,
        &invocation.binding_digest,
        &invocation.installation_id,
    )?;
    let interaction = manifest_interaction(manifest, &invocation.interaction_id, invocation.mode)?;
    if interaction.expected_contract_digest() != &invocation.expected_contract_digest
        || interaction.actual_contract_digest() != &invocation.actual_contract_digest
    {
        return Err(failure(HandoffDiagnosticCode::StaleContract, "contract"));
    }
    if interaction.realization_id() != &invocation.realization_id {
        return Err(failure(
            HandoffDiagnosticCode::StaleRealization,
            "realizationId",
        ));
    }
    Ok(interaction)
}

pub(crate) fn input_is_valid(manifest: &BindingManifest, invocation: &HandoffInvocation) -> bool {
    let expected = manifest
        .expected_program()
        .interaction(&invocation.interaction_id);
    let actual = manifest
        .actual_program()
        .interaction(&invocation.interaction_id);
    expected.is_some_and(|descriptor| {
        descriptor
            .contract()
            .input_schema()
            .accepts(&invocation.input)
    }) && actual.is_some_and(|descriptor| {
        descriptor
            .contract()
            .input_schema()
            .accepts(&invocation.input)
    })
}

pub(crate) fn validate_outcome(
    manifest: &BindingManifest,
    outcome: &HandoffOutcome,
) -> Result<(), HandoffError> {
    validate_pins(manifest, &outcome.binding_digest, &outcome.installation_id)?;
    let interaction = manifest_interaction(manifest, &outcome.interaction_id, outcome.mode)?;
    if interaction.expected_contract_digest() != &outcome.expected_contract_digest
        || interaction.actual_contract_digest() != &outcome.actual_contract_digest
    {
        return Err(failure(HandoffDiagnosticCode::StaleContract, "contract"));
    }
    if interaction.realization_id() != &outcome.realization_id {
        return Err(failure(
            HandoffDiagnosticCode::StaleRealization,
            "realizationId",
        ));
    }
    validate_result(outcome.mode, outcome.certainty, &outcome.result)?;
    let expected = manifest
        .expected_program()
        .interaction(&outcome.interaction_id)
        .ok_or_else(|| failure(HandoffDiagnosticCode::InvalidOutcome, "interactionId"))?;
    let actual = manifest
        .actual_program()
        .interaction(&outcome.interaction_id)
        .ok_or_else(|| failure(HandoffDiagnosticCode::InvalidOutcome, "interactionId"))?;
    let valid = match &outcome.result {
        HandoffResult::Returned { value } => {
            expected.contract().output_schema().accepts(value)
                && actual.contract().output_schema().accepts(value)
        }
        HandoffResult::DeclaredError { code, details } => {
            // The contract declares the complete `{ code, details }` value.
            let declared = serde_json::json!({ "code": code, "details": details });
            expected
                .contract()
                .error_schema()
                .is_some_and(|schema| schema.accepts(&declared))
                && actual
                    .contract()
                    .error_schema()
                    .is_some_and(|schema| schema.accepts(&declared))
        }
        HandoffResult::Proposed { proposal } => interaction
            .request_identity()
            .is_some_and(|request| request.preview_schema().accepts(proposal)),
        HandoffResult::Denied { .. } | HandoffResult::Fault { .. } => true,
    };
    if valid {
        Ok(())
    } else {
        Err(failure(HandoffDiagnosticCode::InvalidOutcome, "result"))
    }
}

pub(crate) fn validate_response(
    invocation: &HandoffInvocation,
    outcome: &HandoffOutcome,
) -> Result<(), HandoffError> {
    let matches = outcome.binding_digest == invocation.binding_digest
        && outcome.installation_id == invocation.installation_id
        && outcome.interaction_id == invocation.interaction_id
        && outcome.expected_contract_digest == invocation.expected_contract_digest
        && outcome.actual_contract_digest == invocation.actual_contract_digest
        && outcome.mode == invocation.mode
        && outcome.realization_id == invocation.realization_id;
    if matches {
        Ok(())
    } else {
        Err(failure(HandoffDiagnosticCode::InvalidOutcome, "outcome"))
    }
}

fn validate_pins(
    manifest: &BindingManifest,
    binding_digest: &BindingDigest,
    installation_id: &InstallationId,
) -> Result<(), HandoffError> {
    if binding_digest != manifest.binding_digest() {
        return Err(failure(
            HandoffDiagnosticCode::StaleBinding,
            "bindingDigest",
        ));
    }
    if installation_id != manifest.installation_id() {
        return Err(failure(
            HandoffDiagnosticCode::StaleInstallation,
            "installationId",
        ));
    }
    Ok(())
}

pub(super) fn manifest_interaction<'a>(
    manifest: &'a BindingManifest,
    interaction_id: &InteractionId,
    mode: InteractionMode,
) -> Result<&'a BoundInteraction, HandoffError> {
    let mut saw_interaction = false;
    for interaction in manifest.interactions() {
        if interaction.interaction_id() != interaction_id {
            continue;
        }
        saw_interaction = true;
        if interaction.mode() == mode {
            return Ok(interaction);
        }
    }
    Err(failure(
        if saw_interaction {
            HandoffDiagnosticCode::ModeNotExposed
        } else {
            HandoffDiagnosticCode::InteractionNotExposed
        },
        if saw_interaction {
            "mode"
        } else {
            "interactionId"
        },
    ))
}

pub(super) fn validate_result(
    mode: InteractionMode,
    certainty: InvocationCertainty,
    result: &HandoffResult,
) -> Result<(), HandoffError> {
    let legal = match result {
        HandoffResult::Returned { .. } => {
            mode == InteractionMode::Direct && certainty == InvocationCertainty::Completed
        }
        HandoffResult::DeclaredError { code, .. } => {
            mode == InteractionMode::Direct
                && certainty == InvocationCertainty::Completed
                && !code.trim().is_empty()
        }
        HandoffResult::Proposed { .. } => {
            mode == InteractionMode::Request && certainty == InvocationCertainty::NotStarted
        }
        HandoffResult::Denied { code } => {
            certainty == InvocationCertainty::NotStarted && !code.trim().is_empty()
        }
        HandoffResult::Fault { cause, issues } => {
            fault_is_legal(mode, certainty, *cause)
                && issues.iter().all(HandoffValidationIssue::is_valid)
                && (issues.is_empty() || *cause == HandoffFaultCause::InvalidInput)
        }
    };
    if legal {
        Ok(())
    } else {
        Err(failure(HandoffDiagnosticCode::InvalidEnvelope, "result"))
    }
}

fn fault_is_legal(
    mode: InteractionMode,
    certainty: InvocationCertainty,
    cause: HandoffFaultCause,
) -> bool {
    match cause {
        HandoffFaultCause::InvalidInput
        | HandoffFaultCause::Revoked
        | HandoffFaultCause::AdmissionFailed
        | HandoffFaultCause::InvalidInvocation => certainty == InvocationCertainty::NotStarted,
        HandoffFaultCause::RequestFailed => {
            mode == InteractionMode::Request && certainty == InvocationCertainty::NotStarted
        }
        HandoffFaultCause::InvalidRealizationOutcome => {
            mode == InteractionMode::Direct && certainty == InvocationCertainty::Unknown
        }
        HandoffFaultCause::RealizationFailed => {
            certainty == InvocationCertainty::Unknown
                || (mode == InteractionMode::Direct
                    && matches!(
                        certainty,
                        InvocationCertainty::NotStarted | InvocationCertainty::NotCompleted
                    ))
        }
    }
}

fn failure(code: HandoffDiagnosticCode, path: &'static str) -> HandoffError {
    HandoffError {
        code,
        path,
        message: "identity, schema, or certainty law failed",
    }
}
