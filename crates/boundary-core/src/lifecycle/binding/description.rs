use serde::Serialize;
use thiserror::Error;

use super::{Binding, BindingManifest, BoundInteraction};
use crate::InteractionDescriptor;

/// Selected declaration and realization data, without callable capabilities.
#[derive(Debug, Serialize)]
pub struct DescribedBindingInteraction<'a> {
    #[serde(flatten)]
    binding: &'a BoundInteraction,
    expected: &'a InteractionDescriptor,
    actual: &'a InteractionDescriptor,
}

impl DescribedBindingInteraction<'_> {
    /// Returns the selected alias, mode and exact realization/control pins.
    #[must_use]
    pub const fn binding(&self) -> &BoundInteraction {
        self.binding
    }

    /// Returns the caller's expected contract, schemas, prose and footprint.
    #[must_use]
    pub const fn expected(&self) -> &InteractionDescriptor {
        self.expected
    }

    /// Returns the realized contract, schemas, prose and footprint.
    #[must_use]
    pub const fn actual(&self) -> &InteractionDescriptor {
        self.actual
    }
}

/// Immutable inspection of one authentic live Binding's selected entries.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingDescription<'a> {
    binding_digest: &'a crate::lifecycle::BindingDigest,
    projection_digest: &'a crate::lifecycle::ProjectionDigest,
    installation_id: &'a crate::lifecycle::InstallationId,
    installation_digest: &'a crate::lifecycle::InstallationDigest,
    interactions: Vec<DescribedBindingInteraction<'a>>,
    #[serde(skip)]
    manifest: &'a BindingManifest,
}

impl BindingDescription<'_> {
    /// Returns exact data-only identity and selected availability.
    #[must_use]
    pub const fn manifest(&self) -> &BindingManifest {
        self.manifest
    }

    /// Returns selected entries only, including request-only selections.
    #[must_use]
    pub fn interactions(&self) -> &[DescribedBindingInteraction<'_>] {
        &self.interactions
    }
}

/// An internally inconsistent native Binding cannot be described.
#[derive(Debug, Error)]
#[error("binding is missing a selected descriptor")]
pub struct BindingDescriptionError;

/// Derives immutable selected contract data from an authentic native Binding.
/// Description is inspection, not admission or a new execution capability.
///
/// # Errors
/// Returns an error if a selected expected or actual descriptor is missing.
pub fn describe_binding<C: Sync + ?Sized, A>(
    binding: &Binding<C, A>,
) -> Result<BindingDescription<'_>, BindingDescriptionError> {
    let manifest = binding.manifest();
    let interactions = manifest
        .interactions()
        .iter()
        .map(|bound| {
            let expected = manifest
                .expected_program()
                .interaction(bound.interaction_id())
                .ok_or(BindingDescriptionError)?;
            let actual = manifest
                .actual_program()
                .interaction(bound.interaction_id())
                .ok_or(BindingDescriptionError)?;
            Ok(DescribedBindingInteraction {
                binding: bound,
                expected,
                actual,
            })
        })
        .collect::<Result<_, BindingDescriptionError>>()?;
    Ok(BindingDescription {
        binding_digest: manifest.binding_digest(),
        projection_digest: manifest.projection_digest(),
        installation_id: manifest.installation_id(),
        installation_digest: manifest.installation_digest(),
        interactions,
        manifest,
    })
}
