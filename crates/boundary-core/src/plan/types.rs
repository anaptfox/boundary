//! Serializable Plan value types and their wire validation.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::PlanError;
use crate::{InteractionId, lifecycle::InteractionMode};

/// Validated SHA-256 identity of a plan.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PlanDigest(String);

impl PlanDigest {
    /// Parses a lowercase `sha256:<64 hex digits>` digest.
    ///
    /// # Errors
    ///
    /// Returns [`PlanError::InvalidDigest`] when the digest is malformed.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, PlanError> {
        let value = value.as_ref();
        if value.len() != 71
            || !value.starts_with("sha256:")
            || !value.as_bytes()[7..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Err(PlanError::InvalidDigest);
        }
        Ok(Self(value.to_owned()))
    }

    pub(super) fn from_hash(bytes: [u8; 32]) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut value = String::from("sha256:");
        for byte in bytes {
            value.push(char::from(HEX[usize::from(byte >> 4)]));
            value.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        Self(value)
    }

    /// Returns the encoded digest.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PlanDigest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// One explicit source for a named step input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PlanInputBinding {
    /// Supplies a JSON value directly.
    Literal {
        /// Literal JSON value.
        value: Value,
    },
    /// Reads a dot-separated path from plan-level input.
    PlanInput {
        /// Dot-separated path.
        path: String,
    },
    /// Reads a prior step's result, optionally at a dot-separated path.
    StepOutput {
        /// Identifier of the source step.
        step_id: String,
        /// Optional dot-separated output path.
        path: Option<String>,
    },
}

/// One symbolic interaction invocation in a plan.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    /// Unique stable identifier within this plan.
    pub id: String,
    /// Caller-facing projection alias.
    pub alias: String,
    /// Interaction selected by this step.
    pub interaction_id: InteractionId,
    /// Capability mode required by this step.
    pub mode: InteractionMode,
    /// Explicit named data wiring.
    #[serde(default)]
    pub inputs: BTreeMap<String, PlanInputBinding>,
    /// Additional ordering dependencies, normalized on plan construction.
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// A validated immutable plan artifact.
#[allow(clippy::struct_field_names)]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub(super) version: u8,
    pub(super) id: String,
    pub(super) steps: Vec<PlanStep>,
    pub(super) plan_digest: PlanDigest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPlan {
    version: u8,
    id: String,
    steps: Vec<PlanStep>,
    plan_digest: PlanDigest,
}

impl<'de> Deserialize<'de> for Plan {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawPlan::deserialize(deserializer)?;
        let plan = Self::build(raw.id, raw.steps).map_err(serde::de::Error::custom)?;
        if raw.version != 1 || raw.plan_digest != plan.plan_digest {
            return Err(serde::de::Error::custom("plan version or digest mismatch"));
        }
        Ok(plan)
    }
}
