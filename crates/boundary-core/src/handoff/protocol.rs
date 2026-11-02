use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{ContractDigest, InteractionId};

use crate::lifecycle::{
    BindingDigest, BindingManifest, BoundInteraction, InstallationId, InteractionMode,
    InvocationCertainty, RealizationId,
};

mod validation;

pub(crate) use validation::{
    input_is_valid, validate_invocation, validate_outcome, validate_response,
};
use validation::{manifest_interaction, validate_result};

/// Stable public diagnostic category for rejected Handoff data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum HandoffDiagnosticCode {
    /// The wire shape or certainty/result law is invalid.
    InvalidEnvelope,
    /// The invocation or outcome names another Binding.
    StaleBinding,
    /// The invocation or outcome names another Installation.
    StaleInstallation,
    /// The interaction is absent from the pinned Binding.
    InteractionNotExposed,
    /// The requested mode is absent from the pinned Binding.
    ModeNotExposed,
    /// Expected or actual contract identity drifted.
    StaleContract,
    /// The exact realization identity drifted.
    StaleRealization,
    /// Returned portable data violates a pinned contract.
    InvalidOutcome,
}

/// Sanitized failure from validating untrusted Handoff data.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("Handoff data rejected at {path}: {message}")]
pub struct HandoffError {
    code: HandoffDiagnosticCode,
    path: &'static str,
    message: &'static str,
}

impl HandoffError {
    /// Returns the stable diagnostic category.
    #[must_use]
    pub const fn code(&self) -> HandoffDiagnosticCode {
        self.code
    }

    /// Returns the stable public path to the rejected field.
    #[must_use]
    pub const fn path(&self) -> &'static str {
        self.path
    }
}

/// Stable sanitized fault cause carried by a version 1 outcome.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum HandoffFaultCause {
    /// Portable input was invalid before execution.
    InvalidInput,
    /// The live Binding or Installation was revoked.
    Revoked,
    /// Admission could not produce a trusted decision.
    AdmissionFailed,
    /// Request creation failed without applying the interaction.
    RequestFailed,
    /// A realization returned data outside its contract.
    InvalidRealizationOutcome,
    /// A realization failed without exposing its implementation details.
    RealizationFailed,
    /// Invocation data was invalid.
    InvalidInvocation,
}

/// Portable, non-secret evidence for an invalid input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffValidationIssue {
    path: String,
    message: String,
}

impl HandoffValidationIssue {
    pub(super) fn invalid_input() -> Self {
        Self {
            path: "invocation.input".to_owned(),
            message: "input does not match both pinned contracts".to_owned(),
        }
    }

    /// Returns the portable validation path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Returns the portable validation message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    fn is_valid(&self) -> bool {
        !self.path.trim().is_empty() && !self.message.trim().is_empty()
    }
}

/// Exhaustive portable version 1 result.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[non_exhaustive]
pub enum HandoffResult {
    /// Direct execution returned declared output.
    Returned {
        /// Portable value satisfying both pinned output contracts.
        value: Value,
    },
    /// Direct execution returned a declared portable error.
    DeclaredError {
        /// Stable definition-owned error code.
        code: String,
        /// Native error details; the complete `{ code, details }` value must
        /// satisfy both pinned error contracts.
        details: Value,
    },
    /// Request mode created public proposal data without applying the interaction.
    Proposed {
        /// Public proposal satisfying the pinned request preview schema.
        proposal: Value,
    },
    /// Admission or request policy denied before the interaction began.
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
    /// A sanitized lifecycle or realization failure.
    Fault {
        /// Stable sanitized fault cause.
        cause: HandoffFaultCause,
        /// Optional portable evidence, valid only for invalid input.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        issues: Vec<HandoffValidationIssue>,
    },
}

/// Exact, owned version 1 invocation envelope.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffInvocation {
    version: u8,
    binding_digest: BindingDigest,
    installation_id: InstallationId,
    interaction_id: InteractionId,
    expected_contract_digest: ContractDigest,
    actual_contract_digest: ContractDigest,
    mode: InteractionMode,
    realization_id: RealizationId,
    input: Value,
}

impl HandoffInvocation {
    /// Creates an invocation from one exact Binding manifest entry.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] unless the interaction and mode are exposed.
    pub fn new(
        manifest: &BindingManifest,
        interaction_id: &InteractionId,
        mode: InteractionMode,
        input: Value,
    ) -> Result<Self, HandoffError> {
        let interaction = manifest_interaction(manifest, interaction_id, mode)?;
        Ok(Self::from_interaction(manifest, interaction, input))
    }

