//! Array and object rules of the structural schema matcher: positional
//! `prefixItems`/`items`, named properties, `propertyNames`, and the
//! additional-property domain.

use serde_json::Value;

use super::{Compatibility, ExtraProperties, SchemaType, accepts_ast, incompatible, property_path};
use crate::program::schema::{AdditionalProperties, Items, SchemaAst};

/// A position's schema: unconstrained, forbidden by `items: false`, or a schema.
enum Slot<'a> {
    Open,
    Forbidden,
    Schema(&'a SchemaAst),
}

fn slot(schema: &SchemaAst, index: usize) -> Slot<'_> {
    if let Some(positional) = schema.prefix_items.get(index) {
        return Slot::Schema(positional);
    }
    match &schema.items {
        None => Slot::Open,
        Some(Items::Forbidden) => Slot::Forbidden,
        Some(Items::Schema(tail)) => Slot::Schema(tail),
    }
}

/// The largest array length a schema admits, from `maxItems` and a closed tuple.
pub(super) fn effective_max_items(schema: &SchemaAst) -> Option<u64> {
    let closed =
        matches!(schema.items, Some(Items::Forbidden)).then_some(schema.prefix_items.len() as u64);
    match (closed, schema.max_items) {
        (None, declared) => declared,
        (Some(closed), None) => Some(closed),
        (Some(closed), Some(declared)) => Some(closed.min(declared)),
    }
}

fn accepts_slot(
    wider: &Slot,
    narrower: &Slot,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    match (wider, narrower) {
        (_, Slot::Forbidden) | (Slot::Open, _) => Compatibility::Compatible,
        (Slot::Forbidden, _) => incompatible(path, "array item is not accepted"),
        (Slot::Schema(_), Slot::Open) => {
            incompatible(path, "array items are not constrained enough")
        }
        (Slot::Schema(wide), Slot::Schema(narrow)) => accepts_ast(wide, narrow, path, extras),
    }
}

/// Positional subsumption: every position the narrower schema can fill must be
/// accepted by the wider schema's `prefixItems` entry or `items` tail there.
pub(super) fn arrays(
    wider: &SchemaAst,
    narrower: &SchemaAst,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    let limit = effective_max_items(narrower);
    let reachable = |index: usize| limit.is_none_or(|limit| (index as u64) < limit);
    let positions = wider.prefix_items.len().max(narrower.prefix_items.len());
    for index in 0..positions {
        if !reachable(index) {
            return Compatibility::Compatible;
        }
        let narrow = slot(narrower, index);
        if matches!(narrow, Slot::Forbidden) {
            return Compatibility::Compatible;
        }
        let item_path = if index < wider.prefix_items.len() {
            format!("{path}.prefixItems[{index}]")
        } else {
            format!("{path}.items")
        };
        let result = accepts_slot(&slot(wider, index), &narrow, &item_path, extras);
        if !result.is_compatible() {
            return result;
        }
    }
    if !reachable(positions) {
        return Compatibility::Compatible;
    }
    accepts_slot(
        &slot(wider, positions),
        &slot(narrower, positions),
        &format!("{path}.items"),
        extras,
    )
}

/// The value schema of additional properties; `None` when they are forbidden.
fn additional_values(schema: &SchemaAst) -> Option<SchemaAst> {
    match &schema.additional {
        Some(AdditionalProperties::Allowed(false)) => None,
        Some(AdditionalProperties::Schema(values)) => Some((**values).clone()),
        None | Some(AdditionalProperties::Allowed(true)) => Some(SchemaAst::default()),
    }
}

fn admits_additional_name(narrower: &SchemaAst, name: &str) -> bool {
    !matches!(
        narrower.additional,
        Some(AdditionalProperties::Allowed(false))
    ) && narrower
        .property_names
        .as_ref()
        .is_none_or(|names| names.accepts(&Value::String(name.to_owned())))
}

