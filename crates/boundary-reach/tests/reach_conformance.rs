//! Consumes the reviewed Reach record vector.
//!
//! A Reach record is the answer to "where is this Binding", asked without
//! reopening what the Binding pinned. These tests hold the record to one
//! reviewed identity so a TypeScript host and a Rust host issue records the
//! other can read.
#![allow(clippy::expect_used)]

use boundary_reach::{ReachError, ReachRecord, Transport};
use serde_json::Value;

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../tests/conformance/v1/reach.json"))
        .expect("reach vector parses")
}

fn transports_from(value: &Value) -> Vec<Transport> {
    value
        .as_array()
        .expect("transports")
        .iter()
        .map(|entry| {
            serde_json::from_value(entry.clone()).expect("reviewed transport deserializes")
        })
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().expect("reviewed field is a string")
}

#[test]
fn every_reviewed_record_matches_its_digest_and_ordering() {
    let vector = vector();
    let cases = vector["cases"].as_array().expect("cases");
    assert_ne!(cases.as_slice(), [] as [serde_json::Value; 0]);

    for case in cases {
        let name = text(case, "name");
        let input = &case["input"];
        let record = ReachRecord::new(
            text(input, "bindingDigest"),
            text(input, "installationId"),
            transports_from(&input["transports"]),
        )
        .unwrap_or_else(|error| unreachable!("case {name} must build: {error}"));

        assert_eq!(
            record.reach_digest(),
            text(&case["expected"], "reachDigest"),
            "case {name}: digest"
        );
        assert_eq!(
            record.transports(),
            transports_from(&case["expected"]["transports"]),
            "case {name}: transports are stored sorted"
        );
        record
            .verify()
            .unwrap_or_else(|error| unreachable!("case {name} must verify: {error}"));
    }
}

#[test]
fn listing_order_does_not_change_a_record() {
    let vector = vector();
    let cases = vector["cases"].as_array().expect("cases");
    let digest = |name: &str| -> String {
        cases
            .iter()
            .find(|case| text(case, "name") == name)
            .map(|case| text(&case["expected"], "reachDigest").to_owned())
            .expect("case present")
    };
    // Two hosts listing the same addresses in a different order describe the
    // same place, so they must produce the same record.
    assert_eq!(
        digest("both-listed-http-first"),
        digest("both-listed-unix-first")
    );
}

#[test]
fn different_places_are_different_records() {
    let vector = vector();
    let cases = vector["cases"].as_array().expect("cases");
    let mut digests: Vec<&str> = cases
        .iter()
        .map(|case| text(&case["expected"], "reachDigest"))
        .collect();
    digests.sort_unstable();
    digests.dedup();
    // Four cases, three distinct places: the two orderings collapse.
    assert_eq!(digests.len(), 3);
}

#[test]
fn every_reviewed_refusal_is_refused() {
    let vector = vector();
    for case in vector["refusals"].as_array().expect("refusals") {
        let name = text(case, "name");
        let error = ReachRecord::new(
            text(case, "bindingDigest"),
            text(case, "installationId"),
            transports_from(&case["transports"]),
        )
        .err()
        .unwrap_or_else(|| unreachable!("case {name} must be refused"));

        match text(&case["expected"], "status") {
            "empty" => {
                let expected_field = text(&case["expected"], "field");
                assert_eq!(
                    error,
                    ReachError::Empty {
                        field: match expected_field {
                            "bindingDigest" => "bindingDigest",
                            "installationId" => "installationId",
                            other => unreachable!("unknown reviewed field {other:?}"),
                        }
                    },
                    "case {name}"
                );
            }
            "no-transports" => assert_eq!(error, ReachError::NoTransports, "case {name}"),
            "transport" => assert!(
                matches!(error, ReachError::Transport { .. }),
                "case {name}: expected a transport failure, got {error:?}"
            ),
            other => unreachable!("unknown reviewed refusal status {other:?}"),
        }
    }
}

#[test]
fn a_record_survives_serialization_and_still_verifies() {
    let record = ReachRecord::new(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "deploy:example:1",
        [Transport::Http {
            url: "https://host.invalid/boundary/v1".to_owned(),
        }],
    )
    .expect("record");

    let encoded = serde_json::to_string(&record).expect("serializes");
    let decoded: ReachRecord = serde_json::from_str(&encoded).expect("deserializes");
    assert_eq!(decoded, record);
    decoded.verify().expect("a round-tripped record verifies");

    // Version 1 records are unsigned, so the reserved field is absent from the
    // wire rather than present and null.
    let raw: Value = serde_json::from_str(&encoded).expect("parses");
    assert!(raw.get("signature").is_none());
}

#[test]
fn a_tampered_record_fails_verification() {
    let record = ReachRecord::new(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "deploy:example:1",
        [Transport::Http {
            url: "https://host.invalid/boundary/v1".to_owned(),
        }],
    )
    .expect("record");

    // Redirect the record at a different origin while keeping its digest.
    let mut raw: Value = serde_json::to_value(&record).expect("to value");
    raw["transports"][0]["url"] = Value::String("https://attacker.invalid/boundary/v1".to_owned());
    let tampered: ReachRecord = serde_json::from_value(raw).expect("deserializes");

    // The digest no longer describes the content. This is not authentication —
    // an attacker who can rewrite the record can recompute the digest — it
    // catches corruption and accidental drift, which is all an unsigned
    // record claims to do.
    assert!(tampered.verify().is_err());
}

#[test]
fn a_record_carries_no_authority() {
    let record = ReachRecord::new(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "deploy:example:1",
        [Transport::Unix {
            path: "/tmp/boundary.sock".to_owned(),
            base: "/boundary/v1".to_owned(),
        }],
    )
    .expect("record");

    let raw = serde_json::to_value(&record).expect("to value");
    let object = raw.as_object().expect("object");
    // An address, not a key. Nothing here is context, a credential, an
    // admission decision, or a grant.
    for forbidden in [
        "context",
        "credentials",
        "token",
        "admission",
        "grant",
        "policy",
        "actor",
    ] {
        assert!(
            !object.contains_key(forbidden),
            "a reach record must not carry {forbidden}"
        );
    }
    // The complete field set, so a future addition has to come through here.
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "bindingDigest",
            "installationId",
            "reachDigest",
            "transports",
            "version",
        ]
    );
}
