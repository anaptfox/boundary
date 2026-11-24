//! Atomic static checks against an already-created binding manifest.

use serde::{Deserialize, Serialize};

use super::{Plan, PlanDigest};
use crate::{
    InteractionId, Program, contract_compatibility,
    lifecycle::{Binding, BindingDigest, BindingManifest},
};

/// Why a plan step is not fully represented by a binding.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreflightIssueReason {
    /// The interaction is absent from the binding.
    MissingInteraction,
    /// The alias is bound to another interaction.
    AliasMismatch,
    /// The requested realization mode is not bound.
    ModeNotBound,
    /// The installed contract is incompatible with the expected Program.
    ContractMismatch,
    /// The live binding has been revoked.
    BindingRevoked,
}

/// One failed step check in an atomic preflight report.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightIssue {
    /// Plan step identifier.
    pub step_id: String,
    /// Requested projection alias.
    pub alias: String,
    /// Requested interaction identifier.
    pub interaction_id: InteractionId,
    /// Failure category.
    pub reason: PreflightIssueReason,
    /// Human-readable explanation.
    pub message: String,
}

/// Complete preflight result; readiness means no step failed validation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    /// Identity of the checked plan.
    pub plan_digest: PlanDigest,
    /// Identity of the checked binding manifest.
    pub binding_digest: BindingDigest,
    /// All issues found across the plan.
    pub issues: Vec<PreflightIssue>,
}

impl PreflightReport {
    /// Returns whether every step passed preflight.
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.issues.is_empty()
    }
}

impl Plan {
    /// Checks every plan step against a durable binding manifest.
    #[must_use]
    pub fn preflight_manifest(
        &self,
        manifest: &BindingManifest,
        expected_program: Option<&Program>,
    ) -> PreflightReport {
        let mut issues = Vec::new();
        for step in self.steps() {
            let bound = manifest
                .interactions()
                .iter()
                .find(|entry| entry.alias() == step.alias && entry.mode() == step.mode);
            let matching_alias = manifest
                .interactions()
                .iter()
                .any(|entry| entry.alias() == step.alias);
            let matching_interaction = manifest
                .interactions()
                .iter()
                .any(|entry| entry.interaction_id() == &step.interaction_id);
            let issue = if let Some(entry) = bound {
                if entry.interaction_id() != &step.interaction_id {
                    Some((
                        PreflightIssueReason::AliasMismatch,
                        "alias is bound to a different interaction".to_owned(),
                    ))
                } else if expected_program.is_some_and(|program| {
                    match (
                        program.interaction(&step.interaction_id),
                        manifest.actual_program().interaction(&step.interaction_id),
                    ) {
                        (Some(expected), Some(actual)) => {
                            !contract_compatibility(expected.contract(), actual.contract())
                                .is_compatible()
                                || entry.expected_contract_digest() != expected.contract_digest()
                        }
                        _ => true,
                    }
                }) {
                    let reason = if expected_program
                        .is_some_and(|program| program.interaction(&step.interaction_id).is_none())
                        || manifest
                            .actual_program()
                            .interaction(&step.interaction_id)
                            .is_none()
                    {
                        PreflightIssueReason::MissingInteraction
                    } else {
                        PreflightIssueReason::ContractMismatch
                    };
                    Some((
                        reason,
                        "bound contract is incompatible with expected Program".to_owned(),
                    ))
                } else {
                    None
                }
            } else if matching_alias {
                Some((
                    PreflightIssueReason::ModeNotBound,
                    "requested alias and interaction mode are not bound".to_owned(),
                ))
            } else if matching_interaction {
                Some((
                    PreflightIssueReason::AliasMismatch,
                    "interaction is bound under a different alias".to_owned(),
                ))
            } else {
                Some((
                    PreflightIssueReason::MissingInteraction,
                    "interaction is absent from binding".to_owned(),
                ))
            };
            if let Some((reason, message)) = issue {
                issues.push(PreflightIssue {
                    step_id: step.id.clone(),
                    alias: step.alias.clone(),
                    interaction_id: step.interaction_id.clone(),
                    reason,
                    message,
                });
            }
        }
        PreflightReport {
            plan_digest: self.plan_digest().clone(),
            binding_digest: manifest.binding_digest().clone(),
            issues,
        }
    }

    /// Checks every plan step against a live binding and its durable manifest.
    #[must_use]
    pub fn preflight<C: Sync + ?Sized, A>(
        &self,
        binding: &Binding<C, A>,
        expected_program: Option<&Program>,
    ) -> PreflightReport {
        let mut report = self.preflight_manifest(binding.manifest(), expected_program);
        if binding.is_revoked() {
            let mut revoked_issues = self
                .steps()
                .iter()
                .map(|step| PreflightIssue {
                    step_id: step.id.clone(),
                    alias: step.alias.clone(),
                    interaction_id: step.interaction_id.clone(),
                    reason: PreflightIssueReason::BindingRevoked,
                    message: "binding or its pinned installation has been revoked".to_owned(),
                })
                .collect::<Vec<_>>();
            revoked_issues.extend(report.issues);
            report.issues = revoked_issues;
        }
        report
    }
}
