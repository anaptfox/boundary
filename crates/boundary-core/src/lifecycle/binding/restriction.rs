use std::sync::{Arc, atomic::AtomicBool};

use super::{
    Admission, AdmissionDecision, AdmissionRequest, BindResult, Binding, BindingManifest,
    BoundInteraction, UnrealizedIssue, UnrealizedReason, UnrealizedReport, finish_binding,
};
use crate::{
    ProgramBuilder,
    lifecycle::{InstallationAvailability, InstallationCatalog, InteractionMode, Projection},
};

/// Additional admission retaining a parent's exact policy and bound view.
///
/// Constructed only by [`restrict_binding`]. Policy lineage remains private
/// and does not enter the portable binding identity.
pub struct RestrictedAdmission<C: Sync + ?Sized, Parent, Additional> {
    parent: Arc<Parent>,
    parent_manifest: BindingManifest,
    additional: Additional,
    _context: std::marker::PhantomData<fn(&C)>,
}

impl<C, Parent, Additional> Admission<C> for RestrictedAdmission<C, Parent, Additional>
where
    C: Sync + ?Sized + 'static,
    Parent: Admission<C>,
    Additional: Admission<C>,
{
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, C>) -> AdmissionDecision {
        if !request.is_live() {
            return AdmissionDecision::Admit;
        }
        let inherited = self
            .parent_manifest
            .interactions()
            .iter()
            .find(|interaction| {
                interaction.interaction_id() == request.interaction().interaction_id()
                    && interaction.mode() == request.mode()
            });
        let Some(inherited) = inherited else {
            return AdmissionDecision::Deny {
                code: "binding-restriction-invalid".to_owned(),
            };
        };
        match self.parent.admit(request.rebind(inherited)).await {
            AdmissionDecision::Admit => {
                if request.is_live() {
                    self.additional.admit(request).await
                } else {
                    // The caller's immediate post-admission liveness check returns
                    // Revoked. Do not evaluate more host policy after revocation.
                    AdmissionDecision::Admit
                }
            }
            denied @ AdmissionDecision::Deny { .. } => denied,
        }
    }
}

/// Derives a narrower binding while retaining the parent's policies and lifecycle.
///
/// The child may rename aliases or remove interactions/modes. Expected contracts
/// and arities must remain exact. Revoking a parent blocks every descendant;
/// revoking a child does not revoke its parent, siblings, or installation.
#[must_use]
pub fn restrict_binding<C, Parent, Additional>(
    parent: &Binding<C, Parent>,
    projection: &Projection,
    additional: Additional,
) -> BindResult<C, RestrictedAdmission<C, Parent, Additional>>
where
    C: Sync + ?Sized + 'static,
    Parent: Admission<C>,
    Additional: Admission<C>,
{
    let (interactions, issues) = restricted_interactions(parent, projection);
    if !issues.is_empty() || parent.is_revoked() {
        return unrealized(parent, projection, issues);
    }
    let manifest = match restricted_manifest(parent, projection, interactions) {
        Ok(manifest) => manifest,
        Err(message) => {
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
            return unrealized(parent, projection, issues);
        }
    };
    if parent.is_revoked() {
        return unrealized(
            parent,
            projection,
            restricted_interactions(parent, projection).1,
        );
    }
    let mut ancestors = parent.ancestors.clone();
    ancestors.push(Arc::clone(&parent.revoked));
    let revoked = Arc::new(AtomicBool::new(false));
    let admission = RestrictedAdmission {
        parent: Arc::clone(&parent.admission),
        parent_manifest: parent.manifest.clone(),
        additional,
        _context: std::marker::PhantomData,
    };
    finish_binding(
        manifest,
        Arc::clone(&parent.installation),
        Arc::new(admission),
        ancestors,
        revoked,
        parent.coordinators.clone(),
    )
}

