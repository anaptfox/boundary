use std::collections::{BTreeMap, BTreeSet};

use super::{
    ProjectError, ProjectedInteraction, Projection, ProjectionManifest, ProjectionModes,
    artifact::projection_digest,
};
use crate::{InteractionDescriptor, InteractionId, Program, ProgramBuilder};

pub(crate) fn valid_alias(alias: &str) -> bool {
    let bytes = alias.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || matches!(bytes[0], b'_' | b'$'))
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
}

impl ProjectionModes {
    /// Returns the union of the realization modes in both sets.
    #[must_use]
    pub const fn union(self, other: Self) -> Self {
        match (self, other) {
            (Self::Direct, Self::Request)
            | (Self::Request, Self::Direct)
            | (Self::DirectAndRequest, _)
            | (_, Self::DirectAndRequest) => Self::DirectAndRequest,
            (Self::Direct, Self::Direct) => Self::Direct,
            (Self::Request, Self::Request) => Self::Request,
        }
    }

    /// Returns the intersection of the realization modes, if non-empty.
    #[must_use]
    pub const fn intersect(self, other: Self) -> Option<Self> {
        match (self, other) {
            (Self::DirectAndRequest, modes) | (modes, Self::DirectAndRequest) => Some(modes),
            (Self::Direct, Self::Direct) => Some(Self::Direct),
            (Self::Request, Self::Request) => Some(Self::Request),
            (Self::Direct, Self::Request) | (Self::Request, Self::Direct) => None,
        }
    }
}

/// Selects entries by alias or interaction id and rebuilds a closed projection.
impl Projection {
    /// Returns a projection containing only the requested aliases or interaction ids.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError::UnknownSelection`] for an unknown key and
    /// [`ProjectError::DuplicateSelection`] when a key or resolved alias repeats.
    pub fn pick(&self, keys: &[&str]) -> Result<Self, ProjectError> {
        let mut selected = BTreeSet::new();
        for key in keys {
            let entry = resolve(&self.manifest.interactions, key)
                .ok_or_else(|| ProjectError::UnknownSelection((*key).to_owned()))?;
            if !selected.insert(entry.alias.clone()) {
                return Err(ProjectError::DuplicateSelection((*key).to_owned()));
            }
        }
        let interactions = self
            .manifest
            .interactions
            .iter()
            .filter(|entry| selected.contains(&entry.alias))
            .cloned()
            .collect();
        rebuild_projection(interactions, descriptors_for(self, &selected)?)
    }

    /// Returns a projection with the requested aliases or interaction ids removed.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError::UnknownSelection`] for an unknown key and
    /// [`ProjectError::DuplicateSelection`] when a key or resolved alias repeats.
    pub fn omit(&self, keys: &[&str]) -> Result<Self, ProjectError> {
        let mut omitted = BTreeSet::new();
        for key in keys {
            let entry = resolve(&self.manifest.interactions, key)
                .ok_or_else(|| ProjectError::UnknownSelection((*key).to_owned()))?;
            if !omitted.insert(entry.alias.clone()) {
                return Err(ProjectError::DuplicateSelection((*key).to_owned()));
            }
        }
        let interactions = self
            .manifest
            .interactions
            .iter()
            .filter(|entry| !omitted.contains(&entry.alias))
            .cloned()
            .collect();
        let retained = self
            .manifest
            .interactions
            .iter()
            .filter(|entry| !omitted.contains(&entry.alias))
            .map(|entry| entry.alias.clone())
            .collect();
        rebuild_projection(interactions, descriptors_for(self, &retained)?)
    }

