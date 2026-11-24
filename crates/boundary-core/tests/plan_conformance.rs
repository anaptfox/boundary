//! Shared portable Plan v1 conformance vectors.

#![allow(unknown_lints, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use boundary_core::{
    InteractionContract, InteractionDescriptor, PortableSchema, Program,
    plan::{PlanBuilder, PlanError, PlanStep},
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Vectors {
    version: u8,
    program: Vec<ProgramVector>,
    valid: Vec<ValidVector>,
    invalid: Vec<InvalidVector>,
}

#[derive(Deserialize)]
struct ProgramVector {
    id: String,
    reads: Vec<String>,
    changes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidVector {
    name: String,
    plan: PlanSource,
    plan_digest: String,
    aggregate_footprints: Footprints,
    parallel_waves: Vec<Vec<String>>,
}

#[derive(Deserialize)]
struct InvalidVector {
    name: String,
    reason: String,
    plan: PlanSource,
}

#[derive(Deserialize)]
struct PlanSource {
    id: String,
    steps: Vec<PlanStep>,
}

#[derive(Deserialize, PartialEq, Debug)]
struct Footprints {
    reads: Vec<String>,
    changes: Vec<String>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("../../../tests/conformance/v1/plan.json"))
        .expect("reviewed plan vector")
}

fn program(entries: &[ProgramVector]) -> Program {
    let schema = PortableSchema::from_value(json!({"type":"object","additionalProperties":false}))
        .expect("portable schema");
    let descriptors = entries.iter().map(|entry| {
        let contract = InteractionContract::builder(&entry.id, schema.clone(), schema.clone())
            .reads(entry.reads.iter().map(String::as_str))
            .changes(entry.changes.iter().map(String::as_str))
            .finish()
            .expect("contract");
        InteractionDescriptor::builder(contract)
            .finish()
            .expect("descriptor")
    });
    let mut builder = Program::builder();
    for descriptor in descriptors {
        builder = builder.descriptor(descriptor).expect("unique contract");
    }
    builder.finish().expect("program")
}

fn build(source: PlanSource) -> Result<boundary_core::plan::Plan, PlanError> {
    PlanBuilder::new()
        .id(source.id)
        .steps(source.steps)
        .finish()
}

#[test]
fn every_shared_plan_vector_is_observed() {
    let vectors = vectors();
    assert_eq!(vectors.version, 1);
    let program = program(&vectors.program);
    for vector in vectors.valid {
        let plan = build(vector.plan).unwrap_or_else(|error| panic!("{}: {error}", vector.name));
        assert_eq!(
            plan.plan_digest().as_str(),
            vector.plan_digest,
            "{}",
            vector.name
        );
        let footprints = plan.aggregate_footprints(&program).expect("footprints");
        assert_eq!(
            json!({"reads": footprints.reads, "changes": footprints.changes}),
            json!({"reads": vector.aggregate_footprints.reads, "changes": vector.aggregate_footprints.changes}),
            "{}",
            vector.name
        );
        assert_eq!(
            plan.parallel_waves(&program).expect("waves"),
            vector.parallel_waves,
            "{}",
            vector.name
        );
    }
    for vector in vectors.invalid {
        let result = build(vector.plan);
        assert!(result.is_err(), "{} must be rejected", vector.name);
        match vector.reason.as_str() {
            "cycle" => assert!(
                matches!(result, Err(PlanError::CycleDetected)),
                "{}",
                vector.name
            ),
            "unknown-dependency" => assert!(
                matches!(result, Err(PlanError::UnknownDependency(_))),
                "{}",
                vector.name
            ),
            "duplicate-step" => assert!(
                matches!(result, Err(PlanError::DuplicateStep(_))),
                "{}",
                vector.name
            ),
            "conflicting-alias" => assert!(
                matches!(result, Err(PlanError::ConflictingAlias(_))),
                "{}",
                vector.name
            ),
            other => panic!("unknown vector reason: {other}"),
        }
    }
}
