//! Stands in for a host announcing that a Binding is reachable.
//!
//! A real host does this at install time and holds the connection open for the
//! life of the Installation, because closing it withdraws the record. Run:
//! `cargo run -p boundary-bus --example register -- <socket> <url>`.
#![cfg(unix)]
#![allow(clippy::expect_used)]

use boundary_bus::{BusClient, Request};
use boundary_reach::{ReachRecord, Transport};

fn main() {
    let mut arguments = std::env::args().skip(1);
    let socket = arguments.next().expect("usage: register <socket> <url>");
    let url = arguments
        .next()
        .unwrap_or_else(|| "https://host.invalid/boundary/v1".to_owned());

    let record = ReachRecord::new(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "deploy:demo:1",
        [Transport::Http { url }],
    )
    .expect("record");

    let mut client = BusClient::connect(&socket).expect("bus is running");
    let response = client
        .send(&Request::Register {
            record: Box::new(record),
        })
        .expect("register");
    println!("{}", serde_json::to_string(&response).expect("encode"));

    // Hold the connection: the registration lives exactly as long as this
    // process does. Closing stdin ends the demo and withdraws the record.
    println!("registered; press enter to exit and withdraw");
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
}