/// Every key the narrower schema admits must satisfy wider `propertyNames`.
fn property_names(
    wider: &SchemaAst,
    narrower: &SchemaAst,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    let Some(wide) = &wider.property_names else {
        return Compatibility::Compatible;
    };
    for name in narrower.properties.keys() {
        let key = Value::String(name.clone());
        if narrower
            .property_names
            .as_ref()
            .is_some_and(|names| !names.accepts(&key))
        {
            continue;
        }
        if !wide.accepts(&key) {
            return incompatible(property_path(path, name), "property name is not accepted");
        }
    }
    if matches!(
        narrower.additional,
        Some(AdditionalProperties::Allowed(false))
    ) {
        return Compatibility::Compatible;
    }
    // Object keys are always strings, so an untyped narrower key schema is a
    // string schema; an absent one admits every string.
    let mut offered = narrower
        .property_names
        .as_deref()
        .cloned()
        .unwrap_or_default();
    if offered.schema_type.is_none() {
        offered.schema_type = Some(SchemaType::String);
    }
    accepts_ast(wide, &offered, &format!("{path}.propertyNames"), extras)
}

pub(super) fn objects(
    wider: &SchemaAst,
    narrower: &SchemaAst,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    for name in &wider.required {
        if !narrower.required.contains(name) {
            return incompatible(
                property_path(path, name),
                "required property may be omitted",
            );
        }
    }
    for (name, wide) in &wider.properties {
        let Some(narrow) = narrower.properties.get(name) else {
            if wider.required.contains(name) {
                return incompatible(property_path(path, name), "required property is missing");
            }
            // An optional wider property the narrower schema may still carry
            // as an additional property must accept those additional values.
            if admits_additional_name(narrower, name)
                && let Some(values) = additional_values(narrower)
            {
                let nested = accepts_ast(wide, &values, &property_path(path, name), extras);
                if !nested.is_compatible() {
                    return nested;
                }
            }
            continue;
        };
        let nested = accepts_ast(wide, narrow, &property_path(path, name), extras);
        if !nested.is_compatible() {
            return nested;
        }
    }
    let names = property_names(wider, narrower, path, extras);
    if !names.is_compatible() {
        return names;
    }
    // Ignoring extras is sound only when the wider side does not read them:
    // a record (`additionalProperties` schema) reads every unnamed entry.
    if matches!(extras, ExtraProperties::Ignore)
        && !matches!(wider.additional, Some(AdditionalProperties::Schema(_)))
    {
        return Compatibility::Compatible;
    }
    for (name, narrow) in &narrower.properties {
        if wider.properties.contains_key(name) {
            continue;
        }
        let nested = accepts_additional(
            wider.additional.as_ref(),
            Some(narrow),
            &property_path(path, name),
            extras,
        );
        if !nested.is_compatible() {
            return nested;
        }
    }
    accepts_additional_domains(
        wider.additional.as_ref(),
        narrower.additional.as_ref(),
        path,
        extras,
    )
}

fn accepts_additional(
    wider: Option<&AdditionalProperties>,
    narrower: Option<&SchemaAst>,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    match wider {
        None | Some(AdditionalProperties::Allowed(true)) => Compatibility::Compatible,
        Some(AdditionalProperties::Allowed(false)) => {
            incompatible(path, "additional property is not accepted")
        }
        Some(AdditionalProperties::Schema(wide)) => narrower.map_or_else(
            || incompatible(path, "additional property is not constrained enough"),
            |narrow| accepts_ast(wide, narrow, path, extras),
        ),
    }
}

fn accepts_additional_domains(
    wider: Option<&AdditionalProperties>,
    narrower: Option<&AdditionalProperties>,
    path: &str,
    extras: ExtraProperties,
) -> Compatibility {
    match narrower {
        Some(AdditionalProperties::Allowed(false)) => Compatibility::Compatible,
        Some(AdditionalProperties::Schema(narrow)) => accepts_additional(
            wider,
            Some(narrow),
            &format!("{path}.additionalProperties"),
            extras,
        ),
        None | Some(AdditionalProperties::Allowed(true)) => match wider {
            None | Some(AdditionalProperties::Allowed(true)) => Compatibility::Compatible,
            _ => incompatible(
                format!("{path}.additionalProperties"),
                "open additional properties are not accepted",
            ),
        },
    }
}
