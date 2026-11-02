//! Shared contract-compatibility vectors consumed by Rust and TypeScript.
#![allow(clippy::expect_used)]

use boundary_core::{Compatibility, InteractionContract, contract_compatibility};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
struct Vectors {
    version: u8,
    defaults: Value,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    compatible: bool,
    expected: Value,
    offered: Value,
}

fn overlay(defaults: &Value, partial: &Value) -> InteractionContract {
    let mut merged: Map<String, Value> = defaults.as_object().expect("defaults object").clone();
    if let Some(fields) = partial.as_object() {
        for (key, value) in fields {
            merged.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(Value::Object(merged)).expect("valid overlaid contract")
}

#[test]
fn shared_v1_contract_compatibility_vectors() {
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/contract-compatibility.json"
    ))
    .expect("valid frozen vectors");
    assert_eq!(vectors.version, 1);
    assert!(!vectors.cases.is_empty());

    for case in &vectors.cases {
        let expected = overlay(&vectors.defaults, &case.expected);
        let offered = overlay(&vectors.defaults, &case.offered);
        let result = contract_compatibility(&expected, &offered);
        assert_eq!(
            result.is_compatible(),
            case.compatible,
            "{}: {result:?}",
            case.name
        );
        if case.compatible {
            assert_eq!(result, Compatibility::Compatible, "{}", case.name);
        }
    }
}

fn schema_pair(field: &str, expected: Value, offered: Value) -> bool {
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/contract-compatibility.json"
    ))
    .expect("valid frozen vectors");
    let single =
        |value: Value| Value::Object(serde_json::Map::from_iter([(field.to_owned(), value)]));
    let expected = overlay(&vectors.defaults, &single(expected));
    let offered = overlay(&vectors.defaults, &single(offered));
    contract_compatibility(&expected, &offered).is_compatible()
}

#[test]
fn positional_checks_are_bounded_by_the_offered_arity() {
    use serde_json::json;
    let pair =
        json!({"type":"array","prefixItems":[{"type":"string"},{"type":"string"}],"items":false});
    let mismatched = |max: u64| json!({"type":"array","prefixItems":[{"type":"string"},{"type":"number"}],"maxItems":max});
    assert!(schema_pair("outputSchema", pair.clone(), mismatched(1)));
    assert!(!schema_pair("outputSchema", pair.clone(), mismatched(2)));
    assert!(schema_pair(
        "outputSchema",
        json!({"type":"array","maxItems":2}),
        pair.clone()
    ));
    assert!(!schema_pair(
        "outputSchema",
        json!({"type":"array","maxItems":1}),
        pair
    ));
}

#[test]
fn record_value_domains_and_optional_names_are_compared() {
    use serde_json::json;
    let strings = json!({"type":"object","additionalProperties":{"type":"string"}});
    let numbers = json!({"type":"object","additionalProperties":{"type":"number"}});
    let short = json!({"type":"object","additionalProperties":{"type":"string","maxLength":1}});
    assert!(!schema_pair(
        "inputSchema",
        strings.clone(),
        numbers.clone()
    ));
    assert!(!schema_pair("outputSchema", strings.clone(), numbers));
    assert!(!schema_pair("inputSchema", strings.clone(), short.clone()));
    assert!(schema_pair("outputSchema", strings, short));

    let optional = json!({"type":"object","properties":{"note":{"type":"string"}}});
    assert!(!schema_pair(
        "outputSchema",
        optional.clone(),
        json!({"type":"object","additionalProperties":{"type":"number"}})
    ));
    assert!(schema_pair(
        "outputSchema",
        optional.clone(),
        json!({"type":"object","additionalProperties":{"type":"string"}})
    ));
    assert!(schema_pair(
        "outputSchema",
        optional,
        json!({"type":"object","propertyNames":{"type":"string","pattern":"^x"},"additionalProperties":{"type":"number"}})
    ));
    assert!(schema_pair(
        "outputSchema",
        json!({"type":"object","propertyNames":{"type":"string","minLength":1},"additionalProperties":{"type":"string"}}),
        json!({"type":"object","propertyNames":{"minLength":2},"additionalProperties":{"type":"string"}})
    ));
}
