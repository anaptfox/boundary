use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    marker::PhantomData,
};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use super::{
    CompiledInteraction, ErasedInteraction, InteractionArity, InteractionMode, ProjectionDigest,
};
use crate::{ContractDigest, Interaction, InteractionId, Program, ProgramBuilder};

mod artifact;
mod native;
pub use native::select_native;

use artifact::projection_digest;

/// Non-empty set of realization modes selected for one projection alias.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionModes {
    /// Expose direct execution only.
    Direct,
    /// Expose request creation only.
    Request,
    /// Expose both independently installed modes.
    DirectAndRequest,
}

impl Serialize for ProjectionModes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Direct => [InteractionMode::Direct].as_slice().serialize(serializer),
            Self::Request => [InteractionMode::Request].as_slice().serialize(serializer),
            Self::DirectAndRequest => [InteractionMode::Direct, InteractionMode::Request]
                .as_slice()
                .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ProjectionModes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let modes = Vec::<InteractionMode>::deserialize(deserializer)?;
        match modes.as_slice() {
            [InteractionMode::Direct] => Ok(Self::Direct),
            [InteractionMode::Request] => Ok(Self::Request),
            [InteractionMode::Direct, InteractionMode::Request] => Ok(Self::DirectAndRequest),
            _ => Err(serde::de::Error::custom(
                "projection modes must be [direct], [request], or [direct, request]",
            )),
        }
    }
}

impl ProjectionModes {
    pub(super) const fn contains(self, mode: InteractionMode) -> bool {
        matches!(
            (self, mode),
            (Self::Direct, InteractionMode::Direct)
                | (Self::Request, InteractionMode::Request)
                | (Self::DirectAndRequest, _)
        )
    }

    pub(super) fn iter(self) -> impl Iterator<Item = InteractionMode> {
        [InteractionMode::Direct, InteractionMode::Request]
            .into_iter()
            .filter(move |mode| self.contains(*mode))
    }
}

/// One explicit alias-to-interaction selection before projection construction.
pub struct ProjectionSelection {
    alias: String,
    interaction: ErasedInteraction,
    modes: ProjectionModes,
}

/// Projection construction failure.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ProjectError {
    /// Alias is unsuitable for a durable caller-facing handle.
    #[error("projection alias must be an ASCII identifier-like token")]
    InvalidAlias,
    /// One alias was selected more than once.
    #[error("duplicate projection alias `{0}`")]
    DuplicateAlias(String),
    /// One interaction was selected under more than one alias.
    #[error("interaction `{0}` is selected more than once")]
    DuplicateInteraction(InteractionId),
    /// One interaction id was compiled with conflicting contracts.
    #[error("projection contains conflicting contracts for interaction `{0}`")]
    ContractMismatch(InteractionId),
    /// Projection identity or its closed Program could not be constructed.
    #[error(transparent)]
    Program(#[from] crate::ProgramError),
}

/// Selects a typed compiled interaction under one durable caller-facing alias.
///
/// # Errors
///
/// Returns [`ProjectError::InvalidAlias`] for empty, untrimmed, or
/// control-bearing aliases.
pub fn select<O>(
    alias: impl Into<String>,
    interaction: &CompiledInteraction<O>,
    modes: ProjectionModes,
) -> Result<ProjectionSelection, ProjectError>
where
    O: Interaction,
{
    let alias = alias.into();
    if !valid_alias(&alias) {
        return Err(ProjectError::InvalidAlias);
    }
    Ok(ProjectionSelection {
        alias,
        interaction: interaction.erase(),
        modes,
    })
}

/// One selected interaction in a data-only projection manifest.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedInteraction {
    alias: String,
    interaction_id: InteractionId,
    expected_contract_digest: ContractDigest,
    input_arity: InteractionArity,
    modes: ProjectionModes,
}

impl ProjectedInteraction {
    /// Returns the caller-facing alias.
    #[must_use]
    pub fn alias(&self) -> &str {
        &self.alias
    }

    /// Returns the selected interaction identifier.
    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    /// Returns the exact selected contract digest.
    #[must_use]
    pub const fn expected_contract_digest(&self) -> &ContractDigest {
        &self.expected_contract_digest
    }

    /// Returns the exact selected contract digest.
    #[must_use]
    pub const fn contract_digest(&self) -> &ContractDigest {
        self.expected_contract_digest()
    }

    /// Returns the selected dynamic input arity.
    #[must_use]
    pub const fn input_arity(&self) -> InteractionArity {
        self.input_arity
    }

