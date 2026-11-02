//! Keyword parsers for the Program v1 schema profile.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::{
    AdditionalProperties, Items, MAX_SAFE_INTEGER, ProgramError, SchemaAst, SchemaType,
    canonical_json, compile_node, schema_error,
};

pub(super) fn optional_type(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<SchemaType>, ProgramError> {
    let Some(value) = value else { return Ok(None) };
    let parsed = match value.as_str() {
        Some("null") => SchemaType::Null,
        Some("boolean") => SchemaType::Boolean,
        Some("object") => SchemaType::Object,
        Some("array") => SchemaType::Array,
        Some("number") => SchemaType::Number,
        Some("integer") => SchemaType::Integer,
        Some("string") => SchemaType::String,
        _ => {
            return Err(schema_error(
                path,
                "type must be one supported JSON type name",
            ));
        }
    };
    Ok(Some(parsed))
}

pub(super) fn compile_properties(
    value: Option<&Value>,
    path: &str,
) -> Result<BTreeMap<String, SchemaAst>, ProgramError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value.as_object().ok_or_else(|| {
        schema_error(format!("{path}.properties"), "properties must be an object")
    })?;
    object
        .iter()
        .map(|(name, child)| {
            compile_node(child, &format!("{path}.properties.{name}"))
                .map(|schema| (name.clone(), schema))
        })
        .collect()
}

pub(super) fn string_set(
    value: Option<&Value>,
    path: &str,
) -> Result<BTreeSet<String>, ProgramError> {
    let Some(value) = value else {
        return Ok(BTreeSet::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| schema_error(path, "required must be an array"))?;
    let mut result = BTreeSet::new();
    for (index, value) in values.iter().enumerate() {
        let name = value.as_str().ok_or_else(|| {
            schema_error(
                format!("{path}[{index}]"),
                "required entries must be strings",
            )
        })?;
        if !result.insert(name.to_owned()) {
            return Err(schema_error(
                format!("{path}[{index}]"),
                "required entries must be unique",
            ));
        }
    }
    Ok(result)
}

pub(super) fn compile_additional(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<AdditionalProperties>, ProgramError> {
    match value {
        None => Ok(None),
        Some(Value::Bool(allowed)) => Ok(Some(AdditionalProperties::Allowed(*allowed))),
        Some(value) => compile_node(value, &format!("{path}.additionalProperties"))
            .map(|schema| Some(AdditionalProperties::Schema(Box::new(schema)))),
    }
}

pub(super) fn compile_items(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<Items>, ProgramError> {
    match value {
        None => Ok(None),
        Some(Value::Bool(false)) => Ok(Some(Items::Forbidden)),
        Some(Value::Bool(true)) => {
            Err(schema_error(path, "items must be a schema object or false"))
        }
        Some(value) => {
            compile_node(value, path).map(|schema| Some(Items::Schema(Box::new(schema))))
        }
    }
}

pub(super) fn optional_node(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<Box<SchemaAst>>, ProgramError> {
    value
        .map(|value| compile_node(value, path).map(Box::new))
        .transpose()
}

pub(super) fn compile_enum(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<Vec<Value>>, ProgramError> {
    let Some(value) = value else { return Ok(None) };
    let values = value
        .as_array()
        .ok_or_else(|| schema_error(path, "enum must be an array"))?;
    if values.is_empty() {
        return Err(schema_error(path, "enum must not be empty"));
    }
    let mut seen = BTreeSet::new();
    for (index, value) in values.iter().enumerate() {
        let key = canonical_json(value)?;
        if !seen.insert(key) {
            return Err(schema_error(
                format!("{path}[{index}]"),
                "enum values must be unique",
            ));
        }
    }
    Ok(Some(values.clone()))
}

pub(super) fn alternatives(
    value: Option<&Value>,
    path: &str,
    keyword: &str,
) -> Result<Vec<SchemaAst>, ProgramError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| schema_error(path, format!("{keyword} must be an array")))?;
    if values.is_empty() {
        return Err(schema_error(path, format!("{keyword} must not be empty")));
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| compile_node(value, &format!("{path}[{index}]")))
        .collect()
}

pub(super) fn finite_number(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<f64>, ProgramError> {
    let Some(value) = value else { return Ok(None) };
    value
        .as_f64()
        .filter(|number| number.is_finite())
        .map(Some)
        .ok_or_else(|| schema_error(path, "keyword value must be a finite number"))
}

pub(super) fn count(value: Option<&Value>, path: &str) -> Result<Option<u64>, ProgramError> {
    let Some(value) = value else { return Ok(None) };
    let number = value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && *number >= 0.0
                && number.fract() == 0.0
                && *number <= MAX_SAFE_INTEGER
        })
        .ok_or_else(|| schema_error(path, "keyword value must be a non-negative safe integer"))?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let count = number as u64;
    Ok(Some(count))
}

pub(super) fn optional_bool(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<bool>, ProgramError> {
    value
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| schema_error(path, "keyword value must be a boolean"))
        })
        .transpose()
}

pub(super) fn validate_order<T: PartialOrd>(
    minimum: Option<T>,
    maximum: Option<T>,
    path: &str,
    min_name: &str,
    max_name: &str,
) -> Result<(), ProgramError> {
    if minimum.zip(maximum).is_some_and(|(min, max)| min > max) {
        return Err(schema_error(
            path,
            format!("{min_name} must not exceed {max_name}"),
        ));
    }
    Ok(())
}
