#![allow(unknown_lints, clippy::unused_async_trait_impl)]
#![allow(clippy::panic)]

//! Atomic lifecycle replacement preserves the active binding on failure.

use boundary_core::{
    Handler, Interaction, JsonCodec, NoError, ReadFootprint, ReadOnly, interaction_id,
    lifecycle::{
        BindResult, BindingSlot, CallerError, InstallationId, Projection, ProjectionModes,
        RealizationId, RebindResult, UnrealizedReport, admit_all, bind, compile_interaction,
        direct_realization, install, project, rebind, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Read {
    value: String,
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct ChangedRead {
    value: String,
}

impl Interaction for Read {
    const ID: boundary_core::StaticInteractionId = interaction_id!("rebind.read");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;

    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["values"])
    }
}

impl Interaction for ChangedRead {
    const ID: boundary_core::StaticInteractionId = interaction_id!("rebind.read");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;

    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["different-values"])
    }
}

struct ReadHandler(&'static str);

impl Handler<Read, ()> for ReadHandler {
    async fn handle(&self, _context: &(), _input: Read) -> Result<String, NoError> {
        Ok(self.0.to_owned())
    }
}

struct ChangedReadHandler;

impl Handler<ChangedRead, ()> for ChangedReadHandler {
    async fn handle(&self, _context: &(), input: ChangedRead) -> Result<String, NoError> {
        Ok(input.value)
    }
}

fn projection(alias: &str) -> Projection {
    let interaction = compile_interaction::<Read>().unwrap_or_else(|error| panic!("{error}"));
    let selection = select(alias, &interaction, ProjectionModes::Direct)
        .unwrap_or_else(|error| panic!("{error}"));
    project([selection]).unwrap_or_else(|error| panic!("{error}"))
}

fn installation(id: &str, output: &'static str) -> boundary_core::lifecycle::Installed<()> {
    let interaction = compile_interaction::<Read>().unwrap_or_else(|error| panic!("{error}"));
    let contribution = direct_realization(
        &interaction,
        RealizationId::new(format!("{id}.read")).unwrap_or_else(|error| panic!("{error}")),
        ReadHandler(output),
    );
    install(
        InstallationId::new(id).unwrap_or_else(|error| panic!("{error}")),
        [contribution],
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

fn empty_installation(id: &str) -> boundary_core::lifecycle::Installed<()> {
    install(
        InstallationId::new(id).unwrap_or_else(|error| panic!("{error}")),
        [],
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

fn incompatible_installation(id: &str) -> boundary_core::lifecycle::Installed<()> {
    let interaction =
        compile_interaction::<ChangedRead>().unwrap_or_else(|error| panic!("{error}"));
    let contribution = direct_realization(
        &interaction,
        RealizationId::new(format!("{id}.read")).unwrap_or_else(|error| panic!("{error}")),
        ChangedReadHandler,
    );
    install(
        InstallationId::new(id).unwrap_or_else(|error| panic!("{error}")),
        [contribution],
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

fn bound(
    projection: &Projection,
    installation: &boundary_core::lifecycle::Installation<()>,
) -> boundary_core::lifecycle::Bound<(), boundary_core::lifecycle::AdmitAll> {
    match bind(projection, installation, admit_all()) {
        BindResult::Bound(bound) => *bound,
        BindResult::Unrealized(_) => panic!("fixture should bind"),
    }
}

fn handle(projection: &Projection) -> boundary_core::lifecycle::ProjectionHandle<Read> {
    let interaction = compile_interaction::<Read>().unwrap_or_else(|error| panic!("{error}"));
    projection
        .handles()
        .get("value", &interaction)
        .unwrap_or_else(|error| panic!("{error}"))
}

async fn call(
    binding: &boundary_core::lifecycle::Binding<(), boundary_core::lifecycle::AdmitAll>,
    projection: &Projection,
    input: &str,
) -> Result<String, CallerError<NoError>> {
    binding
        .caller()
        .call(
            &(),
            &handle(projection),
            Read {
                value: input.to_owned(),
            },
        )
        .await
}

#[test]
fn successful_rebind_binds_new_capability_before_revoking_previous() {
    let projection = projection("value");
    let old_installation = installation("old", "old output");
    let next_installation = installation("next", "new output");
    let previous = bound(&projection, &old_installation.installation);
    let previous_digest = previous.binding.manifest().binding_digest().clone();
    let old_binding = previous.binding;
    let previous_controller = previous.controller;

    let result = rebind(
        &projection,
        previous_digest.clone(),
        &previous_controller,
        &next_installation.installation,
        admit_all(),
    );

    let RebindResult::Rebound(rebound) = result else {
        panic!("expected successful rebind")
    };
    assert_eq!(rebound.previous_binding_digest, previous_digest);
    assert!(rebound.previous_revoked);
    assert!(previous_controller.revoked());
    assert_eq!(
        block_on(call(&rebound.bound.binding, &projection, "input"))
            .unwrap_or_else(|error| panic!("{error}")),
        "new output"
    );
    assert!(matches!(
        block_on(call(&old_binding, &projection, "input")),
        Err(CallerError::Revoked)
    ));
}

#[test]
fn failed_rebind_keeps_previous_binding_live_and_callable() {
    let projection = projection("value");
    let old_installation = installation("old-failure", "still live");
    let missing_installation = empty_installation("missing");
    let incompatible_installation = incompatible_installation("incompatible");
    let revoked_installation = installation("revoked", "unavailable");
    assert!(revoked_installation.controller.revoke());
    let previous = bound(&projection, &old_installation.installation);
    let previous_digest = previous.binding.manifest().binding_digest().clone();

    let result = rebind(
        &projection,
        previous_digest.clone(),
        &previous.controller,
        &missing_installation.installation,
        admit_all(),
    );

    let RebindResult::Unrealized {
        previous_binding_digest,
        previous_preserved,
        ..
    } = result
    else {
        panic!("expected unrealized result")
    };
    assert_eq!(previous_binding_digest, previous_digest);
    assert!(previous_preserved);
    assert!(!previous.controller.revoked());
    assert_eq!(
        block_on(call(&previous.binding, &projection, "input"))
            .unwrap_or_else(|error| panic!("{error}")),
        "still live"
    );

    for attempted_installation in [
        &incompatible_installation.installation,
        &revoked_installation.installation,
    ] {
        let result = rebind(
            &projection,
            previous_digest.clone(),
            &previous.controller,
            attempted_installation,
            admit_all(),
        );
        assert!(matches!(
            result,
            RebindResult::Unrealized {
                previous_preserved: true,
                ..
            }
        ));
        assert!(!previous.controller.revoked());
        assert_eq!(
            block_on(call(&previous.binding, &projection, "input"))
                .unwrap_or_else(|error| panic!("{error}")),
            "still live"
        );
    }
}

#[test]
fn slot_rebind_swaps_binding_and_failed_rebind_preserves_slot() {
    let projection = projection("value");
    let first_installation = installation("slot-first", "first");
    let next_installation = installation("slot-next", "second");
    let missing_installation = empty_installation("slot-missing");
    let slot = BindingSlot::new(
        projection.clone(),
        bound(&projection, &first_installation.installation),
    );
    let old_binding = slot.current();
    let old_manifest = slot.manifest();

    let transition = slot
        .rebind(&next_installation.installation, admit_all())
        .unwrap_or_else(|_| panic!("rebind should succeed"));
    assert_eq!(
        transition.previous_binding_digest,
        old_manifest.binding_digest().clone()
    );
    assert!(transition.previous_revoked);
    assert!(matches!(
        block_on(call(&old_binding, &projection, "input")),
        Err(CallerError::Revoked)
    ));
    assert_eq!(
        block_on(call(&slot.current(), &projection, "input"))
            .unwrap_or_else(|error| panic!("{error}")),
        "second"
    );

    let active = slot.current();
    let active_digest = slot.manifest().binding_digest().clone();
    let active_projection = slot.projection();
    let failed = slot.rebind(&missing_installation.installation, admit_all());
    assert!(matches!(failed, Err(UnrealizedReport { .. })));
    assert_eq!(slot.manifest().binding_digest(), &active_digest);
    assert_eq!(
        slot.projection().manifest().projection_digest(),
        active_projection.manifest().projection_digest()
    );
    assert!(!slot.revoked());
    assert_eq!(
        block_on(call(&active, &projection, "input")).unwrap_or_else(|error| panic!("{error}")),
        "second"
    );
    assert!(slot.revoke());
    assert!(slot.revoked());
    assert!(matches!(
        block_on(call(&slot.current(), &projection, "input")),
        Err(CallerError::Revoked)
    ));
}

#[test]
fn slot_rebind_projection_commits_projection_only_after_success() {
    let first_projection = projection("value");
    let next_projection = {
        let interaction = compile_interaction::<Read>().unwrap_or_else(|error| panic!("{error}"));
        let selection = select("renamed", &interaction, ProjectionModes::Direct)
            .unwrap_or_else(|error| panic!("{error}"));
        project([selection]).unwrap_or_else(|error| panic!("{error}"))
    };
    let install = installation("projection-swap", "renamed output");
    let missing = empty_installation("projection-swap-missing");
    let slot = BindingSlot::new(
        first_projection.clone(),
        bound(&first_projection, &install.installation),
    );
    let old_binding = slot.current();

    assert!(
        slot.rebind_projection(next_projection.clone(), &missing.installation, admit_all())
            .is_err()
    );
    assert_eq!(
        slot.projection().manifest().projection_digest(),
        first_projection.manifest().projection_digest()
    );
    assert!(!slot.revoked());

    let transition = slot
        .rebind_projection(next_projection.clone(), &install.installation, admit_all())
        .unwrap_or_else(|_| panic!("projection rebind should succeed"));
    assert!(transition.previous_revoked);
    assert_eq!(
        slot.projection().manifest().projection_digest(),
        next_projection.manifest().projection_digest()
    );
    assert!(matches!(
        block_on(call(&old_binding, &first_projection, "input")),
        Err(CallerError::Revoked)
    ));
    let next_handle = {
        let interaction = compile_interaction::<Read>().unwrap_or_else(|error| panic!("{error}"));
        slot.projection().handles().get("renamed", &interaction)
    };
    assert!(next_handle.is_ok());
}