    /// Returns the selected realization modes.
    #[must_use]
    pub const fn modes(&self) -> ProjectionModes {
        self.modes
    }
}

/// Durable, unrealized desired interaction surface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionManifest {
    version: u8,
    projection_digest: ProjectionDigest,
    program: Program,
    interactions: Vec<ProjectedInteraction>,
}

impl ProjectionManifest {
    /// Returns the selected-subset identity.
    #[must_use]
    pub const fn projection_digest(&self) -> &ProjectionDigest {
        &self.projection_digest
    }

    /// Returns the closed handler-free Program for this projection.
    #[must_use]
    pub const fn program(&self) -> &Program {
        &self.program
    }

    /// Returns selections in alias order.
    #[must_use]
    pub fn interactions(&self) -> &[ProjectedInteraction] {
        &self.interactions
    }

    pub(super) fn interaction(&self, alias: &str) -> Option<&ProjectedInteraction> {
        self.interactions
            .binary_search_by(|interaction| interaction.alias.as_str().cmp(alias))
            .ok()
            .and_then(|index| self.interactions.get(index))
    }

    fn validate(self) -> Result<Self, String> {
        if self.version != 1 {
            return Err("projection version must be 1".to_owned());
        }
        let mut prior_alias: Option<&str> = None;
        let mut selected = BTreeSet::new();
        for interaction in &self.interactions {
            if !valid_alias(&interaction.alias) {
                return Err("projection contains an invalid alias".to_owned());
            }
            if prior_alias.is_some_and(|alias| alias >= interaction.alias.as_str()) {
                return Err("projection interactions must be uniquely sorted by alias".to_owned());
            }
            prior_alias = Some(&interaction.alias);
            let descriptor = self
                .program
                .interaction(&interaction.interaction_id)
                .ok_or_else(|| "projection interaction is absent from its Program".to_owned())?;
            if descriptor.contract_digest() != &interaction.expected_contract_digest {
                return Err("projection interaction contract digest mismatch".to_owned());
            }
            if !selected.insert(interaction.interaction_id.clone()) {
                return Err("projection interaction is selected more than once".to_owned());
            }
        }
        if selected.len() != self.program.interactions().len() {
            return Err("projection Program contains an unselected interaction".to_owned());
        }
        let expected = projection_digest(&self.program, &self.interactions)
            .map_err(|error| error.to_string())?;
        if expected != self.projection_digest {
            return Err("projection digest mismatch".to_owned());
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProjectionManifest {
    version: u8,
    projection_digest: ProjectionDigest,
    program: Program,
    interactions: Vec<ProjectedInteraction>,
}

impl<'de> Deserialize<'de> for ProjectionManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawProjectionManifest::deserialize(deserializer)?;
        Self {
            version: raw.version,
            projection_digest: raw.projection_digest,
            program: raw.program,
            interactions: raw.interactions,
        }
        .validate()
        .map_err(serde::de::Error::custom)
    }
}

/// Durable unrealized projection plus typed handle access.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Projection {
    manifest: ProjectionManifest,
}

impl Projection {
    /// Returns the data-only durable manifest.
    #[must_use]
    pub const fn manifest(&self) -> &ProjectionManifest {
        &self.manifest
    }

    /// Returns a typed handle lookup view.
    #[must_use]
    pub const fn handles(&self) -> ProjectionHandles<'_> {
        ProjectionHandles { projection: self }
    }
}

