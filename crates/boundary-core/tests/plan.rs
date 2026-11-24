#![allow(
    unknown_lints,
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::unused_async_trait_impl
)]

//! Laws for the static handler-free Plan algebra.

use std::collections::BTreeMap;

use boundary_core::{
    EmptyObjectCodec, Handler, Interaction, InteractionContract, InteractionDescriptor,
    InteractionId, NoError, PortableSchema, Program, ReadFootprint, ReadOnly, interaction_id,
    lifecycle::{
        BindResult, InstallationId, ProjectionModes, RealizationId, admit_all, bind,
        compile_interaction, direct_realization, install, project, select,
    },
    plan::{
        Plan, PlanBuilder, PlanDigest, PlanError, PlanInputBinding, PlanStep, PreflightIssueReason,
    },
};
use serde_json::json;

fn schema() -> PortableSchema {
    PortableSchema::from_value(json!({"type":"object","additionalProperties":false}))
        .expect("schema")
}

fn program(entries: &[(&str, &[&str], &[&str])]) -> Program {
    let mut builder = Program::builder();
    for (id, reads, changes) in entries {
        let contract = InteractionContract::builder(id, schema(), schema())
            .reads(reads.iter().copied())
            .changes(changes.iter().copied())
            .finish()
            .expect("contract");
        builder = builder
            .descriptor(
                InteractionDescriptor::builder(contract)
                    .finish()
                    .expect("descriptor"),
            )
            .expect("add descriptor");
    }
    builder.finish().expect("program")
}

fn step(
    id: &str,
    interaction: &str,
    alias: &str,
    mode: boundary_core::lifecycle::InteractionMode,
) -> PlanStep {
    PlanStep {
        id: id.into(),
        alias: alias.into(),
        interaction_id: InteractionId::parse(interaction).expect("interaction id"),
        mode,
        inputs: BTreeMap::new(),
        depends_on: Vec::new(),
    }
}

fn plan(steps: Vec<PlanStep>) -> Result<Plan, PlanError> {
    PlanBuilder::new().id("test-plan").steps(steps).finish()
}

#[test]
fn validates_dag_ids_aliases_and_cycles() {
    let mut a = step(
        "a",
        "test.a",
        "a",
        boundary_core::lifecycle::InteractionMode::Direct,
    );
    let mut b = step(
        "b",
        "test.b",
        "b",
        boundary_core::lifecycle::InteractionMode::Direct,
    );
    a.depends_on.push("b".into());
    b.depends_on.push("a".into());
    assert!(matches!(plan(vec![a, b]), Err(PlanError::CycleDetected)));
    assert!(matches!(
        plan(vec![{
            let mut s = step(
                "a",
                "test.a",
                "a",
                boundary_core::lifecycle::InteractionMode::Direct,
            );
            s.depends_on.push("missing".into());
            s
        }]),
        Err(PlanError::UnknownDependency(_))
    ));
    assert!(matches!(
        plan(vec![
            step(
                "a",
                "test.a",
                "a",
                boundary_core::lifecycle::InteractionMode::Direct
            ),
            step(
                "a",
                "test.b",
                "b",
                boundary_core::lifecycle::InteractionMode::Direct
            )
        ]),
        Err(PlanError::DuplicateStep(_))
    ));
    assert!(matches!(
        plan(vec![
            step(
                "a",
                "test.a",
                "same",
                boundary_core::lifecycle::InteractionMode::Direct
            ),
            step(
                "b",
                "test.b",
                "same",
                boundary_core::lifecycle::InteractionMode::Direct
            )
        ]),
        Err(PlanError::ConflictingAlias(_))
    ));
}

#[test]
fn digest_and_serde_round_trip_are_deterministic() {
    let a = plan(vec![
        step(
            "b",
            "test.b",
            "b",
            boundary_core::lifecycle::InteractionMode::Direct,
        ),
        step(
            "a",
            "test.a",
            "a",
            boundary_core::lifecycle::InteractionMode::Direct,
        ),
    ])
    .expect("plan");
    let b = plan(vec![
        step(
            "a",
            "test.a",
            "a",
            boundary_core::lifecycle::InteractionMode::Direct,
        ),
        step(
            "b",
            "test.b",
            "b",
            boundary_core::lifecycle::InteractionMode::Direct,
        ),
    ])
    .expect("plan");
    assert_eq!(a.plan_digest(), b.plan_digest());
    let encoded = serde_json::to_string(&a).expect("serialize");
    let decoded: Plan = serde_json::from_str(&encoded).expect("deserialize");
    assert_eq!(a, decoded);
    assert!(PlanDigest::parse("sha256:bad").is_err());
}

