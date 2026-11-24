//! Static, handler-free DAGs of symbolic interactions.
//!
//! A plan records identity, data wiring, and ordering. It does not execute
//! interactions or provide a workflow runtime.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{InteractionId, ProgramError, canonical_json};

mod analysis;
mod preflight;
mod types;
pub use analysis::{PlanFootprints, PlanProjectionRequirement};
pub use preflight::{PreflightIssue, PreflightIssueReason, PreflightReport};
pub use types::{Plan, PlanDigest, PlanInputBinding, PlanStep};

const PLAN_DOMAIN: &str = "boundary.plan/v1";

/// Plan construction and analysis failures.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum PlanError {
    /// A supplied plan digest is malformed.
    #[error("invalid plan digest")]
    InvalidDigest,
    /// Plan or step identifiers are malformed.
    #[error("invalid plan or step identifier `{0}`")]
    InvalidIdentifier(String),
    /// A step identifier occurs more than once.
    #[error("duplicate step id `{0}`")]
    DuplicateStep(String),
    /// A dependency points to no plan step.
    #[error("unknown dependency `{0}`")]
    UnknownDependency(String),
    /// The dependency graph contains a cycle.
    #[error("plan dependency graph contains a cycle")]
    CycleDetected,
    /// One alias names different interactions.
    #[error("alias `{0}` maps to multiple interactions")]
    ConflictingAlias(String),
    /// The requested interaction does not appear in the Program.
    #[error("interaction `{0}` is absent from the Program")]
    MissingInteraction(InteractionId),
    /// A plan cannot contain zero steps.
    #[error("plan must contain at least one step")]
    Empty,
    /// A plan artifact cannot be encoded or hashed.
    #[error(transparent)]
    Program(#[from] ProgramError),
    /// The required projection manifest failed lifecycle validation.
    #[error("could not construct required projection: {0}")]
    Projection(String),
}

/// Ergonomic builder for validated plans.
#[derive(Default)]
pub struct PlanBuilder {
    id: Option<String>,
    steps: Vec<PlanStep>,
}

impl PlanBuilder {
    /// Creates an empty builder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    /// Sets the stable plan identifier.
    #[must_use]
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
    /// Adds one step.
    #[must_use]
    pub fn step(mut self, step: PlanStep) -> Self {
        self.steps.push(step);
        self
    }
    /// Adds multiple steps.
    #[must_use]
    pub fn steps(mut self, steps: impl IntoIterator<Item = PlanStep>) -> Self {
        self.steps.extend(steps);
        self
    }
    /// Validates and finishes the plan.
    ///
    /// # Errors
    ///
    /// Returns [`PlanError`] when the plan is invalid or cannot be hashed.
    pub fn finish(self) -> Result<Plan, PlanError> {
        Plan::build(self.id.unwrap_or_default(), self.steps)
    }
}

impl Plan {
    pub(super) fn build(id: String, mut steps: Vec<PlanStep>) -> Result<Self, PlanError> {
        if !valid_identifier(&id) {
            return Err(PlanError::InvalidIdentifier(id));
        }
        if steps.is_empty() {
            return Err(PlanError::Empty);
        }
        for step in &mut steps {
            if !valid_identifier(&step.id) || !valid_identifier(&step.alias) {
                return Err(PlanError::InvalidIdentifier(step.id.clone()));
            }
            step.depends_on.sort();
            step.depends_on.dedup();
        }
        steps.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: BTreeSet<_> = steps.iter().map(|step| step.id.as_str()).collect();
        if ids.len() != steps.len() {
            let mut seen = BTreeSet::new();
            let duplicate = steps
                .iter()
                .find(|step| !seen.insert(step.id.as_str()))
                .map_or("?", |step| step.id.as_str());
            return Err(PlanError::DuplicateStep(duplicate.to_owned()));
        }
        let mut aliases = BTreeMap::<&str, &InteractionId>::new();
        let mut deps = BTreeMap::<&str, BTreeSet<&str>>::new();
        for step in &steps {
            if aliases
                .get(step.alias.as_str())
                .is_some_and(|id| *id != &step.interaction_id)
            {
                return Err(PlanError::ConflictingAlias(step.alias.clone()));
            }
            aliases.insert(&step.alias, &step.interaction_id);
            let mut dependencies: BTreeSet<&str> =
                step.depends_on.iter().map(String::as_str).collect();
            for binding in step.inputs.values() {
                if let PlanInputBinding::StepOutput { step_id, .. } = binding {
                    dependencies.insert(step_id);
                }
            }
            for dependency in &dependencies {
                if !ids.contains(dependency) {
                    return Err(PlanError::UnknownDependency((*dependency).to_owned()));
                }
                if *dependency == step.id {
                    return Err(PlanError::CycleDetected);
                }
            }
            deps.insert(&step.id, dependencies);
        }
        let mut complete = BTreeSet::new();
        while complete.len() < steps.len() {
            let next: Vec<_> = steps
                .iter()
                .filter(|step| {
                    !complete.contains(step.id.as_str())
                        && deps[step.id.as_str()]
                            .iter()
                            .all(|dep| complete.contains(dep))
                })
                .map(|step| step.id.as_str())
                .collect();
            if next.is_empty() {
                return Err(PlanError::CycleDetected);
            }
            complete.extend(next);
        }
        let plan_digest = digest(&id, &steps)?;
        Ok(Self {
            version: 1,
            id,
            steps,
            plan_digest,
        })
    }

    /// Returns the stable plan identifier.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }
    /// Returns steps in deterministic identifier order.
    #[must_use]
    pub fn steps(&self) -> &[PlanStep] {
        &self.steps
    }
    /// Returns the validated plan digest.
    #[must_use]
    pub const fn plan_digest(&self) -> &PlanDigest {
        &self.plan_digest
    }
}

fn digest(id: &str, steps: &[PlanStep]) -> Result<PlanDigest, PlanError> {
    let mut value = serde_json::json!({"version":1,"id":id,"steps":steps});
    // TypeScript emits its optional path only when present; serde encodes None
    // as null by default, so remove that absent value before hashing.
    if let Some(steps) = value
        .get_mut("steps")
        .and_then(serde_json::Value::as_array_mut)
    {
        for step in steps {
            if let Some(inputs) = step
                .get_mut("inputs")
                .and_then(serde_json::Value::as_object_mut)
            {
                for binding in inputs.values_mut() {
                    if binding.get("kind").and_then(serde_json::Value::as_str)
                        == Some("step-output")
                        && let Some(binding) = binding.as_object_mut()
                        && binding.get("path").is_some_and(serde_json::Value::is_null)
                    {
                        binding.remove("path");
                    }
                }
            }
        }
    }
    let canonical = canonical_json(&value)?;
    let mut hasher = Sha256::new();
    hasher.update(PLAN_DOMAIN.as_bytes());
    hasher.update([0]);
    hasher.update(canonical.as_bytes());
    Ok(PlanDigest::from_hash(hasher.finalize().into()))
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}
