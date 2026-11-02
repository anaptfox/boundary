//! Reviewed evidence is consumed independently by the native Rust implementation.
#![allow(clippy::expect_used)]

use boundary_core::evidence::{
    ExecutionEvidence, ExecutionEvidencePublication, publish_execution_evidence,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Patch {
    path: Vec<String>,
    value: Value,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    patches: Vec<Patch>,
    valid: bool,
}
#[derive(Deserialize)]
struct Vectors {
    version: u8,
    base: Value,
    cases: Vec<Case>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/execution-evidence.json"
    ))
    .expect("reviewed evidence vectors")
}

fn apply(base: &Value, case: &Case) -> Value {
    let mut value = base.clone();
    for patch in &case.patches {
        let mut parent = &mut value;
        for segment in &patch.path[..patch.path.len() - 1] {
            parent = parent.get_mut(segment).expect("known reviewed path");
        }
        parent.as_object_mut().expect("object patch parent").insert(
            patch.path.last().expect("nonempty patch path").clone(),
            patch.value.clone(),
        );
    }
    value
}

#[test]
fn consumes_shared_causal_evidence_laws() {
    let vectors = vectors();
    assert_eq!(vectors.version, 1);
    for case in vectors.cases {
        let value = apply(&vectors.base, &case);
        let checked = ExecutionEvidence::from_value(value.clone());
        assert_eq!(checked.is_ok(), case.valid, "{}", case.name);
        assert_eq!(
            serde_json::from_value::<ExecutionEvidence>(value.clone()).is_ok(),
            case.valid,
            "{} via Deserialize",
            case.name
        );
        if let Ok(checked) = checked {
            assert_eq!(
                checked.as_value(),
                &value,
                "{}: facts remain unchanged",
                case.name
            );
        }
    }
}

#[test]
fn completed_invocation_and_uncertain_subject_survive_failed_publication() {
    let vectors = vectors();
    let input = apply(&vectors.base, &vectors.cases[1]);
    let evidence =
        ExecutionEvidence::from_value(input.clone()).expect("valid uncertain subject evidence");
    let mut deliveries = 0;
    let result = futures::executor::block_on(publish_execution_evidence(evidence, |published| {
        deliveries += 1;
        assert_eq!(
            published.as_value()["invocation"]["observation"]["certainty"],
            "completed"
        );
        assert_eq!(published.as_value()["subject"]["state"], "uncertain");
        async { Err("publisher unavailable") }
    }));
    assert_eq!(deliveries, 1);
    assert!(matches!(
        &result,
        ExecutionEvidencePublication::DeliveryFailed { .. }
    ));
    if let ExecutionEvidencePublication::DeliveryFailed { evidence, cause } = result {
        assert_eq!(cause, "publisher unavailable");
        assert_eq!(evidence.as_value(), &input);
    }
}

#[test]
fn missing_subject_stays_missing_and_link_collections_are_bounded() {
    let vectors = vectors();
    let minimal = ExecutionEvidence::from_value(vectors.base.clone()).expect("minimal evidence");
    assert!(minimal.as_value().get("subject").is_none());
    let mut oversized = vectors.base;
    oversized["parents"] = Value::Array((0..129).map(|index| json!({"kind":"evidence","namespace":"owner-1","id":format!("older-{index}")})).collect());
    assert!(ExecutionEvidence::from_value(oversized).is_err());
}
