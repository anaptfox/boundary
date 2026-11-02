//! Emits Draft cases as JSON so the reviewed vector can be checked against
//! exact digests. Run:
//! `cargo run -p boundary-core --example emit-draft-cases --all-features`.
#![allow(clippy::expect_used)]

use boundary_core::{Draft, InteractionContract, PortableSchema};
use serde_json::{Value, json};

fn schema(properties: &[(&str, &str)], required: &[&str]) -> PortableSchema {
    let mut props = serde_json::Map::new();
    for (name, kind) in properties {
        props.insert((*name).to_owned(), json!({ "type": kind }));
    }
    PortableSchema::from_value(json!({
        "type": "object",
        "properties": Value::Object(props),
        "required": required,
        "additionalProperties": false,
    }))
    .expect("schema")
}

fn case(
    name: &str,
    contract: InteractionContract,
    gap: &str,
    proposer: &str,
    created_at: &str,
) -> Value {
    let contract_value = serde_json::to_value(&contract).expect("contract to value");
    let draft = Draft::new(contract, gap, proposer, created_at).expect("draft");
    json!({
        "name": name,
        "input": {
            "contract": contract_value,
            "gap": draft.gap(),
            "proposer": draft.proposer(),
            "createdAt": draft.created_at(),
        },
        "expected": {
            "draftDigest": draft.draft_digest().as_str(),
        }
    })
}

fn main() {
    let archive = InteractionContract::builder(
        "todos.archive",
        schema(&[("id", "string")], &["id"]),
        schema(
            &[("id", "string"), ("archivedAt", "string")],
            &["id", "archivedAt"],
        ),
    )
    .reads(["todos"])
    .changes(["todos"])
    .finish()
    .expect("archive contract");

    let archive_with_error = InteractionContract::builder(
        "todos.archive",
        schema(&[("id", "string")], &["id"]),
        schema(
            &[("id", "string"), ("archivedAt", "string")],
            &["id", "archivedAt"],
        ),
    )
    .error_schema(schema(&[("code", "string")], &["code"]))
    .reads(["todos"])
    .changes(["todos"])
    .finish()
    .expect("archive-with-error contract");

    let refund = InteractionContract::builder(
        "billing.refund",
        schema(&[("orderId", "string")], &["orderId"]),
        schema(
            &[("orderId", "string"), ("refunded", "boolean")],
            &["orderId", "refunded"],
        ),
    )
    .reads(["billing.accounts", "billing.ledger"])
    .changes(["billing.ledger"])
    .finish()
    .expect("refund contract");

    let pin = InteractionContract::builder(
        "notes.pin",
        schema(&[("noteId", "string")], &["noteId"]),
        schema(
            &[("noteId", "string"), ("pinned", "boolean")],
            &["noteId", "pinned"],
        ),
    )
    .changes(["notes"])
    .finish()
    .expect("pin contract");

    let cases = json!([
        case(
            "todos-archive",
            archive,
            "Only delete exists today; archive would keep history instead of removing the row.",
            "agent:catalog-bot",
            "2026-09-06T12:00:00Z",
        ),
        case(
            "todos-archive-with-error",
            archive_with_error,
            "Archive would also need a documented failure mode for todos already archived.",
            "agent:catalog-bot",
            "2026-09-06T12:00:00.500+02:00",
        ),
        case(
            "billing-refund",
            refund,
            "No refund flow exists; support has been running manual reversals.",
            "human:reviewer-1",
            "2020-02-29T23:59:60Z",
        ),
        case(
            "notes-pin",
            pin,
            "Pinning UI exists but there is no interaction contract wiring it yet.",
            "human:designer",
            "2026-01-01T00:00:00Z",
        ),
    ]);
    println!(
        "{}",
        serde_json::to_string_pretty(&cases).expect("serialize")
    );
}
