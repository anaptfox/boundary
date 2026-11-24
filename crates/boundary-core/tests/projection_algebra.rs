#![allow(unknown_lints, clippy::expect_used, clippy::unused_async_trait_impl)]

//! Laws for projection selection and set algebra.

use boundary_core::{
    ChangeFootprint, ChangesState, EmptyObjectCodec, Interaction, NoError, interaction_id,
    lifecycle::{ProjectError, ProjectionModes, compile_interaction, project, select},
};
#[derive(Debug, Default)]
struct Alpha;

impl Interaction for Alpha {
    const ID: boundary_core::StaticInteractionId = interaction_id!("algebra.alpha");
    type Output = Self;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = EmptyObjectCodec<Self>;
    type OutputCodec = EmptyObjectCodec<Self>;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&[], &["alpha"])
    }
}

#[derive(Debug, Default)]
struct Beta;

impl Interaction for Beta {
    const ID: boundary_core::StaticInteractionId = interaction_id!("algebra.beta");
    type Output = Self;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = EmptyObjectCodec<Self>;
    type OutputCodec = EmptyObjectCodec<Self>;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&[], &["beta"])
    }
}

fn alpha(alias: &str, modes: ProjectionModes) -> boundary_core::lifecycle::Projection {
    project([select(
        alias,
        &compile_interaction::<Alpha>().expect("compile"),
        modes,
    )
    .expect("select")])
    .expect("projection")
}

fn beta(alias: &str, modes: ProjectionModes) -> boundary_core::lifecycle::Projection {
    project([select(
        alias,
        &compile_interaction::<Beta>().expect("compile"),
        modes,
    )
    .expect("select")])
    .expect("projection")
}

#[test]
fn pick_resolves_alias_or_id_and_rejects_unknown_or_duplicate_keys() {
    let source = project([
        select(
            "a",
            &compile_interaction::<Alpha>().expect("compile"),
            ProjectionModes::Direct,
        )
        .expect("select"),
        select(
            "b",
            &compile_interaction::<Beta>().expect("compile"),
            ProjectionModes::Request,
        )
        .expect("select"),
    ])
    .expect("projection");
    assert_eq!(
        source
            .pick(&["a"])
            .expect("pick")
            .manifest()
            .interactions()
            .len(),
        1
    );
    assert_eq!(
        source
            .pick(&["algebra.beta"])
            .expect("pick")
            .manifest()
            .interactions()[0]
            .alias(),
        "b"
    );
    assert!(matches!(
        source.pick(&["missing"]),
        Err(ProjectError::UnknownSelection(_))
    ));
    assert!(matches!(
        source.pick(&["a", "algebra.alpha"]),
        Err(ProjectError::DuplicateSelection(_))
    ));
}

#[test]
fn omit_removes_by_alias_or_id() {
    let source = project([
        select(
            "a",
            &compile_interaction::<Alpha>().expect("compile"),
            ProjectionModes::Direct,
        )
        .expect("select"),
        select(
            "b",
            &compile_interaction::<Beta>().expect("compile"),
            ProjectionModes::Request,
        )
        .expect("select"),
    ])
    .expect("projection");
    let omitted = source.omit(&["algebra.alpha"]).expect("omit");
    assert_eq!(omitted.manifest().interactions().len(), 1);
    assert_eq!(omitted.manifest().interactions()[0].alias(), "b");
    assert!(matches!(
        source.omit(&["missing"]),
        Err(ProjectError::UnknownSelection(_))
    ));
    assert!(matches!(
        source.omit(&["a", "algebra.alpha"]),
        Err(ProjectError::DuplicateSelection(_))
    ));
}

#[test]
fn union_merges_modes_is_deterministic_and_rejects_conflicts() {
    let a = alpha("alpha", ProjectionModes::Direct);
    let b = alpha("alpha", ProjectionModes::Request);
    let merged = a.union(&b).expect("union");
    assert_eq!(
        merged.manifest().interactions()[0].modes(),
        ProjectionModes::DirectAndRequest
    );
    assert_eq!(
        merged.manifest().projection_digest(),
        b.union(&a).expect("reverse").manifest().projection_digest()
    );
    assert_eq!(
        merged.manifest().projection_digest(),
        alpha("alpha", ProjectionModes::DirectAndRequest)
            .manifest()
            .projection_digest()
    );

    assert_eq!(
        alpha("alpha", ProjectionModes::Direct)
            .union(&beta("beta", ProjectionModes::Request))
            .expect("disjoint")
            .manifest()
            .interactions()
            .len(),
        2
    );
    assert!(matches!(
        alpha("same", ProjectionModes::Direct).union(&beta("same", ProjectionModes::Direct)),
        Err(ProjectError::ConflictingAlias(_))
    ));
    assert!(matches!(
        alpha("first", ProjectionModes::Direct).union(&alpha("second", ProjectionModes::Direct)),
        Err(ProjectError::DuplicateInteraction(_))
    ));
}

#[test]
fn intersection_keeps_shared_modes_and_drops_empty_mode_sets() {
    let both = alpha("alpha", ProjectionModes::DirectAndRequest);
    let direct = alpha("alpha", ProjectionModes::Direct);
    assert_eq!(
        both.intersect(&direct)
            .expect("intersection")
            .manifest()
            .interactions()[0]
            .modes(),
        ProjectionModes::Direct
    );
    assert_eq!(
        alpha("alpha", ProjectionModes::Direct)
            .intersect(&alpha("alpha", ProjectionModes::Request))
            .expect("empty intersection")
            .manifest()
            .interactions(),
        []
    );
    assert!(matches!(
        alpha("same", ProjectionModes::Direct).intersect(&beta("same", ProjectionModes::Direct)),
        Err(ProjectError::ConflictingAlias(_))
    ));
}

#[test]
fn serde_round_trip_preserves_projection() {
    let original = alpha("alpha", ProjectionModes::DirectAndRequest);
    let encoded = serde_json::to_vec(&original).expect("serialize");
    let decoded: boundary_core::lifecycle::Projection =
        serde_json::from_slice(&encoded).expect("deserialize");
    assert_eq!(
        decoded.manifest().projection_digest(),
        original.manifest().projection_digest()
    );
    assert_eq!(
        decoded.manifest().interactions(),
        original.manifest().interactions()
    );
}
