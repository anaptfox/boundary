//! `contract_changes`: where two contract declarations differ, and whether
//! callers of the older one can still be bound. Native declaration diagnostic;
//! no shared portable output guarantee (it has no wire form).
#![allow(clippy::expect_used)]

use boundary_core::{ChangeKind, InteractionContract, contract_changes};
use serde_json::{Value, json};

fn contract(output_properties: &Value, reads: &[&str]) -> InteractionContract {
    serde_json::from_value(json!({
        "version": 1,
        "id": "feed.list",
        "inputSchema": {"type": "object", "additionalProperties": false},
        "outputSchema": {
            "type": "object",
            "properties": output_properties,
            "required": ["title"],
        },
        "reads": reads,
        "changes": [],
    }))
    .expect("valid contract")
}

#[test]
fn identical_contracts_have_no_changes() {
    let a = contract(&json!({"title": {"type": "string"}}), &["store"]);
    let delta = contract_changes(&a, &a.clone());
    assert!(delta.is_empty());
    assert!(delta.existing_callers.is_compatible());
}

#[test]
fn an_added_optional_output_field_is_named_and_keeps_existing_callers() {
    let before = contract(&json!({"title": {"type": "string"}}), &["store"]);
    let after = contract(
        &json!({
            "title": {"type": "string"},
            "reply_url": {"type": "string"},
        }),
        &["store"],
    );
    let delta = contract_changes(&before, &after);
    let paths: Vec<(&str, ChangeKind)> = delta
        .changes
        .iter()
        .map(|c| (c.path.as_str(), c.kind))
        .collect();
    assert_eq!(
        paths,
        [("outputSchema.properties.reply_url", ChangeKind::Added)]
    );
    assert!(
        delta.existing_callers.is_compatible(),
        "{:?}",
        delta.existing_callers
    );
}

#[test]
fn a_wider_footprint_is_named_and_breaks_existing_callers() {
    let before = contract(&json!({"title": {"type": "string"}}), &["store"]);
    let after = contract(&json!({"title": {"type": "string"}}), &["github", "store"]);
    let delta = contract_changes(&before, &after);
    assert_eq!(delta.changes.len(), 1);
    assert_eq!(delta.changes[0].path, "reads");
    assert_eq!(delta.changes[0].kind, ChangeKind::Changed);
    assert!(!delta.existing_callers.is_compatible());
}

#[test]
fn a_removed_field_is_named() {
    let before = contract(
        &json!({"title": {"type": "string"}, "url": {"type": "string"}}),
        &[],
    );
    let after = contract(&json!({"title": {"type": "string"}}), &[]);
    let delta = contract_changes(&before, &after);
    assert_eq!(delta.changes[0].path, "outputSchema.properties.url");
    assert_eq!(delta.changes[0].kind, ChangeKind::Removed);
}
