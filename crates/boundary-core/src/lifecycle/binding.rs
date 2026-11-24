use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use super::{
    Installation, InstallationAvailability, InstallationCatalog, InstalledInteraction,
    InteractionMode, PinnedInstallation, ProjectedInteraction, Projection,
};
use crate::{Compatibility, Program, ProgramBuilder, contract_compatibility};

mod caller;
mod coordination;
mod description;
mod manifest;
mod outcome;
mod restriction;
mod unrealized;

pub(crate) use caller::PortableInvocationOutcome;
pub use caller::{
    Admission, AdmissionDecision, AdmissionRequest, AdmitAll, Caller, CallerError, RequestError,
    admit_all,
};
pub use coordination::{
    CoordinatedInvocation, CoordinationError, CoordinationFuture, InvocationContinuation,
    InvocationCoordinator, coordinate_binding,
};
pub use description::{
    BindingDescription, BindingDescriptionError, DescribedBindingInteraction, describe_binding,
};
pub use manifest::{BindingManifest, BoundInteraction, BoundRequest};
pub use outcome::{InvocationCertainty, InvocationResultKind};
pub use restriction::{RestrictedAdmission, restrict_binding};
pub use unrealized::{UnrealizedIssue, UnrealizedReason, UnrealizedReport};

/// Atomic binding result: a complete caller capability or durable unrealized data.
pub enum BindResult<C: Sync + ?Sized, A> {
    /// Every selected alias and mode is pinned to one live installation.
    Bound(Box<Bound<C, A>>),
    /// At least one selection could not be realized; nothing is callable.
    Unrealized(UnrealizedReport),
}

/// One binding together with the host-only authority that controls it.
pub struct Bound<C: Sync + ?Sized, A> {
    /// Revocation-free execution and artifact view.
    pub binding: Binding<C, A>,
    /// Host-held lifecycle authority. Do not pass this to execution adapters.
    pub controller: BindingController,
}

/// Complete live binding. It never owns invocation context.
pub struct Binding<C: Sync + ?Sized, A> {
    pub(super) manifest: BindingManifest,
    pub(super) installation: Arc<PinnedInstallation<C>>,
    pub(super) admission: Arc<A>,
    revoked: Arc<AtomicBool>,
    ancestors: Vec<Arc<AtomicBool>>,
    coordinators: Vec<Arc<dyn InvocationCoordinator<C>>>,
}

impl<C: Sync + ?Sized, A> Binding<C, A> {
    /// Returns the data-only exact binding manifest.
    #[must_use]
    pub const fn manifest(&self) -> &BindingManifest {
        &self.manifest
    }

    /// Borrows a stateless caller. Context is supplied only to each invocation.
    #[must_use]
    pub const fn caller(&self) -> Caller<'_, C, A> {
        Caller { binding: self }
    }

    pub(crate) fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
            || self
                .ancestors
                .iter()
                .any(|state| state.load(Ordering::Acquire))
            || self.installation.is_revoked()
    }
}

impl<C: Sync + ?Sized, A> fmt::Debug for Binding<C, A> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Binding")
            .field("manifest", &self.manifest)
            .finish_non_exhaustive()
    }
}

/// Host-held authority for one binding's lifecycle.
pub struct BindingController {
    revoked: Arc<AtomicBool>,
}

impl BindingController {
    /// Returns whether this binding has been revoked.
    #[must_use]
    pub fn revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    /// Revokes this binding without revoking its installation.
    ///
    /// Returns `true` only for the transition from live to revoked.
    #[must_use]
    pub fn revoke(&self) -> bool {
        !self.revoked.swap(true, Ordering::AcqRel)
    }
}

impl fmt::Debug for BindingController {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BindingController")
            .field("revoked", &self.revoked())
            .finish_non_exhaustive()
    }
}