fn restricted_interactions<C: Sync + ?Sized, Parent>(
    parent: &Binding<C, Parent>,
    projection: &Projection,
) -> (Vec<BoundInteraction>, Vec<UnrealizedIssue>) {
    let mut interactions = Vec::new();
    let mut issues = Vec::new();
    for selected in projection.manifest().interactions() {
        let issue = |reason, mode, message: &str| {
            UnrealizedIssue::new(
                selected.alias().to_owned(),
                selected.interaction_id().clone(),
                mode,
                reason,
                message,
            )
        };
        if parent.installation.is_revoked() {
            issues.push(issue(
                UnrealizedReason::InstallationRevoked,
                None,
                "the Installation was revoked before binding",
            ));
        } else if parent.is_revoked() {
            issues.push(issue(
                UnrealizedReason::BindingRevoked,
                None,
                "the parent Binding was revoked before restriction",
            ));
        }
        let inherited = parent
            .manifest
            .interactions()
            .iter()
            .find(|entry| entry.interaction_id() == selected.interaction_id());
        let Some(inherited) = inherited else {
            issues.push(issue(
                UnrealizedReason::InteractionNotSelected,
                None,
                "the parent Binding does not select this interaction",
            ));
            continue;
        };
        if inherited.expected_contract_digest() != selected.contract_digest() {
            issues.push(issue(
                UnrealizedReason::ContractNotSelected,
                None,
                "the child must retain the parent's exact expected contract",
            ));
        }
        if inherited.input_arity() != selected.input_arity() {
            issues.push(issue(
                UnrealizedReason::ArityNotSelected,
                None,
                "the child must retain the parent's exact input arity",
            ));
        }
        for mode in selected.modes().iter() {
            match parent.manifest.interactions().iter().find(|entry| {
                entry.interaction_id() == selected.interaction_id() && entry.mode() == mode
            }) {
                Some(entry) => interactions.push(entry.with_alias(selected.alias().to_owned())),
                None => issues.push(issue(
                    UnrealizedReason::ModeNotSelected,
                    Some(mode),
                    "the parent Binding does not select this mode",
                )),
            }
        }
    }
    (interactions, issues)
}

fn unrealized<C: Sync + ?Sized, Parent, Additional>(
    parent: &Binding<C, Parent>,
    projection: &Projection,
    issues: Vec<UnrealizedIssue>,
) -> BindResult<C, Additional> {
    BindResult::Unrealized(UnrealizedReport::new(
        projection.manifest().clone(),
        parent.manifest.installation_id().clone(),
        issues,
    ))
}

fn restricted_manifest<C: Sync + ?Sized, Parent>(
    parent: &Binding<C, Parent>,
    projection: &Projection,
    interactions: Vec<BoundInteraction>,
) -> Result<BindingManifest, String> {
    let mut builder = ProgramBuilder::default();
    let mut availability = std::collections::BTreeMap::new();
    for selected in projection.manifest().interactions() {
        let descriptor = parent
            .manifest
            .actual_program()
            .interaction(selected.interaction_id())
            .ok_or_else(|| {
                "bound interaction disappeared from the parent's actual Program".to_owned()
            })?;
        builder = builder
            .descriptor(descriptor.clone())
            .map_err(|error| error.to_string())?;
        let installed = parent
            .manifest
            .actual_catalog()
            .interaction(selected.interaction_id())
            .ok_or_else(|| {
                "bound interaction disappeared from the parent's actual Catalog".to_owned()
            })?;
        let direct = selected
            .modes()
            .contains(InteractionMode::Direct)
            .then(|| installed.direct().cloned())
            .flatten();
        let entry = if selected.modes().contains(InteractionMode::Request) {
            let request = installed
                .request()
                .ok_or_else(|| "bound request lost its exact control identity".to_owned())?;
            InstallationAvailability::controlled(
                direct,
                request.realization_id().clone(),
                request.control_digest().clone(),
                request.preview_schema().clone(),
            )
        } else {
            InstallationAvailability::direct_only(direct)
        };
        availability.insert(selected.interaction_id().clone(), entry);
    }
    let actual = builder.finish().map_err(|error| error.to_string())?;
    let catalog = InstallationCatalog::new(&actual, availability)?;
    BindingManifest::new(
        projection.manifest().projection_digest().clone(),
        parent.manifest.installation_id().clone(),
        parent.manifest.installation_digest().clone(),
        projection.manifest().program().clone(),
        actual,
        catalog,
        interactions,
    )
    .map_err(|error| error.to_string())
}
