//! Portable laws of Zod's normalized schemas, independent of a TypeScript runtime.
#![allow(clippy::expect_used)]

use boundary_core::{InteractionContract, PortableSchema};
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
#[serde(rename_all = "camelCase")]
struct Migration {
    before: Value,
    before_digest: String,
    after: Value,
    after_digest: String,
}
#[derive(Deserialize)]
struct Vectors {
    version: u8,
    cases: Vec<Case>,
    unsupported: Vec<Value>,
    migration: Migration,
}

#[test]
fn independently_validates_normalized_nullable_constraints() {
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/nullable-authoring.json"
    ))
    .expect("reviewed nullable vectors");
    assert_eq!(vectors.version, 1);
    for case in vectors.cases {
        let schema = PortableSchema::from_value(case.schema).expect("normalized portable schema");
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
    for unsupported in vectors.unsupported {
        assert!(
            PortableSchema::from_value(unsupported).is_err(),
            "native profile still refuses type arrays"
        );
    }
    let before: InteractionContract =
        serde_json::from_value(vectors.migration.before).expect("old contract");
    let after: InteractionContract =
        serde_json::from_value(vectors.migration.after).expect("normalized contract");
    assert_eq!(
        before.digest().expect("old digest").as_str(),
        vectors.migration.before_digest
    );
    assert_eq!(
        after.digest().expect("new digest").as_str(),
        vectors.migration.after_digest
    );
}
