use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use super::{ErasedInteraction, InstallationId, RealizationId, RequestControlDigest};
use crate::{ContractDigest, InputArity, InteractionId, PortableSchema, ProgramBuilder};

mod adapter;
mod manifest;
pub(super) mod native;
mod observed;
pub use observed::observed_read_realization;

use adapter::ContributionKind;
pub(in crate::lifecycle) use adapter::{
    DirectInputKind, DynamicDirect, DynamicRequest, InstallationCallFault, InstallationInput,
    InstallationOutcome, InstallationRequestFault,
};
pub use adapter::{
    InstallationContribution, NativeDispatchFault, NativeDispatchOutcome, NativeDispatchRequest,
    NativeDispatcher, RequestCapability, RequestCapabilityFault, declared_interaction,
    direct_realization, dispatch_realization, identified_request_realization, request_realization,
};
pub use manifest::{
    InstallationAvailability, InstallationCatalog, InstallationManifest,
    InstallationRequestAvailability,
};

/// One execution mode supplied by an installation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionMode {
    /// Execute the installed direct realization.
    Direct,
    /// Create a public request without applying the interaction.
    Request,
}

/// Dynamic input arity retained outside Program identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InteractionArity {
    /// The portable input is exactly `{}`.
    Zero,
    /// The portable input is one value.
    One,
}

impl From<InputArity> for InteractionArity {
    fn from(value: InputArity) -> Self {
        match value {
            InputArity::Zero => Self::Zero,
            InputArity::One => Self::One,
        }
    }
}

impl Serialize for InteractionArity {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(match self {
            Self::Zero => 0,
            Self::One => 1,
        })
    }
}

impl<'de> Deserialize<'de> for InteractionArity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match u8::deserialize(deserializer)? {
            0 => Ok(Self::Zero),
            1 => Ok(Self::One),
            _ => Err(serde::de::Error::custom("inputArity must be 0 or 1")),
        }
    }
}

/// Portable identity required to expose a request realization across hosts.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestIdentity {
    control_digest: RequestControlDigest,
    preview_schema: PortableSchema,
}

impl RequestIdentity {
    /// Creates the exact control and proposal-schema identity for a request capability.
    #[must_use]
    pub const fn new(control_digest: RequestControlDigest, preview_schema: PortableSchema) -> Self {
        Self {
            control_digest,
            preview_schema,
        }
    }

    /// Returns the exact control identity.
    #[must_use]
    pub const fn control_digest(&self) -> &RequestControlDigest {
        &self.control_digest
    }

    /// Returns the schema for public proposal data.
    #[must_use]
    pub const fn preview_schema(&self) -> &PortableSchema {
        &self.preview_schema
    }
}

/// One exact realization contributed to an installation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModeAvailability {
    mode: InteractionMode,
    realization_id: RealizationId,
}

impl ModeAvailability {
    /// Returns the contributed execution mode.
    #[must_use]
    pub const fn mode(&self) -> InteractionMode {
        self.mode
    }

    /// Returns the host-issued realization identity.
    #[must_use]
    pub const fn realization_id(&self) -> &RealizationId {
        &self.realization_id
    }
}

/// Installation-local runtime resolution for one exact interaction contract.
#[derive(Clone, Debug, PartialEq)]
pub struct InstalledInteraction {
    interaction_id: InteractionId,
    contract_digest: ContractDigest,
    input_arity: InteractionArity,
    modes: Vec<ModeAvailability>,
    request_identity: Option<RequestIdentity>,
}

impl InstalledInteraction {
    /// Returns the interaction identifier.
    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    /// Returns the exact contract digest.
    #[must_use]
    pub const fn contract_digest(&self) -> &ContractDigest {
        &self.contract_digest
    }

    /// Returns the declared dynamic input arity.
    #[must_use]
    pub const fn input_arity(&self) -> InteractionArity {
        self.input_arity
    }

    /// Returns mode contributions in deterministic order.
    #[must_use]
    pub fn modes(&self) -> &[ModeAvailability] {
        &self.modes
    }

    /// Returns portable control identity for an identified request realization.
    #[must_use]
    pub const fn request_identity(&self) -> Option<&RequestIdentity> {
        self.request_identity.as_ref()
    }

    pub(super) fn realization(&self, mode: InteractionMode) -> Option<&RealizationId> {
        self.modes
            .iter()
            .find(|availability| availability.mode == mode)
            .map(|availability| &availability.realization_id)
    }
}