/// Constructs one durable projection without inspecting an installation.
///
/// # Errors
///
/// Returns [`ProjectError`] for duplicate aliases, conflicting contracts, or
/// an invalid resulting closed Program.
pub fn project(
    selections: impl IntoIterator<Item = ProjectionSelection>,
) -> Result<Projection, ProjectError> {
    let mut by_alias = BTreeMap::new();
    let mut definitions = BTreeMap::<InteractionId, ErasedInteraction>::new();
    for selection in selections {
        if by_alias.contains_key(&selection.alias) {
            return Err(ProjectError::DuplicateAlias(selection.alias));
        }
        let interaction_id = selection.interaction.descriptor.contract().id().clone();
        if let Some(existing) = definitions.get(&interaction_id) {
            if existing.descriptor.contract_digest()
                != selection.interaction.descriptor.contract_digest()
                || existing.input_arity != selection.interaction.input_arity
            {
                return Err(ProjectError::ContractMismatch(interaction_id));
            }
            return Err(ProjectError::DuplicateInteraction(interaction_id));
        }
        definitions.insert(interaction_id.clone(), selection.interaction.clone());
        by_alias.insert(
            selection.alias.clone(),
            ProjectedInteraction {
                alias: selection.alias,
                interaction_id,
                expected_contract_digest: selection
                    .interaction
                    .descriptor
                    .contract_digest()
                    .clone(),
                input_arity: selection.interaction.input_arity.into(),
                modes: selection.modes,
            },
        );
    }
    let mut builder = ProgramBuilder::default();
    for interaction in definitions.into_values() {
        builder = builder.descriptor(interaction.descriptor)?;
    }
    let program = builder.finish()?;
    let interactions = by_alias.into_values().collect::<Vec<_>>();
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

/// Typed lookup failure for one projection handle.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ProjectionHandleError {
    /// The alias is absent from this projection.
    #[error("projection alias is not selected")]
    NotSelected,
    /// The alias selects a different interaction contract or arity.
    #[error("projection alias selects a different interaction contract")]
    ContractMismatch,
}

/// Borrowed lookup view for caller-facing typed handles.
#[derive(Clone, Copy)]
pub struct ProjectionHandles<'a> {
    projection: &'a Projection,
}

impl ProjectionHandles<'_> {
    /// Resolves a selected alias against the exact compiled Rust interaction.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectionHandleError`] when the alias is absent or selects a
    /// different exact contract.
    pub fn get<O>(
        &self,
        alias: &str,
        interaction: &CompiledInteraction<O>,
    ) -> Result<ProjectionHandle<O>, ProjectionHandleError>
    where
        O: Interaction,
    {
        let selected = self
            .projection
            .manifest
            .interaction(alias)
            .ok_or(ProjectionHandleError::NotSelected)?;
        if selected.interaction_id != *interaction.interaction_id()
            || selected.expected_contract_digest != *interaction.contract_digest()
            || selected.input_arity != interaction.input_arity().into()
        {
            return Err(ProjectionHandleError::ContractMismatch);
        }
        Ok(ProjectionHandle {
            projection_digest: self.projection.manifest.projection_digest.clone(),
            alias: selected.alias.clone(),
            interaction_id: selected.interaction_id.clone(),
            contract_digest: selected.expected_contract_digest.clone(),
            input_arity: selected.input_arity,
            modes: selected.modes,
            _interaction: PhantomData,
        })
    }
}

/// Owned, typed capability name carried by a caller.
pub struct ProjectionHandle<O: Interaction> {
    projection_digest: ProjectionDigest,
    alias: String,
    interaction_id: InteractionId,
    contract_digest: ContractDigest,
    input_arity: InteractionArity,
    modes: ProjectionModes,
    _interaction: PhantomData<fn(O)>,
}

impl<O: Interaction> ProjectionHandle<O> {
    /// Returns the caller-facing alias.
    #[must_use]
    pub fn alias(&self) -> &str {
        &self.alias
    }

    /// Returns the selected interaction id.
    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    /// Returns the exact selected contract digest.
    #[must_use]
    pub const fn contract_digest(&self) -> &ContractDigest {
        &self.contract_digest
    }

    /// Returns the selected realization modes.
    #[must_use]
    pub const fn modes(&self) -> ProjectionModes {
        self.modes
    }

    pub(crate) const fn projection_digest(&self) -> &ProjectionDigest {
        &self.projection_digest
    }

    pub(crate) const fn input_arity(&self) -> InteractionArity {
        self.input_arity
    }
}

impl<O: Interaction> Clone for ProjectionHandle<O> {
    fn clone(&self) -> Self {
        Self {
            projection_digest: self.projection_digest.clone(),
            alias: self.alias.clone(),
            interaction_id: self.interaction_id.clone(),
            contract_digest: self.contract_digest.clone(),
            input_arity: self.input_arity,
            modes: self.modes,
            _interaction: PhantomData,
        }
    }
}

impl<O: Interaction> fmt::Debug for ProjectionHandle<O> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectionHandle")
            .field("alias", &self.alias)
            .field("interaction_id", &self.interaction_id)
            .field("contract_digest", &self.contract_digest)
            .field("modes", &self.modes)
            .finish_non_exhaustive()
    }
}

pub(super) fn valid_alias(alias: &str) -> bool {
    let bytes = alias.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || matches!(bytes[0], b'_' | b'$'))
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
}
