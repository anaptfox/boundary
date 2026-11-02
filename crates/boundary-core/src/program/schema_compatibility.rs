use serde_json::Value;

use super::{PortableSchema, SchemaType, compatibility::Compatibility, schema::SchemaAst};

mod collections;

use collections::{arrays, effective_max_items, objects};

#[derive(Clone, Copy)]
enum ExtraProperties {
    Reject,
    Ignore,
}

pub(super) fn accepts_every(
    wider: &PortableSchema,
    narrower: &PortableSchema,
    path: &str,
    ignore_extra_properties: bool,
) -> Compatibility {
    if wider == narrower {
        return Compatibility::Compatible;
    }
    accepts_ast(
        wider.ast(),
        narrower.ast(),
        path,
        if ignore_extra_properties {
            ExtraProperties::Ignore
        } else {
            ExtraProperties::Reject
        },
    )
}

fn accepts_ast(
    wider: &SchemaAst,
    narrower: &SchemaAst,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    // Identical sub-schemas accept each other at every depth, as the
    // TypeScript implementation's `jsonEquals` check does. Without this,
    // an unchanged bounded `T | null` (`allOf: [anyOf: [T, null]]` with
    // sibling bounds) was reported as uncovered by its own `anyOf`.
    if wider == narrower {
        return Compatibility::Compatible;
    }
    if is_open(wider) {
        return Compatibility::Compatible;
    }
    if is_open(narrower) {
        return incompatible(path, "open schema is not accepted by a constrained schema");
    }
    if let Some(result) = types(wider, narrower, path) {
        return result;
    }
    if let Some(result) = values(wider, narrower, path) {
        return result;
    }
    for result in [
        lower_bound(wider.minimum, narrower.minimum, path, "minimum"),
        upper_bound(wider.maximum, narrower.maximum, path, "maximum"),
        lower_bound(
            wider.exclusive_minimum,
            narrower.exclusive_minimum,
            path,
            "exclusiveMinimum",
        ),
        upper_bound(
            wider.exclusive_maximum,
            narrower.exclusive_maximum,
            path,
            "exclusiveMaximum",
        ),
        lower_bound(wider.min_length, narrower.min_length, path, "minLength"),
        upper_bound(wider.max_length, narrower.max_length, path, "maxLength"),
        lower_bound(wider.min_items, narrower.min_items, path, "minItems"),
        upper_bound(
            wider.max_items,
            effective_max_items(narrower),
            path,
            "maxItems",
        ),
    ] {
        if !result.is_compatible() {
            return result;
        }
    }
    if wider.pattern.is_some() && wider.pattern != narrower.pattern {
        return incompatible(format!("{path}.pattern"), "pattern constraints differ");
    }
    if wider.unique_items == Some(true) && narrower.unique_items != Some(true) {
        return incompatible(
            format!("{path}.uniqueItems"),
            "uniqueItems is not constrained enough",
        );
    }
    let arrays = arrays(wider, narrower, path, extras);
    if !arrays.is_compatible() {
        return arrays;
    }
    let objects = objects(wider, narrower, path, extras);
    if !objects.is_compatible() {
        return objects;
    }
    combinators(wider, narrower, path, extras)
}

fn is_open(schema: &SchemaAst) -> bool {
    schema.schema_type.is_none()
        && schema.properties.is_empty()
        && schema.required.is_empty()
        && schema.additional.is_none()
        && schema.items.is_none()
        && schema.prefix_items.is_empty()
        && schema.property_names.is_none()
        && schema.enumeration.is_none()
        && schema.constant.is_none()
        && schema.any_of.is_empty()
        && schema.one_of.is_empty()
        && schema.all_of.is_empty()
        && schema.not.is_none()
        && schema.minimum.is_none()
        && schema.maximum.is_none()
        && schema.exclusive_minimum.is_none()
        && schema.exclusive_maximum.is_none()
        && schema.min_length.is_none()
        && schema.max_length.is_none()
        && schema.pattern.is_none()
        && schema.min_items.is_none()
        && schema.max_items.is_none()
        && schema.unique_items.is_none()
}