/// Installation assembly failure.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum InstallError {
    /// The same interaction and mode were contributed more than once.
    #[error("duplicate {mode:?} realization for interaction `{interaction}`")]
    DuplicateMode {
        /// Duplicate interaction identifier.
        interaction: InteractionId,
        /// Duplicate mode.
        mode: InteractionMode,
    },
    /// One realization identity was reused across interaction modes.
    #[error("duplicate realization identity `{0}`")]
    DuplicateRealization(RealizationId),
    /// Contributions for one interaction disagree on contract or arity.
    #[error("installation contributions disagree for interaction `{0}`")]
    ContractMismatch(InteractionId),
    /// Installation Program, catalog, or digest construction failed.
    #[error(transparent)]
    Program(#[from] crate::ProgramError),
    /// Installation availability was not exhaustive for its Program.
    #[error("invalid installation artifact: {0}")]
    Artifact(String),
}

pub(super) struct InstallationInner<C: Sync + ?Sized> {
    manifest: InstallationManifest,
    interactions: BTreeMap<InteractionId, InstalledInteraction>,
    direct: BTreeMap<InteractionId, BTreeMap<ContractDigest, Arc<dyn DynamicDirect<C>>>>,
    request: BTreeMap<InteractionId, BTreeMap<ContractDigest, Arc<dyn DynamicRequest<C>>>>,
    revoked: AtomicBool,
}

struct PendingInteraction {
    interaction: ErasedInteraction,
    modes: BTreeMap<InteractionMode, RealizationId>,
    request_identity: Option<RequestIdentity>,
}

/// One immutable live installation. Bindings pin its exact allocation.
pub struct Installation<C: Sync + ?Sized = ()> {
    inner: Arc<InstallationInner<C>>,
}

impl<C: Sync + ?Sized> Installation<C> {
    /// Returns the data-only installation manifest.
    #[must_use]
    pub fn manifest(&self) -> &InstallationManifest {
        &self.inner.manifest
    }

    /// Returns installation-local runtime resolutions in interaction-id order.
    pub fn interactions(&self) -> impl Iterator<Item = &InstalledInteraction> {
        self.inner.interactions.values()
    }

    pub(super) fn pin(&self) -> Arc<InstallationInner<C>> {
        Arc::clone(&self.inner)
    }

    pub(super) fn interaction(&self, id: &InteractionId) -> Option<&InstalledInteraction> {
        self.inner.interactions.get(id)
    }

    pub(super) fn is_revoked(&self) -> bool {
        self.inner.is_revoked()
    }
}

impl<C: Sync + ?Sized> fmt::Debug for Installation<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Installation")
            .field("manifest", &self.inner.manifest)
            .finish_non_exhaustive()
    }
}

/// Host-held authority for one installation's lifecycle.
pub struct InstallationController<C: Sync + ?Sized = ()> {
    inner: Arc<InstallationInner<C>>,
}

impl<C: Sync + ?Sized> InstallationController<C> {
    /// Returns whether this installation has been revoked.
    #[must_use]
    pub fn revoked(&self) -> bool {
        self.inner.revoked.load(Ordering::Acquire)
    }

    /// Revokes the installation and every binding that pins it.
    ///
    /// Returns `true` only for the transition from live to revoked.
    #[must_use]
    pub fn revoke(&self) -> bool {
        let changed = !self.inner.revoked.swap(true, Ordering::AcqRel);
        if changed {
            for contracts in self.inner.direct.values() {
                for capability in contracts.values() {
                    capability.clear_retained();
                }
            }
        }
        changed
    }
}

impl<C: Sync + ?Sized> fmt::Debug for InstallationController<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstallationController")
            .field("revoked", &self.revoked())
            .finish_non_exhaustive()
    }
}

/// One installation together with the host-only authority that controls it.
pub struct Installed<C: Sync + ?Sized = ()> {
    /// Revocation-free execution and artifact view.
    pub installation: Installation<C>,
    /// Host-held lifecycle authority. Do not pass this to execution adapters.
    pub controller: InstallationController<C>,
}