/// Tries to realize an entire durable projection against one installation.
///
/// The returned value is never partially callable. Admission is retained only
/// when every selected interaction and mode is available with exact identity.
#[must_use]
pub fn bind<C, A>(
    projection: &Projection,
    installation: &Installation<C>,
    admission: A,
) -> BindResult<C, A>
where
    C: Sync + ?Sized + 'static,
    A: Admission<C>,
{
    let projection_manifest = projection.manifest();
    let installation_manifest = installation.manifest();
    if installation.is_revoked() {
        return BindResult::Unrealized(revoked_installation_report(projection, installation));
    }
    let (interactions, issues) = resolve_interactions(projection, installation);
    if !issues.is_empty() {
        return BindResult::Unrealized(UnrealizedReport::new(
            projection_manifest.clone(),
            installation_manifest.installation_id().clone(),
            issues,
        ));
    }

    let actual_program = match actual_program(projection, installation) {
        Ok(program) => program,
        Err(message) => {
            return BindResult::Unrealized(artifact_report(projection, installation, message));
        }
    };
    let actual_catalog = match actual_catalog(projection, installation, &actual_program) {
        Ok(catalog) => catalog,
        Err(message) => {
            return BindResult::Unrealized(artifact_report(projection, installation, message));
        }
    };
    let manifest = match BindingManifest::new(
        projection_manifest.projection_digest().clone(),
        installation_manifest.installation_id().clone(),
        installation_manifest.installation_digest().clone(),
        projection_manifest.program().clone(),
        actual_program,
        actual_catalog,
        interactions,
    ) {
        Ok(manifest) => manifest,
        Err(error) => {
            return BindResult::Unrealized(artifact_report(
                projection,
                installation,
                error.to_string(),
            ));
        }
    };
    if installation.is_revoked() {
        return BindResult::Unrealized(revoked_installation_report(projection, installation));
    }
    finish_binding(
        manifest,
        installation.pin(),
        Arc::new(admission),
        Vec::new(),
        Arc::new(AtomicBool::new(false)),
        Vec::new(),
    )
}

fn revoked_installation_report<C: Sync + ?Sized>(
    projection: &Projection,
    installation: &Installation<C>,
) -> UnrealizedReport {
    let issues = projection
        .manifest()
        .interactions()
        .iter()
        .map(|selected| {
            UnrealizedIssue::new(
                selected.alias().to_owned(),
                selected.interaction_id().clone(),
                None,
                UnrealizedReason::InstallationRevoked,
                "the Installation was revoked before binding",
            )
        })
        .collect();
    UnrealizedReport::new(
        projection.manifest().clone(),
        installation.manifest().installation_id().clone(),
        issues,
    )
}

fn finish_binding<C: Sync + ?Sized, A>(
    manifest: BindingManifest,
    installation: Arc<PinnedInstallation<C>>,
    admission: Arc<A>,
    ancestors: Vec<Arc<AtomicBool>>,
    revoked: Arc<AtomicBool>,
    coordinators: Vec<Arc<dyn InvocationCoordinator<C>>>,
) -> BindResult<C, A> {
    BindResult::Bound(Box::new(Bound {
        binding: Binding {
            manifest,
            installation,
            admission,
            revoked: Arc::clone(&revoked),
            ancestors,
            coordinators,
        },
        controller: BindingController { revoked },
    }))
}

fn resolve_interactions<C: Sync + ?Sized>(
    projection: &Projection,
    installation: &Installation<C>,
) -> (Vec<BoundInteraction>, Vec<UnrealizedIssue>) {
    let mut interactions = Vec::new();
    let mut issues = Vec::new();
    if installation.is_revoked() {
        for selected in projection.manifest().interactions() {
            issues.push(UnrealizedIssue::new(
                selected.alias().to_owned(),
                selected.interaction_id().clone(),
                None,
                UnrealizedReason::InstallationRevoked,
                "the Installation was revoked before binding",
            ));
        }
    }
    for selected in projection.manifest().interactions() {
        resolve_selected(
            selected,
            projection.manifest().program(),
            installation,
            &mut interactions,
            &mut issues,
        );
    }
    (interactions, issues)
}

fn resolve_selected<C: Sync + ?Sized>(
    selected: &ProjectedInteraction,
    expected_program: &Program,
    installation: &Installation<C>,
    interactions: &mut Vec<BoundInteraction>,
    issues: &mut Vec<UnrealizedIssue>,
) {
    let Some(installed) = installation.interaction(selected.interaction_id()) else {
        issues.push(UnrealizedIssue::new(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            None,
            UnrealizedReason::MissingInteraction,
            "the Installation does not realize this interaction",
        ));
        return;
    };
    let Some(expected_descriptor) = expected_program.interaction(selected.interaction_id()) else {
        issues.push(UnrealizedIssue::new(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            None,
            UnrealizedReason::InvalidLifecycleArtifact,
            "the Projection Program does not contain its selected interaction",
        ));
        return;
    };
    let Some(actual_descriptor) = installation
        .manifest()
        .program()
        .interaction(selected.interaction_id())
    else {
        issues.push(UnrealizedIssue::new(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            None,
            UnrealizedReason::InvalidLifecycleArtifact,
            "the Installation Program does not contain its installed interaction",
        ));
        return;
    };
    if let Some(message) =
        incompatible_contract_message(expected_descriptor.contract(), actual_descriptor.contract())
    {
        issues.push(UnrealizedIssue::new(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            None,
            UnrealizedReason::IncompatibleContract,
            message,
        ));
        return;
    }
    if installed.input_arity() != selected.input_arity() {
        issues.push(UnrealizedIssue::new(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            None,
            UnrealizedReason::IncompatibleArity,
            "expected and actual input arities differ",
        ));
        return;
    }
    for mode in selected.modes().iter() {
        resolve_mode(selected, installed, mode, interactions, issues);
    }
}