fn types(wider: &SchemaAst, narrower: &SchemaAst, path: &str) -> Option<Compatibility> {
    match (wider.schema_type, narrower.schema_type) {
        (None, _) => None,
        (Some(_), None) => Some(incompatible(
            path,
            "untyped schema is not assignable to a typed schema",
        )),
        (Some(wide), Some(narrow))
            if wide == narrow || (wide == SchemaType::Number && narrow == SchemaType::Integer) =>
        {
            None
        }
        (Some(wide), Some(narrow)) => Some(incompatible(
            format!("{path}.type"),
            format!("type {narrow:?} is not assignable to {wide:?}"),
        )),
    }
}

fn values(wider: &SchemaAst, narrower: &SchemaAst, path: &str) -> Option<Compatibility> {
    if let Some(expected) = &wider.constant {
        let all_equal = narrower
            .constant
            .as_ref()
            .is_some_and(|value| value == expected)
            || narrower
                .enumeration
                .as_ref()
                .is_some_and(|values| values.iter().all(|value| value == expected));
        if !all_equal {
            return Some(incompatible(
                path,
                "values are not restricted to the expected const",
            ));
        }
    } else if let Some(value) = &narrower.constant
        && !accepts_value(wider, value)
    {
        return Some(incompatible(path, "const value is not accepted"));
    }

    if let Some(allowed) = &wider.enumeration {
        let candidates: Option<Vec<&Value>> = narrower
            .enumeration
            .as_ref()
            .map(|values| values.iter().collect())
            .or_else(|| narrower.constant.as_ref().map(|value| vec![value]));
        if !candidates.is_some_and(|values| {
            values
                .iter()
                .all(|value| allowed.iter().any(|item| item == *value))
        }) {
            return Some(incompatible(path, "enum values are not covered"));
        }
    } else if let Some(candidates) = &narrower.enumeration
        && !candidates.iter().all(|value| accepts_value(wider, value))
    {
        return Some(incompatible(path, "enum value is not accepted"));
    }
    None
}

fn lower_bound<T: Copy + PartialOrd>(
    wider: Option<T>,
    narrower: Option<T>,
    path: &str,
    keyword: &str,
) -> Compatibility {
    match (wider, narrower) {
        (None, _) => Compatibility::Compatible,
        (Some(_), None) => incompatible(
            format!("{path}.{keyword}"),
            format!("{keyword} is not constrained enough"),
        ),
        (Some(wide), Some(narrow)) if narrow >= wide => Compatibility::Compatible,
        _ => incompatible(
            format!("{path}.{keyword}"),
            format!("{keyword} is not compatible"),
        ),
    }
}

fn upper_bound<T: Copy + PartialOrd>(
    wider: Option<T>,
    narrower: Option<T>,
    path: &str,
    keyword: &str,
) -> Compatibility {
    match (wider, narrower) {
        (None, _) => Compatibility::Compatible,
        (Some(_), None) => incompatible(
            format!("{path}.{keyword}"),
            format!("{keyword} is not constrained enough"),
        ),
        (Some(wide), Some(narrow)) if narrow <= wide => Compatibility::Compatible,
        _ => incompatible(
            format!("{path}.{keyword}"),
            format!("{keyword} is not compatible"),
        ),
    }
}

