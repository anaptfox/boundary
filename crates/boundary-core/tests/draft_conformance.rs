//! Consumes the reviewed Draft vector.
//!
//! A Draft proposes a full interaction contract that does not exist yet. These
//! tests hold it to one reviewed identity so a TypeScript host and a Rust
//! host issue drafts the other can read.
#![allow(clippy::expect_used)]

use boundary_core::{Draft, InteractionContract, PortableSchema, ProgramErrorCode, SchemaType};
use serde_json::Value;

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../tests/conformance/v1/draft.json"))
        .expect("draft vector parses")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().expect("reviewed field is a string")
}

/// Deserializes a reviewed contract value the same way a wire contract
/// arrives: through [`InteractionContract`]'s own validating `Deserialize`.
fn contract_from(value: &Value) -> Result<InteractionContract, serde_json::Error> {
    serde_json::from_value(value.clone())
}

#[test]
fn every_reviewed_draft_matches_its_digest() {
    let vector = vector();
    let cases = vector["cases"].as_array().expect("cases");
    assert_ne!(cases.as_slice(), [] as [serde_json::Value; 0]);

    for case in cases {
        let name = text(case, "name");
        let input = &case["input"];
        let contract = contract_from(&input["contract"])
            .unwrap_or_else(|error| unreachable!("case {name} must build a contract: {error}"));

        let draft = Draft::new(
            contract,
            text(input, "gap"),
            text(input, "proposer"),
            text(input, "createdAt"),
        )
        .unwrap_or_else(|error| unreachable!("case {name} must build: {error}"));

        assert_eq!(
            draft.draft_digest().as_str(),
            text(&case["expected"], "draftDigest"),
            "case {name}: digest"
        );
        draft
            .verify()
            .unwrap_or_else(|error| unreachable!("case {name} must verify: {error}"));
    }
}

#[test]
fn distinct_drafts_are_distinct_digests() {
    let vector = vector();
    let cases = vector["cases"].as_array().expect("cases");
    let mut digests: Vec<&str> = cases
        .iter()
        .map(|case| text(&case["expected"], "draftDigest"))
        .collect();
    digests.sort_unstable();
    digests.dedup();
    assert_eq!(digests.len(), cases.len());
}

#[test]
fn every_reviewed_refusal_is_refused() {
    let vector = vector();
    for case in vector["refusals"].as_array().expect("refusals") {
        let name = text(case, "name");
        let status = text(&case["expected"], "status");

        let contract = contract_from(&case["contract"]);

        if status == "invalid-contract" {
            contract
                .err()
                .unwrap_or_else(|| unreachable!("case {name} must refuse contract construction"));
            continue;
        }

        let contract = contract
            .unwrap_or_else(|error| unreachable!("case {name} must build a contract: {error}"));
        let error = Draft::new(
            contract,
            text(case, "gap"),
            text(case, "proposer"),
            text(case, "createdAt"),
        )
        .err()
        .unwrap_or_else(|| unreachable!("case {name} must be refused"));

        match status {
            "empty-gap" => assert_eq!(error.code(), ProgramErrorCode::EmptyGap, "case {name}"),
            "empty-proposer" => {
                assert_eq!(error.code(), ProgramErrorCode::EmptyProposer, "case {name}");
            }
            "invalid-created-at" => {
                assert_eq!(
                    error.code(),
                    ProgramErrorCode::InvalidTimestamp,
                    "case {name}"
                );
            }
            other => unreachable!("unknown reviewed refusal status {other:?}"),
        }
    }
}

#[test]
fn a_draft_survives_serialization_and_still_verifies() {
    let contract = InteractionContract::builder(
        "todos.archive",
        PortableSchema::of_type(SchemaType::Object),
        PortableSchema::of_type(SchemaType::Object),
    )
    .reads(["todos"])
    .changes(["todos"])
    .finish()
    .expect("contract");

    let draft = Draft::new(contract, "a gap", "agent:test", "2026-09-06T12:00:00Z").expect("draft");

    let encoded = serde_json::to_string(&draft).expect("serializes");
    let decoded: Draft = serde_json::from_str(&encoded).expect("deserializes");
    assert_eq!(decoded, draft);
    decoded.verify().expect("a round-tripped draft verifies");
}

#[test]
fn a_tampered_draft_fails_verification() {
    let contract = InteractionContract::builder(
        "todos.archive",
        PortableSchema::of_type(SchemaType::Object),
        PortableSchema::of_type(SchemaType::Object),
    )
    .reads(["todos"])
    .changes(["todos"])
    .finish()
    .expect("contract");

    let draft = Draft::new(contract, "a gap", "agent:test", "2026-09-06T12:00:00Z").expect("draft");

    let mut raw: Value = serde_json::to_value(&draft).expect("to value");
    raw["gap"] = Value::String("a different gap entirely".to_owned());
    let tampered: Draft = serde_json::from_value(raw).expect("deserializes");

    assert!(tampered.verify().is_err());
}

#[test]
fn a_draft_is_not_callable_and_carries_no_authority() {
    let contract = InteractionContract::builder(
        "todos.archive",
        PortableSchema::of_type(SchemaType::Object),
        PortableSchema::of_type(SchemaType::Object),
    )
    .reads(["todos"])
    .changes(["todos"])
    .finish()
    .expect("contract");

    let draft = Draft::new(contract, "a gap", "agent:test", "2026-09-06T12:00:00Z").expect("draft");

    let raw = serde_json::to_value(&draft).expect("to value");
    let object = raw.as_object().expect("object");
    for forbidden in [
        "context",
        "credentials",
        "token",
        "admission",
        "grant",
        "policy",
        "actor",
    ] {
        assert!(
            !object.contains_key(forbidden),
            "a draft must not carry {forbidden}"
        );
    }
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "contract",
            "createdAt",
            "draftDigest",
            "gap",
            "proposer",
            "version",
        ]
    );
}
