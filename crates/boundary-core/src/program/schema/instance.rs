use std::collections::HashSet;

use serde_json::Value;

use super::{AdditionalProperties, Items, SchemaAst, SchemaType};
use crate::program::canonical_json;

pub(super) fn accepts(schema: &SchemaAst, value: &Value) -> bool {
    type_matches(schema.schema_type, value)
        && enum_matches(schema, value)
        && number_matches(schema, value)
        && string_matches(schema, value)
        && array_matches(schema, value)
        && object_matches(schema, value)
        && combinators_match(schema, value)
}

fn type_matches(kind: Option<SchemaType>, value: &Value) -> bool {
    kind.is_none_or(|kind| match kind {
        SchemaType::Null => value.is_null(),
        SchemaType::Boolean => value.is_boolean(),
        SchemaType::Object => value.is_object(),
        SchemaType::Array => value.is_array(),
        SchemaType::Number => value.is_number(),
        SchemaType::Integer => value.as_f64().is_some_and(|number| number.fract() == 0.0),
        SchemaType::String => value.is_string(),
    })
}

fn enum_matches(schema: &SchemaAst, value: &Value) -> bool {
    schema
        .constant
        .as_ref()
        .is_none_or(|constant| portable_equal(constant, value))
        && schema
            .enumeration
            .as_ref()
            .is_none_or(|values| values.iter().any(|item| portable_equal(item, value)))
}

/// Portable JSON equality: numbers compare by binary64 value, so `1`, `1.0`,
/// `1e0`, and `-0` agree with `0`; every other JSON category compares
/// structurally. TypeScript's `jsonEquals` compares canonical JSON and must
/// agree on every input.
fn portable_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| portable_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(name, left)| {
                    right
                        .get(name)
                        .is_some_and(|right| portable_equal(left, right))
                })
        }
        _ => left == right,
    }
}

fn number_matches(schema: &SchemaAst, value: &Value) -> bool {
    let Some(number) = value.as_f64() else {
        return true;
    };
    schema.minimum.is_none_or(|bound| number >= bound)
        && schema.maximum.is_none_or(|bound| number <= bound)
        && schema.exclusive_minimum.is_none_or(|bound| number > bound)
        && schema.exclusive_maximum.is_none_or(|bound| number < bound)
}

fn string_matches(schema: &SchemaAst, value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return true;
    };
    if schema.min_length.is_some() || schema.max_length.is_some() {
        let length = text.chars().count() as u64;
        if schema.min_length.is_some_and(|bound| length < bound)
            || schema.max_length.is_some_and(|bound| length > bound)
        {
            return false;
        }
    }
    schema
        .pattern_regex
        .as_ref()
        .is_none_or(|regex| regex.is_match(text))
}

fn array_matches(schema: &SchemaAst, value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return true;
    };
    let length = items.len() as u64;
    if schema.min_items.is_some_and(|bound| length < bound)
        || schema.max_items.is_some_and(|bound| length > bound)
    {
        return false;
    }
    if schema.unique_items == Some(true) {
        // Canonical JSON is the identity of a portable value, so numeric
        // spellings of one value collide. A value with no canonical form
        // cannot be proven unique and is refused.
        let mut seen = HashSet::with_capacity(items.len());
        if items
            .iter()
            .any(|item| canonical_json(item).map_or(true, |key| !seen.insert(key)))
        {
            return false;
        }
    }
    items.iter().enumerate().all(|(index, item)| {
        if let Some(positional) = schema.prefix_items.get(index) {
            return accepts(positional, item);
        }
        match &schema.items {
            None => true,
            Some(Items::Forbidden) => false,
            Some(Items::Schema(tail)) => accepts(tail, item),
        }
    })
}

fn object_matches(schema: &SchemaAst, value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return true;
    };
    if schema
        .required
        .iter()
        .any(|name| !object.contains_key(name))
    {
        return false;
    }
    object.iter().all(|(name, field)| {
        if schema
            .property_names
            .as_ref()
            .is_some_and(|names| !accepts(names, &Value::String(name.clone())))
        {
            return false;
        }
        if let Some(field_schema) = schema.properties.get(name) {
            return accepts(field_schema, field);
        }
        match &schema.additional {
            None | Some(AdditionalProperties::Allowed(true)) => true,
            Some(AdditionalProperties::Allowed(false)) => false,
            Some(AdditionalProperties::Schema(additional)) => accepts(additional, field),
        }
    })
}

fn combinators_match(schema: &SchemaAst, value: &Value) -> bool {
    (schema.any_of.is_empty() || schema.any_of.iter().any(|branch| accepts(branch, value)))
        && (schema.one_of.is_empty()
            || schema
                .one_of
                .iter()
                .filter(|branch| accepts(branch, value))
                .count()
                == 1)
        && schema.all_of.iter().all(|branch| accepts(branch, value))
        && schema
            .not
            .as_ref()
            .is_none_or(|branch| !accepts(branch, value))
}