    pub(super) fn from_interaction(
        manifest: &BindingManifest,
        interaction: &BoundInteraction,
        input: Value,
    ) -> Self {
        Self {
            version: 1,
            binding_digest: manifest.binding_digest().clone(),
            installation_id: manifest.installation_id().clone(),
            interaction_id: interaction.interaction_id().clone(),
            expected_contract_digest: interaction.expected_contract_digest().clone(),
            actual_contract_digest: interaction.actual_contract_digest().clone(),
            mode: interaction.mode(),
            realization_id: interaction.realization_id().clone(),
            input,
        }
    }

    /// Returns portable input owned by this invocation.
    #[must_use]
    pub const fn input(&self) -> &Value {
        &self.input
    }

    /// Returns the selected interaction identifier.
    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    /// Returns the selected mode.
    #[must_use]
    pub const fn mode(&self) -> InteractionMode {
        self.mode
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawInvocation {
    version: u8,
    binding_digest: BindingDigest,
    installation_id: InstallationId,
    interaction_id: InteractionId,
    expected_contract_digest: ContractDigest,
    actual_contract_digest: ContractDigest,
    mode: InteractionMode,
    realization_id: RealizationId,
    input: Value,
}

impl<'de> Deserialize<'de> for HandoffInvocation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawInvocation::deserialize(deserializer)?;
        if raw.version != 1 {
            return Err(serde::de::Error::custom(
                "only Handoff protocol version 1 is accepted",
            ));
        }
        Ok(Self {
            version: raw.version,
            binding_digest: raw.binding_digest,
            installation_id: raw.installation_id,
            interaction_id: raw.interaction_id,
            expected_contract_digest: raw.expected_contract_digest,
            actual_contract_digest: raw.actual_contract_digest,
            mode: raw.mode,
            realization_id: raw.realization_id,
            input: raw.input,
        })
    }
}

/// Exact, owned version 1 outcome envelope.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffOutcome {
    version: u8,
    binding_digest: BindingDigest,
    installation_id: InstallationId,
    interaction_id: InteractionId,
    expected_contract_digest: ContractDigest,
    actual_contract_digest: ContractDigest,
    mode: InteractionMode,
    realization_id: RealizationId,
    certainty: InvocationCertainty,
    result: HandoffResult,
}

impl HandoffOutcome {
    pub(crate) fn new(
        invocation: &HandoffInvocation,
        certainty: InvocationCertainty,
        result: HandoffResult,
    ) -> Result<Self, HandoffError> {
        validate_result(invocation.mode, certainty, &result)?;
        Ok(Self {
            version: 1,
            binding_digest: invocation.binding_digest.clone(),
            installation_id: invocation.installation_id.clone(),
            interaction_id: invocation.interaction_id.clone(),
            expected_contract_digest: invocation.expected_contract_digest.clone(),
            actual_contract_digest: invocation.actual_contract_digest.clone(),
            mode: invocation.mode,
            realization_id: invocation.realization_id.clone(),
            certainty,
            result,
        })
    }

    /// Returns the execution certainty carried by this outcome.
    #[must_use]
    pub const fn certainty(&self) -> InvocationCertainty {
        self.certainty
    }

    /// Returns the exhaustive portable result.
    #[must_use]
    pub const fn result(&self) -> &HandoffResult {
        &self.result
    }

    pub(crate) fn into_result(self) -> HandoffResult {
        self.result
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawOutcome {
    version: u8,
    binding_digest: BindingDigest,
    installation_id: InstallationId,
    interaction_id: InteractionId,
    expected_contract_digest: ContractDigest,
    actual_contract_digest: ContractDigest,
    mode: InteractionMode,
    realization_id: RealizationId,
    certainty: InvocationCertainty,
    result: HandoffResult,
}

impl<'de> Deserialize<'de> for HandoffOutcome {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawOutcome::deserialize(deserializer)?;
        if raw.version != 1 {
            return Err(serde::de::Error::custom(
                "only Handoff protocol version 1 is accepted",
            ));
        }
        validate_result(raw.mode, raw.certainty, &raw.result).map_err(serde::de::Error::custom)?;
        Ok(Self {
            version: raw.version,
            binding_digest: raw.binding_digest,
            installation_id: raw.installation_id,
            interaction_id: raw.interaction_id,
            expected_contract_digest: raw.expected_contract_digest,
            actual_contract_digest: raw.actual_contract_digest,
            mode: raw.mode,
            realization_id: raw.realization_id,
            certainty: raw.certainty,
            result: raw.result,
        })
    }
}
