//! End-to-end checks of `boundary call` against the real binary, a real bus, and a
//! real (if interaction-less) Binding manifest served over a real TCP socket.
//!
//! This does not execute an interaction — that would need a compiled `Interaction`
//! and a full installation, which belongs to a runtime example rather than a
//! CLI test. It does exercise every wire this command actually crosses: the
//! bus protocol, the HTTP manifest fetch, and the resolution and error
//! reporting the command owns.
#![allow(clippy::expect_used)]

use std::io::{BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::thread;

use boundary_bus::{BusServer, Request};
use boundary_core::lifecycle::{
    BindResult, BindingManifest, InstallationContribution, InstallationId, admit_all, bind,
    install, project,
};
use boundary_reach::{ReachRecord, Transport};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_boundary"))
}

/// A short path under a private `/tmp` subdirectory rather than the platform
/// temp directory: a Unix socket path is limited to about 100 bytes, and
/// `std::env::temp_dir()` on macOS is already most of that budget. The bus
/// binds beneath a directory it creates and owns, since it `chmod`s that
/// directory `0700` and this process cannot `chmod` `/tmp` itself.
fn temp_socket_path(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .subsec_nanos();
    PathBuf::from(format!(
        "/tmp/boundary-cli-{name}-{}-{nanos}/bus.sock",
        std::process::id()
    ))
}

#[test]
fn calling_with_no_interaction_id_reports_usage() {
    let output = bin().arg("call").output().expect("runs the binary");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("usage: boundary call"),
        "expected usage in stderr, got {stderr:?}"
    );
}

#[test]
fn calling_against_an_unreachable_bus_reports_it_plainly() {
    let socket = temp_socket_path("unreachable");
    let output = bin()
        .args([
            "call",
            "todos.create",
            "--socket",
            socket.to_str().expect("utf8 path"),
        ])
        .output()
        .expect("runs the binary");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("could not reach the bus"),
        "expected an unreachable-bus message, got {stderr:?}"
    );
}

/// A real, minimal, self-consistent Binding manifest with no interactions,
/// built through the crate's own atomic pipeline.
fn empty_binding_manifest() -> BindingManifest {
    let projection = project(Vec::new()).expect("project an empty surface");
    let installed = install(
        InstallationId::new("test:install:cli").expect("installation id"),
        Vec::<InstallationContribution<()>>::new(),
    )
    .expect("install an empty contribution set");
    match bind(&projection, &installed.installation, admit_all()) {
        BindResult::Bound(bound) => bound.binding.manifest().clone(),
        BindResult::Unrealized(report) => {
            unreachable!("an empty observer always binds, got {report:?}")
        }
    }
}

/// Serves `GET {base}/manifest` a fixed number of times, then stops.
///
/// More than one, because registering now costs a fetch of its own: the bus
/// proves a registrant possesses the Binding it claims before accepting the
/// record, so `boundary call`'s own fetch is the second request this surface sees.
fn serve_manifest(manifest: BindingManifest, times: usize) -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("local address").port();
    let handle = thread::spawn(move || {
        for _ in 0..times {
            let (mut stream, _) = listener.accept().expect("accept one connection");
            // Drain the request so the client's write completes cleanly; content
            // does not matter for a manifest fetch.
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            loop {
                let mut line = String::new();
                std::io::BufRead::read_line(&mut reader, &mut line).expect("read header line");
                if line.trim().is_empty() {
                    break;
                }
            }
            let body = serde_json::to_vec(&manifest).expect("serialize manifest");
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).expect("write head");
            stream.write_all(&body).expect("write body");
            stream.flush().expect("flush");
            let _: &TcpStream = &stream; // kept alive until the response is flushed
        }
    });
    (port, handle)
}

#[test]
fn calling_an_interaction_no_reachable_binding_exposes_is_reported_precisely() {
    let manifest = empty_binding_manifest();
    let binding_digest = manifest.binding_digest().to_string();
    let (port, server) = serve_manifest(manifest, 2);

    let socket = temp_socket_path("resolution");
    let server_bus = BusServer::bind(&socket).expect("bind the bus");
    // `boundary call` opens its own connection to `list` while the registrar's
    // connection is still open (a record lives only as long as the
    // connection that registered it), so the bus needs to serve both
    // concurrently. The thread is intentionally left running for the rest of
    // the test process rather than joined: `serve_forever` never returns.
    thread::spawn(move || {
        let _ = server_bus.serve_forever();
    });

    // Register the record directly over the bus wire protocol, exactly as a
    // host would, before `boundary call` ever runs.
    let mut registrar =
        boundary_bus::BusClient::connect(&socket).expect("connect to register a record");
    let record = ReachRecord::new(
        binding_digest,
        "test:install:cli",
        [Transport::Http {
            url: format!("http://127.0.0.1:{port}/boundary/v1"),
        }],
    )
    .expect("build a reach record");
    // The bus proves possession before accepting: it fetches the manifest the
    // record points at and requires it to name the same Binding. That is why
    // the record claims the digest this surface actually serves.
    let registered = registrar
        .send(&Request::Register {
            record: Box::new(record),
        })
        .expect("the bus answers a registration");
    assert!(
        matches!(registered, boundary_bus::Response::Ok { .. }),
        "a host serving its own binding must register, got {registered:?}"
    );

    let output = bin()
        .args([
            "call",
            "todos.create",
            "--socket",
            socket.to_str().expect("utf8 path"),
        ])
        .output()
        .expect("runs the binary");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no reachable binding exposes interaction \"todos.create\""),
        "expected a precise resolution failure, got {stderr:?}"
    );

    drop(registrar);
    server.join().expect("manifest server completes");
}
