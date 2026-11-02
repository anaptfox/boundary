use std::{cmp::Ordering, collections::BTreeMap};

use serde::{Deserialize, Deserializer, Serialize};

use super::super::{
    BindingDigest, InstallationCatalog, InstallationDigest, InstallationId, InteractionArity,
    InteractionMode, ProjectionDigest, RealizationId, RequestControlDigest,
};
use crate::{
    ContractDigest, InteractionId, PortableSchema, Program, ProgramDigest, ProgramError,
    contract_compatibility,
};

mod artifact;

use artifact::binding_digest;

/// Exact control identity pinned by a request-mode binding.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundRequest {
    control_digest: RequestControlDigest,
    preview_schema: PortableSchema,
}

impl BoundRequest {
    pub(super) fn new(
        control_digest: RequestControlDigest,
        preview_schema: PortableSchema,
    ) -> Self {
        Self {
            control_digest,
            preview_schema,
        }
    }

    /// Returns the pinned control identity.
    #[must_use]
    pub const fn control_digest(&self) -> &RequestControlDigest {
        &self.control_digest
    }

    /// Returns the pinned public proposal schema.
    #[must_use]
    pub const fn preview_schema(&self) -> &PortableSchema {
        &self.preview_schema
    }
}

/// One alias and mode pinned to one exact installation realization.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundInteraction {
    alias: String,
    interaction_id: InteractionId,
    expected_contract_digest: ContractDigest,
    actual_contract_digest: ContractDigest,
    input_arity: InteractionArity,
    mode: InteractionMode,
    realization_id: RealizationId,
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<BoundRequest>,
}

impl BoundInteraction {
    pub(super) fn with_alias(&self, alias: String) -> Self {
        Self {
            alias,
            ..self.clone()
        }
    }
    pub(super) fn direct(
        alias: String,
        interaction_id: InteractionId,
        expected_contract_digest: ContractDigest,
        actual_contract_digest: ContractDigest,
        input_arity: InteractionArity,
        realization_id: RealizationId,
    ) -> Self {
        Self {
            alias,
            interaction_id,
            expected_contract_digest,
            actual_contract_digest,
            input_arity,
            mode: InteractionMode::Direct,
            realization_id,
            request: None,
        }
    }

    pub(super) fn request(
        alias: String,
        interaction_id: InteractionId,
        expected_contract_digest: ContractDigest,
        actual_contract_digest: ContractDigest,
        input_arity: InteractionArity,
        realization_id: RealizationId,
        request: BoundRequest,
    ) -> Self {
        Self {
            alias,
            interaction_id,
            expected_contract_digest,
            actual_contract_digest,
            input_arity,
            mode: InteractionMode::Request,
            realization_id,
            request: Some(request),
        }
    }

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

    /// Returns the desired projection contract identity.
    #[must_use]
    pub const fn expected_contract_digest(&self) -> &ContractDigest {
        &self.expected_contract_digest
    }

    /// Returns the installed contract identity.
    #[must_use]
    pub const fn actual_contract_digest(&self) -> &ContractDigest {
        &self.actual_contract_digest
    }

    /// Returns the input arity pinned by this binding.
    #[must_use]
    pub const fn input_arity(&self) -> InteractionArity {
        self.input_arity
    }

    /// Returns the independently pinned execution mode.
    #[must_use]
    pub const fn mode(&self) -> InteractionMode {
        self.mode
    }

    /// Returns the exact host-issued realization identity.
    #[must_use]
    pub const fn realization_id(&self) -> &RealizationId {
        &self.realization_id
    }

    /// Returns request control identity only for request-mode entries.
    #[must_use]
    pub const fn request_identity(&self) -> Option<&BoundRequest> {
        self.request.as_ref()
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        if !super::super::projection::valid_alias(&self.alias) {
            return Err("binding interaction contains an invalid alias".to_owned());
        }
        if (self.mode == InteractionMode::Request) != self.request.is_some() {
            return Err("request metadata must be present exactly for request mode".to_owned());
        }
        Ok(())
    }
}

