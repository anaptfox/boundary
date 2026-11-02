//! Portable schema profile and Schemars adapter tests.
#![allow(dead_code)]
#![allow(clippy::expect_used)]

use boundary_core::{PortableSchema, ProgramErrorCode};
use serde_json::json;

#[test]
fn complete_v1_keyword_profile_compiles() {
    PortableSchema::from_value(json!({
        "type":"array",
        "items":{
            "allOf":[
                {"type":"string","minLength":1,"maxLength":20,"pattern":"^[a-z]+$"},
                {"not":{"const":"forbidden"}}
            ]
        },
        "minItems":1,
        "maxItems":5,
        "uniqueItems":true,
        "anyOf":[{"const":["a"]},{"enum":[["b"],["c"]]}],
        "oneOf":[{"type":"array"},{"const":null}]
    }))
    .expect("all supported keywords compile");

    PortableSchema::from_value(json!({
        "type":"number",
        "minimum":0,
        "maximum":10,
        "exclusiveMinimum":-1,
        "exclusiveMaximum":11
    }))
    .expect("numeric bounds compile");

    PortableSchema::from_value(json!({
        "type":"object",
        "properties":{"value":{"type":"integer"}},
        "required":["value"],
        "additionalProperties":{"type":"boolean"}
    }))
    .expect("object profile compiles");
}

#[test]
fn unsupported_and_malformed_schema_constructs_fail_closed() {
    for keyword in ["$ref", "$defs", "format", "default"] {
        let error = PortableSchema::from_value(json!({keyword: "unsupported"}))
            .expect_err("keyword must fail");
        assert_eq!(
            error.code(),
            ProgramErrorCode::UnsupportedSchema,
            "{keyword}"
        );
    }
    for schema in [
        json!({"pattern":"["}),
        json!({"required":["id","id"]}),
        json!({"enum":[{"a":1},{"a":1}]}),
        json!({"anyOf":[]}),
        json!({"minItems":3,"maxItems":2}),
        json!({"uniqueItems":"yes"}),
    ] {
        let error = PortableSchema::from_value(schema).expect_err("malformed schema must fail");
        assert_eq!(error.code(), ProgramErrorCode::InvalidSchema);
    }
}

#[test]
fn compiled_schema_ast_validates_portable_instances() {
    let schema = PortableSchema::from_value(json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "minLength": 2, "pattern": "^[a-z]+$" },
            "scores": {
                "type": "array",
                "items": { "type": "integer", "minimum": 0, "maximum": 10 },
                "minItems": 1,
                "uniqueItems": true
            },
            "state": { "oneOf": [{ "const": "open" }, { "const": "closed" }] }
        },
        "required": ["name", "scores", "state"],
        "additionalProperties": false,
        "not": {
            "type": "object",
            "properties": { "name": { "const": "forbidden" } },
            "required": ["name"]
        }
    }))
    .expect("portable schema");

    assert!(schema.accepts(&json!({
        "name": "valid",
        "scores": [0, 10],
        "state": "open"
    })));
    for invalid in [
        json!({"name":"V","scores":[1],"state":"open"}),
        json!({"name":"valid","scores":[11],"state":"open"}),
        json!({"name":"valid","scores":[1,1],"state":"open"}),
        json!({"name":"valid","scores":[1],"state":"other"}),
        json!({"name":"valid","scores":[1],"state":"open","extra":true}),
        json!({"name":"forbidden","scores":[1],"state":"closed"}),
    ] {
        assert!(!schema.accepts(&invalid), "{invalid}");
    }
}

#[test]
fn unique_items_preserves_value_equality() {
    let schema =
        PortableSchema::from_value(json!({"uniqueItems": true})).expect("unique array schema");
    for (items, expected) in [
        (json!([]), true),
        (json!([1, 1.0]), false),
        (json!([0.0, -0.0]), false),
        (json!([null, false, 0, "0", [], {}]), true),
        (json!([{"a": 1, "b": [2]}, {"b": [2.0], "a": 1.0}]), false),
        (json!([[1, {"x": true}], [1.0, {"x": false}]]), true),
        (json!([1, 1, 2, 3]), false),
    ] {
        assert_eq!(schema.accepts(&items), expected, "{items}");
    }
    let mut values: Vec<_> = (0..5_000).map(serde_json::Value::from).collect();
    assert!(schema.accepts(&json!(values)));
    values.push(json!(4_999));
    assert!(!schema.accepts(&json!(values)));
}

#[test]
fn string_length_bounds_count_unicode_scalars() {
    let unbounded =
        PortableSchema::from_value(json!({"type": "string"})).expect("unbounded string schema");
    let bounded = PortableSchema::from_value(json!({
        "type": "string", "minLength": 2, "maxLength": 2
    }))
    .expect("bounded string schema");
    assert!(unbounded.accepts(&json!("🦊".repeat(1_024))));
    assert!(bounded.accepts(&json!("🦊é")));
    assert!(!bounded.accepts(&json!("🦊")));
    assert!(!bounded.accepts(&json!("🦊éa")));
}

#[test]
fn tuple_and_record_keywords_validate_and_evaluate() {
    let tuple = PortableSchema::from_value(json!({
        "type":"array",
        "prefixItems":[{"type":"integer"},{"type":"string"}],
        "items":false,
        "minItems":2
    }))
    .expect("closed tuple");
    assert!(tuple.accepts(&json!([1, "a"])));
    assert!(!tuple.accepts(&json!([1])));
    assert!(!tuple.accepts(&json!([1, "a", 2])));
    assert!(!tuple.accepts(&json!(["a", 1])));

    let rest = PortableSchema::from_value(json!({
        "type":"array","prefixItems":[{"type":"string"}],"items":{"type":"number"}
    }))
    .expect("rest tuple");
    assert!(rest.accepts(&json!(["a", 1, 2])));
    assert!(!rest.accepts(&json!(["a", "b"])));

    let record = PortableSchema::from_value(json!({
        "type":"object",
        "propertyNames":{"type":"string","minLength":1},
        "additionalProperties":{"type":"string"}
    }))
    .expect("record");
    assert!(record.accepts(&json!({"a":"x"})));
    assert!(!record.accepts(&json!({"":"x"})));
    assert!(!record.accepts(&json!({"a":1})));

    for invalid in [
        json!({"type":"array","items":true}),
        json!({"type":"array","prefixItems":[]}),
        json!({"type":"object","propertyNames":false}),
    ] {
        let error = PortableSchema::from_value(invalid).expect_err("malformed keyword");
        assert_eq!(error.code(), ProgramErrorCode::InvalidSchema);
    }
}

#[cfg(feature = "schemars")]
mod schemars_adapter {
    use boundary_core::PortableSchema;
    use schemars::JsonSchema;

    #[derive(JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct Child {
        value: String,
    }

    #[derive(JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct Parent {
        child: Child,
    }

    #[derive(JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct Recursive {
        next: Option<Box<Recursive>>,
    }

    #[derive(JsonSchema)]
    struct Open {
        value: String,
    }

    #[test]
    fn lowers_finite_definitions_and_rejects_recursion() {
        let lowered = PortableSchema::for_type::<Parent>().expect("finite nested schema");
        let encoded = serde_json::to_string(lowered.as_value()).expect("schema JSON");
        assert!(!encoded.contains("$ref"));
        assert!(!encoded.contains("$defs"));
        assert!(PortableSchema::for_type::<Recursive>().is_err());
        assert!(PortableSchema::for_type::<Open>().is_err());
    }
}