/// Atomically assembles an immutable installation from exact contributions.
///
/// # Errors
///
/// Returns [`InstallError`] for duplicate modes, disagreement between
/// contributions, or an invalid resulting Program or manifest identity.
pub fn install<C>(
    installation_id: InstallationId,
    contributions: impl IntoIterator<Item = InstallationContribution<C>>,
) -> Result<Installed<C>, InstallError>
where
    C: Sync + ?Sized + 'static,
{
    let mut pending = BTreeMap::<InteractionId, PendingInteraction>::new();
    let mut direct = BTreeMap::new();
    let mut request = BTreeMap::new();
    let mut realization_ids = BTreeSet::new();
    for contribution in contributions {
        if let Some(realization_id) = &contribution.realization_id
            && !realization_ids.insert(realization_id.clone())
        {
            return Err(InstallError::DuplicateRealization(realization_id.clone()));
        }
        let id = contribution.interaction.descriptor.contract().id().clone();
        let digest = contribution
            .interaction
            .descriptor
            .contract_digest()
            .clone();
        let entry = pending
            .entry(id.clone())
            .or_insert_with(|| PendingInteraction {
                interaction: contribution.interaction.clone(),
                modes: BTreeMap::new(),
                request_identity: None,
            });
        if entry.interaction.descriptor.contract_digest() != &digest
            || entry.interaction.input_arity != contribution.interaction.input_arity
        {
            return Err(InstallError::ContractMismatch(id));
        }
        add_contribution(entry, contribution, id, digest, &mut direct, &mut request)?;
    }

    let mut program = ProgramBuilder::default();
    let mut interactions = BTreeMap::new();
    let mut availability = BTreeMap::new();
    for (interaction_id, value) in pending {
        program = program.descriptor(value.interaction.descriptor.clone())?;
        let catalog_entry = catalog_availability(&value.modes, value.request_identity.as_ref())?;
        availability.insert(interaction_id.clone(), catalog_entry);
        interactions.insert(
            interaction_id.clone(),
            InstalledInteraction {
                interaction_id,
                contract_digest: value.interaction.descriptor.contract_digest().clone(),
                input_arity: value.interaction.input_arity.into(),
                modes: value
                    .modes
                    .into_iter()
                    .map(|(mode, realization_id)| ModeAvailability {
                        mode,
                        realization_id,
                    })
                    .collect(),
                request_identity: value.request_identity,
            },
        );
    }
    let program = program.finish()?;
    let catalog =
        InstallationCatalog::new(&program, availability).map_err(InstallError::Artifact)?;
    let manifest = InstallationManifest::new(installation_id, program, catalog)?;
    let inner = Arc::new(InstallationInner {
        manifest,
        interactions,
        direct,
        request,
        revoked: AtomicBool::new(false),
    });
    Ok(Installed {
        installation: Installation {
            inner: Arc::clone(&inner),
        },
        controller: InstallationController { inner },
    })
}

fn add_contribution<C: Sync + ?Sized>(
    entry: &mut PendingInteraction,
    contribution: InstallationContribution<C>,
    id: InteractionId,
    digest: ContractDigest,
    direct: &mut BTreeMap<InteractionId, BTreeMap<ContractDigest, Arc<dyn DynamicDirect<C>>>>,
    request: &mut BTreeMap<InteractionId, BTreeMap<ContractDigest, Arc<dyn DynamicRequest<C>>>>,
) -> Result<(), InstallError> {
    match contribution.kind {
        ContributionKind::Declared => {}
        ContributionKind::Direct(capability) => {
            let realization_id = contribution.realization_id.ok_or_else(|| {
                InstallError::Artifact("direct realization lacks an identity".to_owned())
            })?;
            if entry
                .modes
                .insert(InteractionMode::Direct, realization_id)
                .is_some()
            {
                return Err(InstallError::DuplicateMode {
                    interaction: id,
                    mode: InteractionMode::Direct,
                });
            }
            direct.entry(id).or_default().insert(digest, capability);
        }
        ContributionKind::Request {
            capability,
            identity,
        } => {
            let realization_id = contribution.realization_id.ok_or_else(|| {
                InstallError::Artifact("request realization lacks an identity".to_owned())
            })?;
            if entry
                .modes
                .insert(InteractionMode::Request, realization_id)
                .is_some()
            {
                return Err(InstallError::DuplicateMode {
                    interaction: id.clone(),
                    mode: InteractionMode::Request,
                });
            }
            entry.request_identity = identity.map(|identity| *identity);
            request.entry(id).or_default().insert(digest, capability);
        }
    }
    Ok(())
}

fn catalog_availability(
    modes: &BTreeMap<InteractionMode, RealizationId>,
    request_identity: Option<&RequestIdentity>,
) -> Result<InstallationAvailability, InstallError> {
    let direct = modes.get(&InteractionMode::Direct).cloned();
    let Some(identity) = request_identity else {
        return Ok(InstallationAvailability::direct_only(direct));
    };
    let realization_id = modes
        .get(&InteractionMode::Request)
        .cloned()
        .ok_or_else(|| {
            InstallError::Artifact("request identity is missing its realization id".to_owned())
        })?;
    Ok(InstallationAvailability::controlled(
        direct,
        realization_id,
        identity.control_digest().clone(),
        identity.preview_schema().clone(),
    ))
}

impl<C: Sync + ?Sized> InstallationInner<C> {
    pub(super) fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    pub(super) fn direct(
        &self,
        interaction: &InteractionId,
        contract: &ContractDigest,
    ) -> Option<&Arc<dyn DynamicDirect<C>>> {
        self.direct.get(interaction)?.get(contract)
    }

    pub(super) fn request(
        &self,
        interaction: &InteractionId,
        contract: &ContractDigest,
    ) -> Option<&Arc<dyn DynamicRequest<C>>> {
        self.request.get(interaction)?.get(contract)
    }
}

pub(super) use InstallationInner as PinnedInstallation;