/// Data-only record of one complete, atomic projection binding.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingManifest {
    version: u8,
    binding_digest: BindingDigest,
    projection_digest: ProjectionDigest,
    installation_id: InstallationId,
    installation_digest: InstallationDigest,
    expected_program_digest: ProgramDigest,
    actual_program_digest: ProgramDigest,
    expected_program: Program,
    actual_program: Program,
    actual_catalog: InstallationCatalog,
    interactions: Vec<BoundInteraction>,
}

impl BindingManifest {
    pub(super) fn new(
        projection_digest: ProjectionDigest,
        installation_id: InstallationId,
        installation_digest: InstallationDigest,
        expected_program: Program,
        actual_program: Program,
        actual_catalog: InstallationCatalog,
        interactions: Vec<BoundInteraction>,
    ) -> Result<Self, ProgramError> {
        let mut manifest = Self {
            version: 1,
            binding_digest: BindingDigest::from_hash([0; 32]),
            projection_digest,
            installation_id,
            installation_digest,
            expected_program_digest: expected_program.digest().clone(),
            actual_program_digest: actual_program.digest().clone(),
            expected_program,
            actual_program,
            actual_catalog,
            interactions,
        };
        manifest.binding_digest = binding_digest(&manifest)?;
        Ok(manifest)
    }

    /// Returns this complete binding's stable identity.
    #[must_use]
    pub const fn binding_digest(&self) -> &BindingDigest {
        &self.binding_digest
    }

    /// Returns the exact desired Projection identity.
    #[must_use]
    pub const fn projection_digest(&self) -> &ProjectionDigest {
        &self.projection_digest
    }

    /// Returns the pinned host-issued installation identity.
    #[must_use]
    pub const fn installation_id(&self) -> &InstallationId {
        &self.installation_id
    }

    /// Returns the pinned installation artifact identity.
    #[must_use]
    pub const fn installation_digest(&self) -> &InstallationDigest {
        &self.installation_digest
    }

    /// Returns the exact expected Program identity.
    #[must_use]
    pub const fn expected_program_digest(&self) -> &ProgramDigest {
        &self.expected_program_digest
    }

    /// Returns the exact realized Program identity.
    #[must_use]
    pub const fn actual_program_digest(&self) -> &ProgramDigest {
        &self.actual_program_digest
    }

    /// Returns the desired closed Program.
    #[must_use]
    pub const fn expected_program(&self) -> &Program {
        &self.expected_program
    }

    /// Returns the exact installed subset bound here.
    #[must_use]
    pub const fn actual_program(&self) -> &Program {
        &self.actual_program
    }

    /// Returns realized availability for the actual Program.
    #[must_use]
    pub const fn actual_catalog(&self) -> &InstallationCatalog {
        &self.actual_catalog
    }

    /// Returns mode-level realization pins in alias then mode order.
    #[must_use]
    pub fn interactions(&self) -> &[BoundInteraction] {
        &self.interactions
    }

    pub(crate) fn interaction(
        &self,
        alias: &str,
        mode: InteractionMode,
    ) -> Option<&BoundInteraction> {
        self.interactions
            .binary_search_by(|interaction| compare_interaction(interaction, alias, mode))
            .ok()
            .and_then(|index| self.interactions.get(index))
    }