    /// Returns the union of two projections, merging mode sets for identical aliases.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError::ConflictingAlias`] for incompatible same-alias
    /// entries, [`ProjectError::DuplicateInteraction`] when an interaction is
    /// selected under different aliases, or a program construction error.
    pub fn union(&self, other: &Self) -> Result<Self, ProjectError> {
        let mut by_alias = BTreeMap::<String, ProjectedInteraction>::new();
        let mut descriptors = BTreeMap::new();
        let mut interaction_aliases = BTreeMap::<InteractionId, String>::new();
        for projection in [self, other] {
            for entry in &projection.manifest.interactions {
                if let Some(existing) = by_alias.get_mut(&entry.alias) {
                    if !same_identity(existing, entry) {
                        return Err(ProjectError::ConflictingAlias(entry.alias.clone()));
                    }
                    existing.modes = existing.modes.union(entry.modes);
                    continue;
                }
                if interaction_aliases.contains_key(&entry.interaction_id) {
                    let prior = descriptors.get(&entry.interaction_id);
                    if prior.is_some_and(|descriptor: &InteractionDescriptor| {
                        descriptor.contract_digest() != &entry.expected_contract_digest
                    }) {
                        return Err(ProjectError::ContractMismatch(entry.interaction_id.clone()));
                    }
                    return Err(ProjectError::DuplicateInteraction(
                        entry.interaction_id.clone(),
                    ));
                }
                interaction_aliases.insert(entry.interaction_id.clone(), entry.alias.clone());
                let descriptor = projection
                    .manifest
                    .program
                    .interaction(&entry.interaction_id)
                    .cloned()
                    .ok_or_else(|| ProjectError::ContractMismatch(entry.interaction_id.clone()))?;
                descriptors.insert(entry.interaction_id.clone(), descriptor);
                by_alias.insert(entry.alias.clone(), entry.clone());
            }
        }
        rebuild_projection(by_alias.into_values().collect(), descriptors)
    }

    /// Returns entries shared by alias, retaining only their shared modes.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError::ConflictingAlias`] when a shared alias identifies
    /// different interactions or contracts, or a program construction error.
    pub fn intersect(&self, other: &Self) -> Result<Self, ProjectError> {
        let right = other
            .manifest
            .interactions
            .iter()
            .map(|entry| (entry.alias.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        let mut intersections = Vec::new();
        let mut descriptors = BTreeMap::new();
        for left in &self.manifest.interactions {
            let Some(right_entry) = right.get(left.alias.as_str()) else {
                continue;
            };
            if !same_identity(left, right_entry) {
                return Err(ProjectError::ConflictingAlias(left.alias.clone()));
            }
            let Some(modes) = left.modes.intersect(right_entry.modes) else {
                continue;
            };
            let descriptor = self
                .manifest
                .program
                .interaction(&left.interaction_id)
                .cloned()
                .ok_or_else(|| ProjectError::ContractMismatch(left.interaction_id.clone()))?;
            descriptors.insert(left.interaction_id.clone(), descriptor);
            let mut selected = left.clone();
            selected.modes = modes;
            intersections.push(selected);
        }
        rebuild_projection(intersections, descriptors)
    }
}

fn resolve<'a>(entries: &'a [ProjectedInteraction], key: &str) -> Option<&'a ProjectedInteraction> {
    entries.iter().find(|entry| entry.alias == key).or_else(|| {
        entries
            .iter()
            .find(|entry| entry.interaction_id.as_str() == key)
    })
}

fn same_identity(left: &ProjectedInteraction, right: &ProjectedInteraction) -> bool {
    left.interaction_id == right.interaction_id
        && left.expected_contract_digest == right.expected_contract_digest
        && left.input_arity == right.input_arity
}

fn descriptors_for(
    projection: &Projection,
    aliases: &BTreeSet<String>,
) -> Result<BTreeMap<InteractionId, InteractionDescriptor>, ProjectError> {
    projection
        .manifest
        .interactions
        .iter()
        .filter(|entry| aliases.contains(&entry.alias))
        .map(|entry| {
            projection
                .manifest
                .program
                .interaction(&entry.interaction_id)
                .cloned()
                .map(|descriptor| (entry.interaction_id.clone(), descriptor))
                .ok_or_else(|| ProjectError::ContractMismatch(entry.interaction_id.clone()))
        })
        .collect()
}

fn rebuild_projection(
    mut interactions: Vec<ProjectedInteraction>,
    descriptors: BTreeMap<InteractionId, InteractionDescriptor>,
) -> Result<Projection, ProjectError> {
    interactions.sort_by(|left, right| left.alias.cmp(&right.alias));
    let mut builder = ProgramBuilder::default();
    for descriptor in descriptors.into_values() {
        builder = builder.descriptor(descriptor)?;
    }
    let program: Program = builder.finish()?;
    let projection_digest = projection_digest(&program, &interactions)?;
    Ok(Projection {
        manifest: ProjectionManifest {
            version: 1,
            projection_digest,
            program,
            interactions,
        },
    })
}