#[test]
fn footprints_and_parallel_waves_respect_hazards_and_data_edges() {
    use boundary_core::lifecycle::InteractionMode::Direct;
    let p = program(&[
        ("test.read1", &["shared"], &[]),
        ("test.read2", &["shared"], &[]),
        ("test.write", &[], &["shared"]),
        ("test.other", &[], &["elsewhere"]),
    ]);
    let independent = plan(vec![
        step("a", "test.read1", "a", Direct),
        step("b", "test.read2", "b", Direct),
    ])
    .expect("plan");
    assert_eq!(
        independent.parallel_waves(&p).expect("waves"),
        vec![vec!["a", "b"]]
    );
    let conflict = plan(vec![
        step("a", "test.read1", "a", Direct),
        step("b", "test.write", "b", Direct),
        step("c", "test.write", "c", Direct),
    ])
    .expect("plan");
    assert_eq!(
        conflict.parallel_waves(&p).expect("waves"),
        vec![vec!["a"], vec!["b"], vec!["c"]]
    );
    assert_eq!(
        conflict.aggregate_footprints(&p).expect("footprints").reads,
        vec!["shared"]
    );
    let mut b = step("b", "test.other", "b", Direct);
    b.inputs.insert(
        "value".into(),
        PlanInputBinding::StepOutput {
            step_id: "a".into(),
            path: Some("value".into()),
        },
    );
    let data = plan(vec![b, step("a", "test.other", "a", Direct)]).expect("plan");
    assert_eq!(
        data.parallel_waves(&p).expect("waves"),
        vec![vec!["a"], vec!["b"]]
    );
}

#[test]
fn required_projection_is_minimal_and_merges_modes() {
    use boundary_core::lifecycle::InteractionMode::{Direct, Request};
    let p = program(&[("test.a", &[], &[]), ("test.unused", &[], &[])]);
    let selected = plan(vec![
        step("a", "test.a", "a", Direct),
        step("b", "test.a", "a", Request),
    ])
    .expect("plan");
    assert_eq!(
        selected
            .required_projection_selections(&p)
            .expect("requirements")
            .len(),
        1
    );
    let projection = selected.required_projection(&p).expect("projection");
    assert_eq!(projection.manifest().program().interactions().len(), 1);
    assert_eq!(
        projection.manifest().interactions()[0].modes(),
        ProjectionModes::DirectAndRequest
    );
    assert!(
        projection
            .manifest()
            .projection_digest()
            .as_str()
            .starts_with("sha256:")
    );
}

#[derive(Debug, Default)]
struct ReadOp;
impl Interaction for ReadOp {
    const ID: boundary_core::StaticInteractionId = interaction_id!("plan.read");
    type Output = Self;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = EmptyObjectCodec<Self>;
    type OutputCodec = EmptyObjectCodec<Self>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["read"])
    }
}
struct ReadHandler;
impl Handler<ReadOp, ()> for ReadHandler {
    async fn handle(&self, _context: &(), _interaction: ReadOp) -> Result<ReadOp, NoError> {
        Ok(ReadOp)
    }
}

#[test]
fn preflight_collects_every_missing_alias_and_mode_issue() {
    use boundary_core::lifecycle::InteractionMode::{Direct, Request};
    let compiled = compile_interaction::<ReadOp>().expect("compiled");
    let projection =
        project([select("read", &compiled, ProjectionModes::Direct).expect("selection")])
            .expect("projection");
    let installation = install(
        InstallationId::new("host/plan").expect("installation id"),
        [direct_realization(
            &compiled,
            RealizationId::new("host/read").expect("realization"),
            ReadHandler,
        )],
    )
    .expect("installation");
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(bound) => bound.binding,
        BindResult::Unrealized(_) => panic!("binding should be complete"),
    };
    let ready_plan = plan(vec![step("ready", "plan.read", "read", Direct)]).expect("ready plan");
    assert!(
        ready_plan
            .preflight(&binding, Some(binding.manifest().expected_program()))
            .is_ready()
    );
    let plan = plan(vec![
        step("a", "plan.read", "read", Direct),
        step("b", "plan.missing", "missing", Direct),
        step("c", "plan.read", "read", Request),
        step("d", "plan.read", "wrong-alias", Direct),
    ])
    .expect("plan");
    let report = plan.preflight_manifest(binding.manifest(), None);
    assert!(!report.is_ready());
    assert_eq!(report.issues.len(), 3);
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.reason == PreflightIssueReason::MissingInteraction)
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.reason == PreflightIssueReason::ModeNotBound)
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.reason == PreflightIssueReason::AliasMismatch)
    );
}
