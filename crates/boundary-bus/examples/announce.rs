//! Announces that a running surface is reachable, the way a host does.
//!
//! A real host does this at install time from inside its own process. This
//! example exists so the bus can be exercised against a surface served by
//! another language, and to show the shape: build a Reach record for the
//! Binding you just created, register it, and hold the connection.
//!
//! Holding the connection is the point. The registration lives exactly as long
//! as this process does; when it exits, the address stops being reachable
//! without anyone sending a withdrawal.
//!
//! ```console
//! cargo run -p boundary-bus --example announce -- \
//!     /tmp/boundary/bus.sock https://host.invalid/boundary/v1 sha256:<binding> deploy:app:1
//! ```
#![cfg(unix)]
#![allow(clippy::expect_used)]

use boundary_bus::{BusClient, Request};
use boundary_reach::{ReachRecord, Transport};

fn main() {
    let mut arguments = std::env::args().skip(1);
    let socket = arguments
        .next()
        .expect("usage: announce <socket> <url> <bindingDigest> <installationId>");
    let url = arguments.next().expect("url is required");
    let binding_digest = arguments.next().expect("bindingDigest is required");
    let installation_id = arguments.next().expect("installationId is required");

    let record = ReachRecord::new(binding_digest, installation_id, [Transport::Http { url }])
        .expect("reach record");
    let mut client = BusClient::connect(&socket).expect("the bus is running");
    let response = client
        .send(&Request::Register {
            record: Box::new(record),
        })
        .expect("register");
    println!(
        "{}",
        serde_json::to_string(&response).expect("encode response")
    );

    // Block until stdin closes. Exiting withdraws the record.
    println!("announced; close stdin to withdraw");
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
}
