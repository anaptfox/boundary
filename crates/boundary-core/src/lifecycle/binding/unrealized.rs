use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};

use super::super::{InstallationId, InteractionMode, ProjectionManifest};
use crate::InteractionId;

/// Stable reason one desired projection selection could not be realized.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnrealizedReason {
    /// The parent binding or one of its ancestors has been revoked.
    BindingRevoked,
    /// The parent binding did not select this interaction.
    InteractionNotSelected,
    /// The child changed its parent's exact expected contract.
    ContractNotSelected,
    /// The child changed its parent's exact input arity.
    ArityNotSelected,
    /// The parent binding did not select this execution mode.
    ModeNotSelected,
    /// The installation does not realize the selected interaction.
    MissingInteraction,
    /// The installed interaction contract is not compatible.
    IncompatibleContract,
    /// The installed interaction uses a different dynamic input arity.
    IncompatibleArity,
    /// Direct execution is not realized.
    MissingDirect,
    /// Request creation is not realized.
    MissingRequest,
    /// Request execution lacks exact portable control identity.
    MismatchedRequestIdentity,
    /// The host already revoked this installation.
    InstallationRevoked,
    /// Rust-only, nonportable diagnostic: a validated lifecycle artifact
    /// invariant failed inside binding. Rust reports serialize this defensive
    /// category, but shared conformance does not claim it.
    InvalidLifecycleArtifact,
}

/// One deterministic failure in an atomic binding attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnrealizedIssue {
    alias: String,
    interaction_id: InteractionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<InteractionMode>,
    reason: UnrealizedReason,
    message: String,
}

impl UnrealizedIssue {
    pub(super) fn new(
        alias: String,
        interaction_id: InteractionId,
        mode: Option<InteractionMode>,
        reason: UnrealizedReason,
        message: impl Into<String>,
    ) -> Self {
        Self {
            alias,
            interaction_id,
            mode,
            reason,
            message: message.into(),
        }
    }

    /// Returns the caller-facing alias that remains unrealized.
    #[must_use]
    pub fn alias(&self) -> &str {
        &self.alias
    }

    /// Returns the selected interaction identity.
    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    /// Returns the affected execution mode when the failure is mode-specific.
    #[must_use]
    pub const fn mode(&self) -> Option<InteractionMode> {
        self.mode
    }

    /// Returns the stable failure category.
    #[must_use]
    pub const fn reason(&self) -> UnrealizedReason {
        self.reason
    }

    /// Returns a diagnostic message excluded from identity.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    fn validate(&self) -> Result<(), String> {
        if !super::super::projection::valid_alias(&self.alias) {
            return Err("unrealized issue contains an invalid alias".to_owned());
        }
        let expected_mode = match self.reason {
            UnrealizedReason::ModeNotSelected => self.mode,
            UnrealizedReason::MissingDirect => Some(InteractionMode::Direct),
            UnrealizedReason::MissingRequest | UnrealizedReason::MismatchedRequestIdentity => {
                Some(InteractionMode::Request)
            }
            UnrealizedReason::MissingInteraction
            | UnrealizedReason::IncompatibleContract
            | UnrealizedReason::IncompatibleArity
            | UnrealizedReason::InstallationRevoked
            | UnrealizedReason::BindingRevoked
            | UnrealizedReason::InteractionNotSelected
            | UnrealizedReason::ContractNotSelected
            | UnrealizedReason::ArityNotSelected
            | UnrealizedReason::InvalidLifecycleArtifact => None,
        };
        if self.reason == UnrealizedReason::ModeNotSelected && self.mode.is_none() {
            return Err("a mode-not-selected issue must identify its mode".to_owned());
        }
        if self.mode != expected_mode {
            return Err("unrealized issue mode does not match its reason".to_owned());
        }
        if self.message.is_empty() {
            return Err("unrealized issue message must not be empty".to_owned());
        }
        Ok(())
    }
}

/// Data-only failed atomic binding result. No callable surface exists.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealizedReport {
    projection: ProjectionManifest,
    installation_id: InstallationId,
    issues: Vec<UnrealizedIssue>,
}

impl UnrealizedReport {
    pub(super) fn new(
        projection: ProjectionManifest,
        installation_id: InstallationId,
        issues: Vec<UnrealizedIssue>,
    ) -> Self {
        Self {
            projection,
            installation_id,
            issues,
        }
    }

    /// Returns the durable desired projection that remains unrealized.
    #[must_use]
    pub const fn projection(&self) -> &ProjectionManifest {
        &self.projection
    }

    /// Returns the attempted host-issued installation identity.
    #[must_use]
    pub const fn installation_id(&self) -> &InstallationId {
        &self.installation_id
    }

    /// Returns deterministic failures in projection selection order.
    #[must_use]
    pub fn issues(&self) -> &[UnrealizedIssue] {
        &self.issues
    }

    fn validate(self) -> Result<Self, String> {
        if self.issues.is_empty() && !self.projection.interactions().is_empty() {
            return Err("unrealized report must contain at least one issue".to_owned());
        }
        let mut unique = BTreeSet::new();
        for issue in &self.issues {
            issue.validate()?;
            if !unique.insert((issue.alias.clone(), issue.mode, issue.reason)) {
                return Err("unrealized report contains a duplicate issue".to_owned());
            }
            let selected = self
                .projection
                .interactions()
                .iter()
                .find(|interaction| interaction.alias() == issue.alias())
                .ok_or_else(|| "unrealized issue alias is absent from Projection".to_owned())?;
            if selected.interaction_id() != issue.interaction_id() {
                return Err("unrealized issue interaction does not match its alias".to_owned());
            }
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawUnrealizedReport {
    projection: ProjectionManifest,
    installation_id: InstallationId,
    issues: Vec<UnrealizedIssue>,
}

impl<'de> Deserialize<'de> for UnrealizedReport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawUnrealizedReport::deserialize(deserializer)?;
        Self {
            projection: raw.projection,
            installation_id: raw.installation_id,
            issues: raw.issues,
        }
        .validate()
        .map_err(serde::de::Error::custom)
    }
}
