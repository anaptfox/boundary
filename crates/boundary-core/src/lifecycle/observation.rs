use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

use super::{BindingDigest, InstallationDigest, InstallationId, ProjectionDigest, RealizationId};
use crate::{ContractDigest, InteractionId, canonical_json};

/// Validated invocation evidence; neither authority nor a retry instruction.
/// Hosts choose a delivery channel and explicitly redact correlation data.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct InvocationObservation(Value);

/// Malformed observation fields or contradictory completion evidence.
#[derive(Debug, Error)]
#[error("invalid invocation observation: {0}")]
pub struct ObservationError(String);

impl InvocationObservation {
    /// Validates a portable observation without authenticating its publisher.
    ///
    /// # Errors
    /// Returns an error for unknown fields, malformed identities or invalid outcomes.
    pub fn from_value(value: Value) -> Result<Self, ObservationError> {
        let invalid = || ObservationError("invalid fields or outcome".to_owned());
        canonical_json(&value).map_err(|error| ObservationError(error.to_string()))?;
        let object = value.as_object().ok_or_else(invalid)?;
        let required = [
            "version",
            "bindingDigest",
            "projectionDigest",
            "installationId",
            "installationDigest",
            "interactionId",
            "expectedContractDigest",
            "actualContractDigest",
            "mode",
            "realizationId",
            "certainty",
            "resultKind",
            "reads",
            "changes",
        ];
        if required.iter().any(|key| !object.contains_key(*key))
            || object
                .keys()
                .any(|key| !required.contains(&key.as_str()) && key != "correlation")
        {
            return Err(invalid());
        }
        let text = |key: &str| value[key].as_str().ok_or_else(invalid);
        BindingDigest::parse(text("bindingDigest")?).map_err(|_| invalid())?;
        ProjectionDigest::parse(text("projectionDigest")?).map_err(|_| invalid())?;
        InstallationDigest::parse(text("installationDigest")?).map_err(|_| invalid())?;
        ContractDigest::parse(text("expectedContractDigest")?).map_err(|_| invalid())?;
        ContractDigest::parse(text("actualContractDigest")?).map_err(|_| invalid())?;
        InstallationId::new(text("installationId")?).map_err(|_| invalid())?;
        RealizationId::new(text("realizationId")?).map_err(|_| invalid())?;
        InteractionId::parse(text("interactionId")?).map_err(|_| invalid())?;
        for key in ["reads", "changes"] {
            let resources = value[key].as_array().ok_or_else(invalid)?;
            if resources
                .iter()
                .any(|resource| resource.as_str().is_none_or(str::is_empty))
            {
                return Err(invalid());
            }
        }
        let mode = text("mode")?;
        let certainty = text("certainty")?;
        let legal = match text("resultKind")? {
            "fault" => ["not-started", "not-completed", "unknown"].contains(&certainty),
            "proposed" => mode == "request" && certainty == "not-started",
            "denied" => certainty == "not-started",
            "returned" | "declared-error" => mode == "direct" && certainty == "completed",
            _ => false,
        };
        if value["version"] != 1 || !["direct", "request"].contains(&mode) || !legal {
            return Err(invalid());
        }
        Ok(Self(value))
    }

    /// Returns immutable evidence with no input, output, or implicit context.
    #[must_use]
    pub const fn as_value(&self) -> &Value {
        &self.0
    }
}

impl<'de> Deserialize<'de> for InvocationObservation {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_value(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