fn resolve_mode(
    selected: &ProjectedInteraction,
    installed: &InstalledInteraction,
    mode: InteractionMode,
    interactions: &mut Vec<BoundInteraction>,
    issues: &mut Vec<UnrealizedIssue>,
) {
    let Some(realization_id) = installed.realization(mode) else {
        issues.push(UnrealizedIssue::new(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            Some(mode),
            match mode {
                InteractionMode::Direct => UnrealizedReason::MissingDirect,
                InteractionMode::Request => UnrealizedReason::MissingRequest,
            },
            format!("the Installation does not realize {mode:?} mode").to_lowercase(),
        ));
        return;
    };
    match mode {
        InteractionMode::Direct => interactions.push(BoundInteraction::direct(
            selected.alias().to_owned(),
            selected.interaction_id().clone(),
            selected.contract_digest().clone(),
            installed.contract_digest().clone(),
            selected.input_arity(),
            realization_id.clone(),
        )),
        InteractionMode::Request => match installed.request_identity() {
            Some(identity) => interactions.push(BoundInteraction::request(
                selected.alias().to_owned(),
                selected.interaction_id().clone(),
                selected.contract_digest().clone(),
                installed.contract_digest().clone(),
                selected.input_arity(),
                realization_id.clone(),
                BoundRequest::new(
                    identity.control_digest().clone(),
                    identity.preview_schema().clone(),
                ),
            )),
            None => issues.push(UnrealizedIssue::new(
                selected.alias().to_owned(),
                selected.interaction_id().clone(),
                Some(InteractionMode::Request),
                UnrealizedReason::MismatchedRequestIdentity,
                "the request realization lacks exact control identity",
            )),
        },
    }
}

fn incompatible_contract_message(
    expected: &crate::InteractionContract,
    actual: &crate::InteractionContract,
) -> Option<String> {
    match contract_compatibility(expected, actual) {
        Compatibility::Compatible => None,
        Compatibility::Incompatible { path, reason } => Some(format!(
            "the installed contract is incompatible at {path}: {reason}"
        )),
    }
}

fn actual_program<C: Sync + ?Sized>(
    projection: &Projection,
    installation: &Installation<C>,
) -> Result<Program, String> {
    let mut builder = ProgramBuilder::default();
    for selected in projection.manifest().interactions() {
        let descriptor = installation
            .manifest()
            .program()
            .interaction(selected.interaction_id())
            .ok_or_else(|| {
                "bound interaction disappeared from the Installation Program".to_owned()
            })?;
        builder = builder
            .descriptor(descriptor.clone())
            .map_err(|error| error.to_string())?;
    }
    builder.finish().map_err(|error| error.to_string())
}

fn actual_catalog<C: Sync + ?Sized>(
    projection: &Projection,
    installation: &Installation<C>,
    actual_program: &crate::Program,
) -> Result<InstallationCatalog, String> {
    let mut availability = std::collections::BTreeMap::new();
    for selected in projection.manifest().interactions() {
        let installed = installation
            .interaction(selected.interaction_id())
            .ok_or_else(|| "bound interaction disappeared from its Installation".to_owned())?;
        let direct = selected
            .modes()
            .contains(InteractionMode::Direct)
            .then(|| installed.realization(InteractionMode::Direct).cloned())
            .flatten();
        let entry = if selected.modes().contains(InteractionMode::Request) {
            let identity = installed
                .request_identity()
                .ok_or_else(|| "bound request realization lost its control identity".to_owned())?;
            let realization_id = installed
                .realization(InteractionMode::Request)
                .cloned()
                .ok_or_else(|| "bound request realization lost its identity".to_owned())?;
            InstallationAvailability::controlled(
                direct,
                realization_id,
                identity.control_digest().clone(),
                identity.preview_schema().clone(),
            )
        } else {
            InstallationAvailability::direct_only(direct)
        };
        availability.insert(selected.interaction_id().clone(), entry);
    }
    InstallationCatalog::new(actual_program, availability)
}

fn artifact_report<C: Sync + ?Sized>(
    projection: &Projection,
    installation: &Installation<C>,
    message: String,
) -> UnrealizedReport {
    let issues = projection
        .manifest()
        .interactions()
        .first()
        .map(|selected| {
            vec![UnrealizedIssue::new(
                selected.alias().to_owned(),
                selected.interaction_id().clone(),
                None,
                UnrealizedReason::InvalidLifecycleArtifact,
                message,
            )]
        })
        .unwrap_or_default();
    UnrealizedReport::new(
        projection.manifest().clone(),
        installation.manifest().installation_id().clone(),
        issues,
    )
}
