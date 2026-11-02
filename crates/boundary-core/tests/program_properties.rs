//! Property checks for canonical values, identifiers, and schema normalization.
#![allow(clippy::expect_used)]

use std::collections::BTreeMap;

use boundary_core::{InteractionId, PortableSchema, canonical_json};
use proptest::prelude::*;
use serde_json::{Map, Number, Value};

proptest! {
    #[test]
    fn canonical_object_order_depends_only_on_utf8_bytes(entries in prop::collection::btree_map("[a-z]{1,8}", any::<i32>(), 0..24)) {
        let forward = Value::Object(entries.iter().map(|(key, value)| (key.clone(), Value::from(*value))).collect());
        let reverse = Value::Object(entries.iter().rev().map(|(key, value)| (key.clone(), Value::from(*value))).collect());
        prop_assert_eq!(canonical_json(&forward), canonical_json(&reverse));
    }

    #[test]
    fn finite_number_canonicalization_is_deterministic_and_valid_json(value in any::<f64>().prop_filter("finite", |value| value.is_finite())) {
        let Some(number) = Number::from_f64(value) else { return Ok(()) };
        let input = Value::Number(number);
        let first = canonical_json(&input).expect("canonical number");
        let second = canonical_json(&input).expect("canonical number again");
        let _: Value = serde_json::from_str(&first).expect("canonical output parses");
        prop_assert_eq!(second, first);
    }

    #[test]
    fn generated_v1_interaction_tokens_validate(value in "[A-Za-z0-9][A-Za-z0-9._~-]{0,40}") {
        let parsed = InteractionId::parse(&value).expect("valid generated id");
        prop_assert_eq!(parsed.as_str(), value);
    }

    #[test]
    fn property_map_normalization_is_stable(properties in prop::collection::btree_map("[a-z]{1,8}", "(string|number|boolean)", 0..16)) {
        let property_values: Map<_, _> = properties.into_iter().map(|(name, kind)| {
            (name, serde_json::json!({"type":kind}))
        }).collect();
        let schema = PortableSchema::from_value(serde_json::json!({"type":"object","properties":property_values})).expect("schema");
        let encoded = canonical_json(schema.as_value()).expect("canonical schema");
        let reparsed = PortableSchema::from_json_str(&encoded).expect("reparse schema");
        prop_assert_eq!(schema, reparsed);
    }
}

#[test]
fn utf8_key_order_is_not_locale_dependent() {
    let values: BTreeMap<_, _> = [("é", 1), ("z", 2), ("aa", 3)].into_iter().collect();
    let object = Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key.to_owned(), Value::from(value)))
            .collect(),
    );
    assert_eq!(
        canonical_json(&object).expect("canonical"),
        r#"{"aa":3,"z":2,"é":1}"#
    );
}
