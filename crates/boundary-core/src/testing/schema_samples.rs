use serde_json::{Map, Number, Value, json};

use crate::{PortableSchema, canonical_json};

/// Summary of validating generated schema boundary samples.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SchemaSampleReport {
    /// Number of generated valid values checked.
    pub valid_checked: usize,
    /// Number of generated invalid values checked.
    pub invalid_checked: usize,
    /// Explanations for samples that violated their expected result.
    pub failures: Vec<String>,
}

/// Generates deterministic values accepted by `schema`, up to `max_samples`.
#[must_use]
pub fn generate_valid_samples(schema: &PortableSchema, max_samples: usize) -> Vec<Value> {
    let mut candidates = candidates(schema.as_value(), 0);
    candidates.retain(|value| schema.accepts(value));
    deduplicate(&mut candidates);
    candidates.truncate(max_samples);
    candidates
}

/// Generates deterministic values rejected by `schema`.
#[must_use]
pub fn generate_invalid_samples(schema: &PortableSchema) -> Vec<Value> {
    let raw = schema.as_value();
    let mut proposals = vec![
        Value::Null,
        json!(false),
        json!(0),
        json!(""),
        json!([]),
        json!({}),
    ];
    if let Some(object) = raw.as_object() {
        if let Some(required) = object.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                let mut value = valid_object(raw);
                if let Some(map) = value.as_object_mut() {
                    map.remove(key);
                }
                proposals.push(value);
            }
        }
        if object.get("additionalProperties") == Some(&Value::Bool(false)) {
            let mut value = valid_object(raw);
            value
                .as_object_mut()
                .map(|map| map.insert("__boundary_extra__".into(), Value::Null));
            proposals.push(value);
        }
        for key in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
            if let Some(bound) = object.get(key).and_then(Value::as_f64) {
                let outside = if key.contains("Minimum") {
                    bound - 1.0
                } else {
                    bound + 1.0
                };
                if let Some(number) = Number::from_f64(outside) {
                    proposals.push(Value::Number(number));
                }
            }
        }
        if object.get("type").and_then(Value::as_str) == Some("integer") {
            proposals.push(json!(0.5));
        }
        if object.contains_key("minLength") {
            proposals.push(json!(""));
        }
        if object.contains_key("maxLength") {
            proposals.push(json!("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
        }
    }
    for valid in candidates(raw, 0) {
        if let Some(object) = valid.as_object() {
            if let Some((key, _)) = object.iter().next() {
                let mut changed = valid.clone();
                changed
                    .as_object_mut()
                    .map(|map| map.insert(key.clone(), json!("__invalid__")));
                proposals.push(changed);
            }
        } else if valid.is_array() {
            proposals.push(json!("not-an-array"));
        }
    }
    proposals.retain(|value| !schema.accepts(value));
    deduplicate(&mut proposals);
    proposals
}

/// Checks generated valid and invalid values against the compiled schema.
#[must_use]
pub fn check_schema_samples(schema: &PortableSchema, max_samples: usize) -> SchemaSampleReport {
    let valid = generate_valid_samples(schema, max_samples);
    let invalid = generate_invalid_samples(schema);
    let mut report = SchemaSampleReport {
        valid_checked: valid.len(),
        invalid_checked: invalid.len(),
        failures: Vec::new(),
    };
    for (index, value) in valid.iter().enumerate() {
        if !schema.accepts(value) {
            report
                .failures
                .push(format!("valid sample {index} was rejected: {value}"));
        }
    }
    for (index, value) in invalid.iter().enumerate() {
        if schema.accepts(value) {
            report
                .failures
                .push(format!("invalid sample {index} was accepted: {value}"));
        }
    }
    report
}

fn candidates(schema: &Value, depth: usize) -> Vec<Value> {
    if depth > 8 {
        return vec![Value::Null];
    }
    let Some(object) = schema.as_object() else {
        return vec![
            Value::Null,
            json!(true),
            json!(0),
            json!(""),
            json!([]),
            json!({}),
        ];
    };
    if let Some(value) = object.get("const") {
        return vec![value.clone()];
    }
    if let Some(values) = object.get("enum").and_then(Value::as_array) {
        return values.clone();
    }
    let mut out = Vec::new();
    if let Some(branches) = object
        .get("anyOf")
        .or_else(|| object.get("oneOf"))
        .and_then(Value::as_array)
    {
        for branch in branches {
            out.extend(candidates(branch, depth + 1));
        }
    }
    let kind = object.get("type").and_then(Value::as_str);
    match kind {
        Some("null") => out.push(Value::Null),
        Some("boolean") => out.extend([json!(false), json!(true)]),
        Some("string") => out.extend(string_candidates(object)),
        Some("integer" | "number") => {
            out.extend(number_candidates(object, kind == Some("integer")));
        }
        Some("array") => out.extend(array_candidates(object, depth)),
        Some("object") => out.extend(object_candidates(object, depth)),
        _ => out.extend([
            Value::Null,
            json!(false),
            json!(0),
            json!("sample"),
            json!([]),
            json!({}),
        ]),
    }
    if object.contains_key("allOf") {
        out.retain(|value| {
            object["allOf"].as_array().is_some_and(|branches| {
                branches.iter().all(|branch| {
                    candidates(branch, depth + 1)
                        .iter()
                        .any(|sample| equivalent(sample, value))
                })
            })
        });
    }
    out
}

