//! Emits Reach record cases as JSON so the reviewed vector can be checked
//! against exact digests. Run:
//! `cargo run -p boundary-reach --example emit-reach-cases`.
#![allow(clippy::expect_used)]

use boundary_reach::{ReachRecord, Transport};
use serde_json::{Value, json};

fn case(name: &str, transports: &[Transport]) -> Value {
    let record = ReachRecord::new(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "deploy:example:1",
        transports.to_vec(),
    )
    .expect("record");
    json!({
        "name": name,
        "input": {
            "bindingDigest": record.binding_digest(),
            "installationId": record.installation_id(),
            "transports": transports,
        },
        "expected": {
            "reachDigest": record.reach_digest(),
            "transports": record.transports(),
        }
    })
}

fn main() {
    let unix = Transport::Unix {
        path: "/tmp/boundary.sock".to_owned(),
        base: "/boundary/v1".to_owned(),
    };
    let http = Transport::Http {
        url: "https://host.invalid/boundary/v1".to_owned(),
    };

    let cases = json!([
        case("unix-only", std::slice::from_ref(&unix)),
        case("http-only", std::slice::from_ref(&http)),
        // Listed http-first on purpose: the record must sort, so this and a
        // unix-first listing are the same record.
        case("both-listed-http-first", &[http.clone(), unix.clone()]),
        case("both-listed-unix-first", &[unix.clone(), http.clone()]),
    ]);
    println!(
        "{}",
        serde_json::to_string_pretty(&cases).expect("serialize")
    );
}
