//! Consumes the reviewed WIT projection vector.
//!
//! This test never writes the vector. If the projector changes the emitted
//! text, the vector is the reviewed decision and must change first.
//!
//! Each case is compared as one whole value rather than field by field, so a
//! projection that silently stops reporting something fails here.
#![allow(clippy::expect_used)]

use boundary_core::{InteractionContract, InteractionDescriptor, PortableSchema, Program};
use boundary_plugin::{WitProjection, WitProjectionError, WitProjectionOptions, project_wit};
use serde_json::{Value, json};

fn vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/wasm-projection.json"
    ))
    .expect("wasm-projection vector parses")
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .expect("array")
        .iter()
        .map(|entry| entry.as_str().expect("string").to_owned())
        .collect()
}

fn program_from(case: &Value) -> Program {
    let object = PortableSchema::from_value(json!({"type":"object","additionalProperties":false}))
        .expect("schema");
    case["interactions"]
        .as_array()
        .expect("interactions")
        .iter()
        .fold(Program::builder(), |builder, interaction| {
            let contract = InteractionContract::builder(
                interaction["id"].as_str().expect("id"),
                object.clone(),
                object.clone(),
            )
            .reads(strings(interaction, "reads"))
            .changes(strings(interaction, "changes"))
            .finish()
            .expect("contract");
            let descriptor = InteractionDescriptor::builder(contract)
                .finish()
                .expect("descriptor");
            builder.descriptor(descriptor).expect("accepted")
        })
        .finish()
        .expect("program")
}

fn options_from(vector: &Value) -> WitProjectionOptions {
    let options = &vector["options"];
    WitProjectionOptions {
        package: options["package"].as_str().expect("package").to_owned(),
        version: options["version"].as_str().expect("version").to_owned(),
        world: options["world"].as_str().expect("world").to_owned(),
        imports_interface: options["importsInterface"]
            .as_str()
            .expect("importsInterface")
            .to_owned(),
    }
}

/// Renders an outcome in the same shape the reviewed vector records, so the
/// comparison is one `assert_eq!` over the whole reviewed expectation.
fn observed(result: &Result<WitProjection, WitProjectionError>) -> Value {
    match result {
        Ok(projection) => json!({
            "status": "projected",
            "wit": projection.wit,
            "footprints": projection.footprints,
            "interactions": projection
                .interactions
                .iter()
                .map(|interaction| json!({
                    "witName": interaction.wit_name,
                    "interactionId": interaction.interaction_id,
                    "contractDigest": interaction.contract_digest,
                }))
                .collect::<Vec<_>>(),
        }),
        Err(WitProjectionError::Collision { name, interactions }) => json!({
            "status": "collision",
            "witName": name,
            "interactionIds": interactions,
        }),
        Err(WitProjectionError::Names(errors)) => json!({
            "status": "unspellable",
            "interactionIds": errors
                .iter()
                .map(|error| error.interaction_id.clone())
                .collect::<Vec<_>>(),
        }),
        Err(WitProjectionError::Footprint { footprint, .. }) => json!({
            "status": "footprint",
            "footprint": footprint,
        }),
        Err(WitProjectionError::FootprintCollision { name, footprints }) => json!({
            "status": "footprint-collision",
            "witName": name,
            "footprints": footprints,
        }),
    }
}

#[test]
fn every_reviewed_case_matches_exactly() {
    let vector = vector();
    let options = options_from(&vector);
    let cases = vector["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "the vector must carry cases");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let program = program_from(case);
        let result = project_wit(&program, &options);

        assert_eq!(
            observed(&result),
            case["expected"],
            "case {name}: outcome must match the reviewed expectation exactly"
        );

        if let Ok(projection) = &result {
            assert_eq!(
                projection.program_digest,
                case["programDigest"].as_str().expect("programDigest"),
                "case {name}: program digest"
            );
        }
    }
}

#[test]
fn the_vector_covers_both_success_and_refusal() {
    let vector = vector();
    let statuses: Vec<&str> = vector["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| case["expected"]["status"].as_str().expect("status"))
        .collect();
    assert!(statuses.contains(&"projected"), "{statuses:?}");
    assert!(statuses.contains(&"collision"), "{statuses:?}");
    assert!(statuses.contains(&"unspellable"), "{statuses:?}");
}