fn string_candidates(object: &Map<String, Value>) -> Vec<Value> {
    let min = bound_usize(object.get("minLength")).unwrap_or(0).min(128);
    let max = bound_usize(object.get("maxLength"))
        .unwrap_or(min.saturating_add(2))
        .min(128);
    let mut values = Vec::new();
    for len in [min, min.saturating_add(1), max]
        .into_iter()
        .filter(|len| *len <= max)
    {
        values.push(Value::String("a".repeat(len)));
        values.push(Value::String("x".repeat(len)));
    }
    if let Some(pattern) = object.get("pattern").and_then(Value::as_str) {
        let literal: String = pattern
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !literal.is_empty() {
            values.push(Value::String(literal));
        }
    }
    values
}

fn number_candidates(object: &Map<String, Value>, integer: bool) -> Vec<Value> {
    let low = object
        .get("minimum")
        .and_then(Value::as_f64)
        .or_else(|| {
            object
                .get("exclusiveMinimum")
                .and_then(Value::as_f64)
                .map(|v| v + if integer { 1.0 } else { f64::EPSILON })
        })
        .unwrap_or(0.0);
    let high = object
        .get("maximum")
        .and_then(Value::as_f64)
        .or_else(|| {
            object
                .get("exclusiveMaximum")
                .and_then(Value::as_f64)
                .map(|v| v - if integer { 1.0 } else { f64::EPSILON })
        })
        .unwrap_or(low + 2.0);
    let mut values = Vec::new();
    for value in [low, f64::midpoint(low, high), high] {
        let value = if integer { value.ceil() } else { value };
        if value <= high
            && let Some(number) = Number::from_f64(value)
        {
            values.push(Value::Number(number));
        }
    }
    values
}

fn array_candidates(object: &Map<String, Value>, depth: usize) -> Vec<Value> {
    let prefix = object
        .get("prefixItems")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let min = bound_usize(object.get("minItems"))
        .unwrap_or(prefix.len())
        .min(32);
    let count = min.max(prefix.len().min(1));
    let mut items = Vec::new();
    for (index, child) in prefix.iter().enumerate().take(count) {
        items.push(
            candidates(child, depth + 1)
                .into_iter()
                .next()
                .unwrap_or(Value::Null),
        );
        let _ = index;
    }
    let item_schema = object.get("items").filter(|value| !value.is_boolean());
    while items.len() < count {
        items.push(item_schema.map_or(Value::Null, |item| {
            candidates(item, depth + 1)
                .into_iter()
                .next()
                .unwrap_or(Value::Null)
        }));
    }
    vec![Value::Array(items)]
}

fn object_candidates(object: &Map<String, Value>, depth: usize) -> Vec<Value> {
    let required = object
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let properties = object.get("properties").and_then(Value::as_object);
    let mut map = Map::new();
    let mut optional = Map::new();
    if let Some(properties) = properties {
        for (key, schema) in properties {
            if let Some(value) = candidates(schema, depth + 1).into_iter().next() {
                optional.insert(key.clone(), value.clone());
                if required.iter().any(|name| name.as_str() == Some(key)) {
                    map.insert(key.clone(), value);
                }
            }
        }
    }
    let all_properties = Value::Object(optional);
    if map == all_properties.as_object().cloned().unwrap_or_default() {
        vec![Value::Object(map)]
    } else {
        vec![Value::Object(map), all_properties]
    }
}

fn bound_usize(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .and_then(|number| number.to_string().parse::<usize>().ok())
}

fn valid_object(schema: &Value) -> Value {
    candidates(schema, 0)
        .into_iter()
        .find(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn equivalent(left: &Value, right: &Value) -> bool {
    canonical_json(left).ok() == canonical_json(right).ok()
}

fn deduplicate(values: &mut Vec<Value>) {
    let mut seen = Vec::<String>::new();
    values.retain(|value| {
        if let Ok(key) = canonical_json(value) {
            if seen.contains(&key) {
                false
            } else {
                seen.push(key);
                true
            }
        } else {
            false
        }
    });
}
