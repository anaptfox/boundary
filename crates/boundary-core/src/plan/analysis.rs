//! Deterministic plan analysis over handler-free Program contracts.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Plan, PlanError};
use crate::{
    InteractionId, Program, ProgramBuilder, canonical_json,
    lifecycle::{Projection, ProjectionModes},
};

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Union of resource reads and changes declared by a plan's interactions.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlanFootprints {
    /// Sorted, deduplicated resource reads.
    pub reads: Vec<String>,
    /// Sorted, deduplicated resource changes.
    pub changes: Vec<String>,
}

/// One alias and interaction required by a plan's projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanProjectionRequirement {
    /// Caller-facing projection alias.
    pub alias: String,
    /// Selected interaction.
    pub interaction_id: InteractionId,
    /// Union of requested realization modes.
    pub modes: ProjectionModes,
}

impl Plan {
    /// Combines the declared read and change footprints of all plan steps.
    ///
    /// # Errors
    ///
    /// Returns [`PlanError::MissingInteraction`] when a step is absent from the Program.
    pub fn aggregate_footprints(&self, program: &Program) -> Result<PlanFootprints, PlanError> {
        let mut reads = BTreeSet::new();
        let mut changes = BTreeSet::new();
        for step in self.steps() {
            let descriptor = program
                .interaction(&step.interaction_id)
                .ok_or_else(|| PlanError::MissingInteraction(step.interaction_id.clone()))?;
            reads.extend(descriptor.contract().reads().iter().cloned());
            changes.extend(descriptor.contract().changes().iter().cloned());
        }
        Ok(PlanFootprints {
            reads: reads.into_iter().collect(),
            changes: changes.into_iter().collect(),
        })
    }

    /// Partitions steps into deterministic waves respecting dependencies and write hazards.
    ///
    /// # Errors
    ///
    /// Returns [`PlanError::MissingInteraction`] when a step is absent from the Program.
    pub fn parallel_waves(&self, program: &Program) -> Result<Vec<Vec<String>>, PlanError> {
        let mut footprints = BTreeMap::new();
        for step in self.steps() {
            let descriptor = program
                .interaction(&step.interaction_id)
                .ok_or_else(|| PlanError::MissingInteraction(step.interaction_id.clone()))?;
            footprints.insert(
                step.id.as_str(),
                (
                    descriptor
                        .contract()
                        .reads()
                        .iter()
                        .collect::<BTreeSet<_>>(),
                    descriptor
                        .contract()
                        .changes()
                        .iter()
                        .collect::<BTreeSet<_>>(),
                ),
            );
        }
        let dependencies: BTreeMap<_, BTreeSet<_>> = self
            .steps()
            .iter()
            .map(|step| {
                let mut deps: BTreeSet<&str> = step.depends_on.iter().map(String::as_str).collect();
                for binding in step.inputs.values() {
                    if let super::PlanInputBinding::StepOutput { step_id, .. } = binding {
                        deps.insert(step_id);
                    }
                }
                (step.id.as_str(), deps)
            })
            .collect();
        let mut done = BTreeSet::new();
        let mut waves = Vec::new();
        while done.len() < self.steps().len() {
            let mut wave: Vec<&str> = Vec::new();
            for step in self.steps() {
                if done.contains(step.id.as_str())
                    || !dependencies[step.id.as_str()]
                        .iter()
                        .all(|dep| done.contains(dep))
                {
                    continue;
                }
                let (reads, writes) = &footprints[step.id.as_str()];
                let safe = wave.iter().all(|other| {
                    let (other_reads, other_writes) = &footprints[other];
                    writes.is_disjoint(other_reads)
                        && writes.is_disjoint(other_writes)
                        && other_writes.is_disjoint(reads)
                });
                if safe {
                    wave.push(step.id.as_str());
                }
            }
            if wave.is_empty() {
                return Err(PlanError::CycleDetected);
            }
            done.extend(wave.iter().copied());
            waves.push(wave.into_iter().map(str::to_owned).collect());
        }
        Ok(waves)
    }

