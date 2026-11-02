//! Portable tuple and record laws shared with TypeScript, judged natively.
#![allow(clippy::expect_used, clippy::panic)]

use boundary_core::PortableSchema;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Sample {
    value: Value,
    valid: bool,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    schema: Value,
    values: Vec<Sample>,
}
#[derive(Deserialize)]
struct Authoring {
    name: String,
    contract: Value,
}
#[derive(Deserialize)]
struct Vectors {
    version: u8,
    cases: Vec<Case>,
    invalid: Vec<Value>,
    authoring: Vec<Authoring>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/portable-collections.json"
    ))
    .expect("reviewed collection vectors")
}

#[test]
fn independently_evaluates_tuples_and_records() {
    let vectors = vectors();
    assert_eq!(vectors.version, 1);
    for case in vectors.cases {
        let schema = PortableSchema::from_value(case.schema).expect("portable collection schema");
        for sample in case.values {
            assert_eq!(
                schema.accepts(&sample.value),
                sample.valid,
                "{}: {}",
                case.name,
                sample.value
            );
        }
    }
}

#[test]
fn refuses_malformed_collection_keywords() {
    for schema in vectors().invalid {
        assert!(
            PortableSchema::from_value(schema.clone()).is_err(),
            "accepted {schema}"
        );
    }
}

#[cfg(feature = "schemars")]
#[test]
fn rust_tuples_and_maps_author_the_reviewed_contracts() {
    for authoring in vectors().authoring {
        let native = match authoring.name.as_str() {
            "byte-string-tuple" => PortableSchema::for_type::<(u8, String)>(),
            "string-byte-record" => {
                PortableSchema::for_type::<std::collections::BTreeMap<String, u8>>()
            }
            other => panic!("no Rust authoring for {other}"),
        }
        .expect("Schemars output lowers into the profile");
        let reviewed = PortableSchema::from_value(authoring.contract).expect("reviewed contract");
        assert_eq!(native, reviewed, "{}", authoring.name);
    }
}