fn combinators(
    wider: &SchemaAst,
    narrower: &SchemaAst,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    for (name, branches) in [("anyOf", &narrower.any_of), ("oneOf", &narrower.one_of)] {
        for (index, branch) in branches.iter().enumerate() {
            let result = accepts_ast(wider, branch, &format!("{path}.{name}[{index}]"), extras);
            if !result.is_compatible() {
                return result;
            }
        }
    }
    if !narrower.all_of.is_empty() && wider.all_of.is_empty() {
        for (index, branch) in narrower.all_of.iter().enumerate() {
            let result = accepts_ast(wider, branch, &format!("{path}.allOf[{index}]"), extras);
            if !result.is_compatible() {
                return result;
            }
        }
    }
    // Distributing narrower branches proves wider anyOf coverage. It does
    // not prove oneOf exclusivity: a non-covering branch may still overlap
    // part of the offered domain. Such a branch needs explicit type exclusion.
    let narrower_is_union = !narrower.any_of.is_empty() || !narrower.one_of.is_empty();
    for (name, branches) in [("anyOf", &wider.any_of), ("oneOf", &wider.one_of)] {
        if !(branches.is_empty() || name == "anyOf" && narrower_is_union) {
            let mut matches = 0;
            for branch in branches {
                if accepts_ast(branch, narrower, path, extras).is_compatible() {
                    matches += 1;
                } else if name == "oneOf"
                    && !types_are_disjoint(branch.schema_type, narrower.schema_type)
                {
                    return incompatible(
                        format!("{path}.oneOf"),
                        "oneOf exclusivity is not proven",
                    );
                }
            }
            let valid = if name == "oneOf" {
                matches == 1
            } else {
                matches > 0
            };
            if !valid {
                return incompatible(
                    format!("{path}.{name}"),
                    format!("schema is not covered by {name}"),
                );
            }
        }
    }
    for (index, branch) in wider.all_of.iter().enumerate() {
        let result = accepts_ast(branch, narrower, &format!("{path}.allOf[{index}]"), extras);
        if !result.is_compatible() {
            return result;
        }
    }
    if wider.not.is_some() || narrower.not.is_some() {
        return incompatible(
            format!("{path}.not"),
            "not compatibility requires an exact contract digest",
        );
    }
    Compatibility::Compatible
}

fn types_are_disjoint(left: Option<SchemaType>, right: Option<SchemaType>) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left != right
        && !matches!((left, right),
            (SchemaType::Number, SchemaType::Integer) | (SchemaType::Integer, SchemaType::Number)))
}

fn accepts_value(schema: &SchemaAst, value: &Value) -> bool {
    if let Some(schema_type) = schema.schema_type
        && !value_has_type(value, schema_type)
    {
        return false;
    }
    if schema
        .constant
        .as_ref()
        .is_some_and(|constant| constant != value)
        || schema
            .enumeration
            .as_ref()
            .is_some_and(|values| !values.contains(value))
    {
        return false;
    }
    if let Some(number) = value.as_f64()
        && (schema.minimum.is_some_and(|bound| number < bound)
            || schema.maximum.is_some_and(|bound| number > bound)
            || schema
                .exclusive_minimum
                .is_some_and(|bound| number <= bound)
            || schema
                .exclusive_maximum
                .is_some_and(|bound| number >= bound))
    {
        return false;
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if schema.min_length.is_some_and(|bound| length < bound)
            || schema.max_length.is_some_and(|bound| length > bound)
        {
            return false;
        }
        if let Some(regex) = &schema.pattern_regex
            && !regex.is_match(text)
        {
            return false;
        }
    }
    true
}

fn value_has_type(value: &Value, schema_type: SchemaType) -> bool {
    match schema_type {
        SchemaType::Null => value.is_null(),
        SchemaType::Boolean => value.is_boolean(),
        SchemaType::Object => value.is_object(),
        SchemaType::Array => value.is_array(),
        SchemaType::Number => value.is_number(),
        SchemaType::Integer => value.as_f64().is_some_and(|value| value.fract() == 0.0),
        SchemaType::String => value.is_string(),
    }
}

fn property_path(path: &str, name: &str) -> String {
    format!("{path}.properties.{name}")
}

fn incompatible(path: impl Into<String>, reason: impl Into<String>) -> Compatibility {
    Compatibility::Incompatible {
        path: path.into(),
        reason: reason.into(),
    }
}
