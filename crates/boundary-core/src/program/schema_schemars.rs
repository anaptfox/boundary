use std::collections::BTreeSet;

use serde_json::Value;

mod closure;

use super::{ProgramError, schema::schema_error};
use closure::{lower_pattern_format, require_closed_object};

// These keywords annotate a schema without changing the accepted value set.
// Schemars emits field documentation beside references to named DTOs.
fn is_annotation(key: &str) -> bool {
    matches!(
        key,
        "title" | "description" | "default" | "examples" | "deprecated" | "readOnly" | "writeOnly"
    )
}

pub(super) fn lower_schemars(value: &Value) -> Result<Value, ProgramError> {
    lower_node(value, value, "schema", &mut BTreeSet::new())
}

fn lower_node(
    value: &Value,
    root: &Value,
    path: &str,
    active: &mut BTreeSet<String>,
) -> Result<Value, ProgramError> {
    let object = value
        .as_object()
        .ok_or_else(|| schema_error(path, "Schemars emitted a non-object schema"))?;
    if let Some(reference) = object.get("$ref") {
        if object
            .keys()
            .any(|key| key != "$ref" && !is_annotation(key))
        {
            return Err(schema_error(
                path,
                "a Schemars $ref must not have sibling validation keywords",
            ));
        }
        let reference = reference
            .as_str()
            .ok_or_else(|| schema_error(path, "$ref must be a string"))?;
        if !reference.starts_with("#/$defs/") || !active.insert(reference.to_owned()) {
            return Err(schema_error(
                path,
                "external or recursive Schemars references are not portable",
            ));
        }
        let target = root
            .pointer(&reference[1..])
            .ok_or_else(|| schema_error(path, "Schemars reference does not resolve"))?;
        let lowered = lower_node(target, root, path, active);
        active.remove(reference);
        return lowered;
    }
    let mut lowered = serde_json::Map::new();
    for (key, child) in object {
        if matches!(
            key.as_str(),
            "$schema"
                | "$defs"
                | "title"
                | "description"
                | "default"
                | "examples"
                | "deprecated"
                | "readOnly"
                | "writeOnly"
        ) {
            continue;
        }
        let child = match key.as_str() {
            "properties" => {
                let properties = child
                    .as_object()
                    .ok_or_else(|| schema_error(path, "properties must be an object"))?;
                Value::Object(
                    properties
                        .iter()
                        .map(|(name, schema)| {
                            lower_node(schema, root, &format!("{path}.properties.{name}"), active)
                                .map(|value| (name.clone(), value))
                        })
                        .collect::<Result<_, _>>()?,
                )
            }
            "not" | "propertyNames" => lower_node(child, root, &format!("{path}.{key}"), active)?,
            "items" | "additionalProperties" if child.is_object() => {
                lower_node(child, root, &format!("{path}.{key}"), active)?
            }
            "anyOf" | "oneOf" | "allOf" | "prefixItems" => {
                let alternatives = child
                    .as_array()
                    .ok_or_else(|| schema_error(path, format!("{key} must be an array")))?;
                Value::Array(
                    alternatives
                        .iter()
                        .enumerate()
                        .map(|(index, schema)| {
                            lower_node(schema, root, &format!("{path}.{key}[{index}]"), active)
                        })
                        .collect::<Result<_, _>>()?,
                )
            }
            _ => child.clone(),
        };
        lowered.insert(key.clone(), child);
    }
    require_closed_object(&lowered, path)?;
    lower_format(&mut lowered, path)?;
    close_exact_tuple(&mut lowered);
    lower_type_union(lowered, path)
}

/// Schemars bounds a Rust tuple by `maxItems` alone. Spell the same closed
/// arity as `items: false`, the form Zod emits, so equal tuples share a contract.
fn close_exact_tuple(lowered: &mut serde_json::Map<String, Value>) {
    let Some(prefix) = lowered.get("prefixItems").and_then(Value::as_array) else {
        return;
    };
    let exact = lowered
        .get("maxItems")
        .and_then(Value::as_u64)
        .is_some_and(|maximum| maximum == prefix.len() as u64);
    if exact && !lowered.contains_key("items") {
        lowered.insert("items".into(), Value::Bool(false));
    }
}