    fn validate(self) -> Result<Self, String> {
        if self.version != 1 {
            return Err("binding version must be 1".to_owned());
        }
        if self.expected_program.digest() != &self.expected_program_digest
            || self.actual_program.digest() != &self.actual_program_digest
        {
            return Err("binding Program digest mismatch".to_owned());
        }
        self.actual_catalog.validate_for(&self.actual_program)?;
        let mut prior: Option<(&str, InteractionMode)> = None;
        let mut availability = BTreeMap::<
            InteractionId,
            (
                Option<&RealizationId>,
                Option<(&RealizationId, &BoundRequest)>,
            ),
        >::new();
        let mut aliases = BTreeMap::<InteractionId, &str>::new();
        for interaction in &self.interactions {
            interaction.validate()?;
            if prior.is_some_and(|(alias, mode)| {
                alias > interaction.alias()
                    || (alias == interaction.alias() && mode >= interaction.mode())
            }) {
                return Err(
                    "binding interactions must be uniquely sorted by alias and mode".to_owned(),
                );
            }
            prior = Some((interaction.alias(), interaction.mode()));
            validate_program_entry(&self.expected_program, interaction, true)?;
            validate_program_entry(&self.actual_program, interaction, false)?;
            let expected = self
                .expected_program
                .interaction(interaction.interaction_id())
                .ok_or_else(|| {
                    "binding interaction is absent from its expected Program".to_owned()
                })?;
            let actual = self
                .actual_program
                .interaction(interaction.interaction_id())
                .ok_or_else(|| {
                    "binding interaction is absent from its actual Program".to_owned()
                })?;
            if !contract_compatibility(expected.contract(), actual.contract()).is_compatible() {
                return Err(
                    "binding actual contract is incompatible with its expected contract".to_owned(),
                );
            }
            if aliases
                .insert(interaction.interaction_id().clone(), interaction.alias())
                .is_some_and(|alias| alias != interaction.alias())
            {
                return Err("binding selects one interaction under multiple aliases".to_owned());
            }
            let entry = availability
                .entry(interaction.interaction_id().clone())
                .or_insert((None, None));
            match interaction.mode() {
                InteractionMode::Direct => entry.0 = Some(interaction.realization_id()),
                InteractionMode::Request => {
                    let request = interaction
                        .request_identity()
                        .ok_or_else(|| "request binding lacks Control identity".to_owned())?;
                    entry.1 = Some((interaction.realization_id(), request));
                }
            }
        }
        if availability.len() != self.actual_program.interactions().len()
            || availability.len() != self.expected_program.interactions().len()
        {
            return Err(
                "binding interactions must cover the expected and actual Programs exactly"
                    .to_owned(),
            );
        }
        for (id, actual) in self.actual_catalog.interactions() {
            let selected = availability.get(id).copied().unwrap_or((None, None));
            let request_matches = match (actual.request(), selected.1) {
                (None, None) => true,
                (Some(actual), Some((realization_id, selected))) => {
                    actual.realization_id() == realization_id
                        && actual.control_digest() == selected.control_digest()
                        && actual.preview_schema() == selected.preview_schema()
                }
                (None, Some(_)) | (Some(_), None) => false,
            };
            if actual.direct() != selected.0 || !request_matches {
                return Err("binding actual Catalog does not match realization pins".to_owned());
            }
        }
        let expected = binding_digest(&self).map_err(|error| error.to_string())?;
        if expected != self.binding_digest {
            return Err("binding digest mismatch".to_owned());
        }
        Ok(self)
    }
}

fn compare_interaction(
    interaction: &BoundInteraction,
    alias: &str,
    mode: InteractionMode,
) -> Ordering {
    interaction
        .alias()
        .cmp(alias)
        .then_with(|| interaction.mode().cmp(&mode))
}

fn validate_program_entry(
    program: &Program,
    interaction: &BoundInteraction,
    expected: bool,
) -> Result<(), String> {
    let descriptor = program
        .interaction(interaction.interaction_id())
        .ok_or_else(|| "binding interaction is absent from its Program".to_owned())?;
    let digest = if expected {
        interaction.expected_contract_digest()
    } else {
        interaction.actual_contract_digest()
    };
    if descriptor.contract_digest() != digest {
        return Err("binding interaction contract digest mismatch".to_owned());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBindingManifest {
    version: u8,
    binding_digest: BindingDigest,
    projection_digest: ProjectionDigest,
    installation_id: InstallationId,
    installation_digest: InstallationDigest,
    expected_program_digest: ProgramDigest,
    actual_program_digest: ProgramDigest,
    expected_program: Program,
    actual_program: Program,
    actual_catalog: InstallationCatalog,
    interactions: Vec<BoundInteraction>,
}

impl<'de> Deserialize<'de> for BindingManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawBindingManifest::deserialize(deserializer)?;
        Self {
            version: raw.version,
            binding_digest: raw.binding_digest,
            projection_digest: raw.projection_digest,
            installation_id: raw.installation_id,
            installation_digest: raw.installation_digest,
            expected_program_digest: raw.expected_program_digest,
            actual_program_digest: raw.actual_program_digest,
            expected_program: raw.expected_program,
            actual_program: raw.actual_program,
            actual_catalog: raw.actual_catalog,
            interactions: raw.interactions,
        }
        .validate()
        .map_err(serde::de::Error::custom)
    }
}
