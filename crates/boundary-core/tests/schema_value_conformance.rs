//! Reviewed portable value equality, independently evaluated by Rust and TypeScript.
#![allow(clippy::expect_used)]

use boundary_core::{PortableSchema, ProgramErrorCode};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    version: u8,
    cases: Vec<InstanceCase>,
    refused_schemas: Vec<RefusedSchema>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceCase {
    name: String,
    schema_json: String,
    value_json: String,
    accepted: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefusedSchema {
    name: String,
    schema_json: String,
}
fn evidence() -> Result<Evidence, serde_json::Error> {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/schema-values.json"
    ))
}

#[test]
fn raw_json_instances_obey_reviewed_portable_equality() -> Result<(), Box<dyn std::error::Error>> {
    let evidence = evidence()?;
    assert_eq!(evidence.version, 1);
    for case in evidence.cases {
        let schema = PortableSchema::from_json_str(&case.schema_json)?;
        // Ordinary wire decoding preserves serde_json's distinct integer and
        // floating representations. The schema checker must compare values.
        let value: Value = serde_json::from_str(&case.value_json)?;
        assert_eq!(schema.accepts(&value), case.accepted, "{}", case.name);
        let roundtrip: Value = serde_json::from_slice(&serde_json::to_vec(&value)?)?;
        assert_eq!(
            schema.accepts(&roundtrip),
            case.accepted,
            "{} after JSON roundtrip",
            case.name
        );
    }
    Ok(())
}

#[test]
fn numerically_duplicate_enum_declarations_are_refused() -> Result<(), Box<dyn std::error::Error>> {
    for case in evidence()?.refused_schemas {
        let error = PortableSchema::from_json_str(&case.schema_json)
            .expect_err("duplicate portable enum values must fail compilation");
        assert_eq!(
            error.code(),
            ProgramErrorCode::InvalidSchema,
            "{}",
            case.name
        );
    }
    Ok(())
}