fn lower_format(
    lowered: &mut serde_json::Map<String, Value>,
    path: &str,
) -> Result<(), ProgramError> {
    // Rust integer formats are ranges, not portable JSON Schema keywords.
    // Intersect with the safe-integer wire domain instead of dropping the range.
    if let Some(format) = lowered
        .get("format")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        if lower_pattern_format(lowered, &format, path)? {
            return Ok(());
        }
        let range = match format.as_str() {
            "uint8" => Some((0.0_f64, 255.0_f64)),
            "uint16" => Some((0.0, 65_535.0)),
            "uint32" => Some((0.0, 4_294_967_295.0)),
            "uint64" => Some((0.0, 9_007_199_254_740_991.0)),
            "int8" => Some((-128.0, 127.0)),
            "int16" => Some((-32_768.0, 32_767.0)),
            "int32" => Some((-2_147_483_648.0, 2_147_483_647.0)),
            "int64" => Some((-9_007_199_254_740_991.0, 9_007_199_254_740_991.0)),
            _ => None,
        };
        if let Some((minimum, maximum)) = range {
            let integer = lowered.get("type").is_some_and(|ty| {
                ty == "integer"
                    || ty
                        .as_array()
                        .is_some_and(|types| types.iter().any(|ty| ty == "integer"))
            });
            if !integer {
                return Err(schema_error(
                    path,
                    "Rust integer format requires integer type",
                ));
            }
            lowered.remove("format");
            let minimum = lowered
                .get("minimum")
                .and_then(Value::as_f64)
                .map_or(minimum, |value| value.max(minimum));
            let maximum = lowered
                .get("maximum")
                .and_then(Value::as_f64)
                .map_or(maximum, |value| value.min(maximum));
            lowered.insert("minimum".into(), serde_json::json!(minimum));
            lowered.insert("maximum".into(), serde_json::json!(maximum));
        } else if format == "double" && lowered.get("type").is_some_and(|ty| ty == "number") {
            lowered.remove("format");
        }
    }
    Ok(())
}

fn lower_type_union(
    mut lowered: serde_json::Map<String, Value>,
    path: &str,
) -> Result<Value, ProgramError> {
    if let Some(Value::Array(types)) = lowered.get("type").cloned() {
        if types.is_empty()
            || types.iter().any(|ty| {
                !matches!(
                    ty.as_str(),
                    Some("string" | "null" | "boolean" | "number" | "integer" | "object" | "array")
                )
            })
        {
            return Err(schema_error(
                path,
                "Schemars type union must contain supported JSON types",
            ));
        }
        lowered.remove("type");
        let alternatives = Value::Array(
            types
                .into_iter()
                .map(|ty| serde_json::json!({"type": ty}))
                .collect(),
        );
        let constraint = serde_json::json!({"anyOf": alternatives});
        if lowered.is_empty() {
            return Ok(constraint);
        }
        // Keep existing combinators and constraints conjunctive.
        lowered
            .entry("allOf")
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
            .ok_or_else(|| schema_error(path, "allOf must be an array"))?
            .push(constraint);
    }
    Ok(Value::Object(lowered))
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn named_field_documentation_does_not_change_its_value_contract() -> Result<(), ProgramError> {
        let schema = json!({"type":"object", "additionalProperties": false, "properties": {
            "project": {"$ref":"#/$defs/Project", "description":"The current project", "title":"Project"}
        }, "$defs":{"Project":{"type":"string"}}});
        let lowered = lower_schemars(&schema)?;
        assert_eq!(lowered["properties"]["project"], json!({"type":"string"}));
        Ok(())
    }

    #[test]
    fn nullable_types_preserve_sibling_constraints() -> Result<(), ProgramError> {
        let schema =
            json!({"type":["string","null"],"minLength":2,"anyOf":[{"const":null},{"const":"ok"}]});
        let lowered = lower_schemars(&schema)?;
        assert_eq!(lowered["minLength"], 2);
        assert_eq!(lowered["anyOf"], schema["anyOf"]);
        assert_eq!(
            lowered["allOf"][0],
            json!({"anyOf":[{"type":"string"},{"type":"null"}]})
        );
        assert!(super::super::PortableSchema::from_value(lowered).is_ok());
        Ok(())
    }

    #[test]
    fn rust_integer_format_keeps_its_range_and_wire_bounds() -> Result<(), ProgramError> {
        let byte = lower_schemars(&json!({"type":"integer","format":"uint8","minimum":1}))?;
        assert_eq!(byte["minimum"], 1.0);
        assert_eq!(byte["maximum"], 255.0);
        let wide = lower_schemars(&json!({"type":"integer","format":"uint64","minimum":0}))?;
        assert_eq!(wide["maximum"], 9_007_199_254_740_991.0);
        assert!(super::super::PortableSchema::from_value(wide).is_ok());
        Ok(())
    }

    #[test]
    fn reference_validation_siblings_are_not_silently_discarded() {
        let schema =
            json!({"$ref":"#/$defs/Name", "minLength":2, "$defs":{"Name":{"type":"string"}}});
        assert!(lower_schemars(&schema).is_err());
    }
}