    /// Returns unique alias/interaction projection requirements, merging step modes.
    ///
    /// # Errors
    ///
    /// Returns [`PlanError::MissingInteraction`] when a step is absent from the Program.
    pub fn required_projection_selections(
        &self,
        program: &Program,
    ) -> Result<Vec<PlanProjectionRequirement>, PlanError> {
        for step in self.steps() {
            if program.interaction(&step.interaction_id).is_none() {
                return Err(PlanError::MissingInteraction(step.interaction_id.clone()));
            }
        }
        let mut values = BTreeMap::<(&str, &InteractionId), (bool, bool)>::new();
        for step in self.steps() {
            let modes = values
                .entry((&step.alias, &step.interaction_id))
                .or_default();
            match step.mode {
                crate::lifecycle::InteractionMode::Direct => modes.0 = true,
                crate::lifecycle::InteractionMode::Request => modes.1 = true,
            }
        }
        Ok(values
            .into_iter()
            .map(
                |((alias, interaction_id), (direct, request))| PlanProjectionRequirement {
                    alias: alias.to_owned(),
                    interaction_id: interaction_id.clone(),
                    modes: match (direct, request) {
                        (true, true) => ProjectionModes::DirectAndRequest,
                        (true | false, false) => ProjectionModes::Direct,
                        (false, true) => ProjectionModes::Request,
                    },
                },
            )
            .collect())
    }

    /// Constructs a validated minimal projection manifest from the plan and Program.
    ///
    /// Arity is inferred as zero for steps with no named inputs and one otherwise,
    /// because Program descriptors intentionally do not encode native call arity.
    ///
    /// # Errors
    ///
    /// Returns [`PlanError`] when a step is absent from the Program or lifecycle
    /// validation rejects the constructed projection.
    pub fn required_projection(&self, program: &Program) -> Result<Projection, PlanError> {
        let requirements = self.required_projection_selections(program)?;
        let mut program_builder = ProgramBuilder::default();
        for requirement in &requirements {
            let descriptor = program
                .interaction(&requirement.interaction_id)
                .ok_or_else(|| PlanError::MissingInteraction(requirement.interaction_id.clone()))?;
            program_builder = program_builder.descriptor(descriptor.clone())?;
        }
        let selected_program = program_builder.finish()?;
        let mut interactions = Vec::new();
        for requirement in requirements {
            let descriptor = program
                .interaction(&requirement.interaction_id)
                .ok_or_else(|| PlanError::MissingInteraction(requirement.interaction_id.clone()))?;
            // A projection is one alias per interaction; lifecycle validation rejects duplicates.
            let arity = u8::from(self.steps().iter().any(|step| {
                step.alias == requirement.alias
                    && step.interaction_id == requirement.interaction_id
                    && !step.inputs.is_empty()
            }));
            let mode_names: Vec<&str> = match requirement.modes {
                ProjectionModes::Direct => vec!["direct"],
                ProjectionModes::Request => vec!["request"],
                ProjectionModes::DirectAndRequest => vec!["direct", "request"],
            };
            interactions.push(serde_json::json!({
                "alias": requirement.alias, "interactionId": requirement.interaction_id,
                "expectedContractDigest": descriptor.contract_digest(), "inputArity": arity, "modes": mode_names
            }));
        }
        let identity_interactions: Vec<Value> = interactions.iter().map(|item| {
            let modes = item["modes"].as_array().map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
            let mode = if modes.len() == 2 { "direct-and-request" } else { modes.first().copied().unwrap_or("direct") };
            serde_json::json!({"alias":item["alias"],"interaction":item["interactionId"],"contract":item["expectedContractDigest"],"arity":if item["inputArity"]==0 {"zero"} else {"one"},"modes":mode})
        }).collect();
        let identity = serde_json::json!({"program":selected_program.digest(),"interactions":identity_interactions});
        let canonical = canonical_json(&identity)?;
        let mut hasher = Sha256::new();
        hasher.update(b"boundary.projection/v1");
        hasher.update([0]);
        hasher.update(canonical.as_bytes());
        let bytes: [u8; 32] = hasher.finalize().into();
        let mut digest = String::from("sha256:");
        for byte in bytes {
            digest.push(char::from(HEX[usize::from(byte >> 4)]));
            digest.push(char::from(HEX[usize::from(byte & 15)]));
        }
        let program_value = serde_json::to_value(selected_program)
            .map_err(|error| PlanError::Projection(error.to_string()))?;
        // Keep the validated Program serialization as the closed desired Program.
        if !program_value.is_object() {
            return Err(PlanError::Projection(
                "Program did not serialize as an object".to_owned(),
            ));
        }
        let manifest = serde_json::json!({"version":1,"projectionDigest":digest,"program":program_value,"interactions":interactions});
        serde_json::from_value(manifest).map_err(|error| PlanError::Projection(error.to_string()))
    }
}
