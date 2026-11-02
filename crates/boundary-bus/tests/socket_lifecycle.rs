//! The bus over a real Unix socket: registration, lookup, and liveness.
//!
//! These use an actual listener and actual client connections rather than an
//! in-memory double, because the property under test is precisely what happens
//! when a socket closes.
#![cfg(unix)]
#![allow(clippy::expect_used, clippy::panic)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use boundary_bus::{BusClient, BusServer, PossessionProof, Request, Response};
use boundary_reach::{ReachRecord, Transport};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A possession proof that accepts every claim.
///
/// These tests are about socket lifecycle, not about ownership, and the real
/// proof dials the address a record names. Standing up an HTTP surface per
/// test would test the transport rather than the thing under test here.
/// Possession itself is pinned separately, below.
fn accept_any() -> PossessionProof {
    std::sync::Arc::new(|_record| Ok(()))
}

/// A private socket path for one test. Each test gets its own directory so
/// they can run in parallel without sharing a listener.
fn socket_path() -> PathBuf {
    let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
    let mut path = std::env::temp_dir();
    path.push(format!("boundary-bus-test-{}-{unique}", std::process::id()));
    path.push("bus.sock");
    path
}

fn record(byte: char, url: &str) -> ReachRecord {
    ReachRecord::new(
        format!("sha256:{}", String::from(byte).repeat(64)),
        "deploy:test:1",
        [Transport::Http {
            url: url.to_owned(),
        }],
    )
    .expect("record")
}

/// Runs the bus on a background thread and returns its socket path.
fn start() -> (
    PathBuf,
    std::sync::Arc<std::sync::Mutex<boundary_bus::Registry>>,
) {
    let path = socket_path();
    let server = BusServer::bind_with_possession(&path, accept_any()).expect("bus binds");
    let registry = server.registry();
    std::thread::spawn(move || {
        // The server is moved here and dropped when this thread ends, which
        // removes the socket file.
        let _ = server.serve_forever();
    });
    (path, registry)
}

#[test]
fn the_socket_directory_is_private_to_this_user() {
    let path = socket_path();
    let server = BusServer::bind_with_possession(&path, accept_any()).expect("bus binds");
    let parent = path.parent().expect("parent");

    let mode = std::fs::metadata(parent)
        .expect("directory exists")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o700,
        "the kernel, not the bus, must refuse another user's connect"
    );
    drop(server);
}

#[test]
fn a_registered_record_is_listed_by_another_client() {
    let (path, _registry) = start();

    let mut host = BusClient::connect(&path).expect("host connects");
    let response = host
        .send(&Request::Register {
            record: Box::new(record('1', "https://a.invalid/boundary")),
        })
        .expect("register");
    assert_eq!(response, Response::ok());

    // A separate connection, standing in for `boundary list`.
    let mut caller = BusClient::connect(&path).expect("caller connects");
    let listed = caller.send(&Request::List).expect("list");
    match listed {
        Response::Ok { records } => {
            assert_eq!(records.len(), 1);
            assert_eq!(
                records[0].transports()[0],
                Transport::Http {
                    url: "https://a.invalid/boundary".to_owned()
                }
            );
        }
        other @ Response::Error { .. } => unreachable!("expected records, got {other:?}"),
    }
}

#[test]
fn closing_a_host_connection_withdraws_its_records() {
    let (path, _registry) = start();

    let entry = record('2', "https://b.invalid/boundary");
    {
        let mut host = BusClient::connect(&path).expect("host connects");
        host.send(&Request::Register {
            record: Box::new(entry),
        })
        .expect("register");

        let mut caller = BusClient::connect(&path).expect("caller connects");
        let listed = caller.send(&Request::List).expect("list");
        assert!(matches!(listed, Response::Ok { ref records } if records.len() == 1));
        // `host` drops here: the process announcing the address has gone away.
    }

    // Poll briefly: withdrawal happens on the serving thread once the peer
    // closes, so it is not instantaneous from this side.
    let mut caller = BusClient::connect(&path).expect("caller reconnects");
    let mut remaining = usize::MAX;
    for _ in 0..200 {
        match caller.send(&Request::List).expect("list") {
            Response::Ok { records } => {
                remaining = records.len();
                if remaining == 0 {
                    break;
                }
            }
            other @ Response::Error { .. } => unreachable!("expected records, got {other:?}"),
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(
        remaining, 0,
        "an address whose host exited must stop being reachable, with no heartbeat protocol"
    );
}

#[test]
fn a_host_can_withdraw_its_own_record_explicitly() {
    let (path, _registry) = start();
    let entry = record('3', "https://c.invalid/boundary");
    let digest = entry.binding_digest().to_owned();

    let mut host = BusClient::connect(&path).expect("host connects");
    host.send(&Request::Register {
        record: Box::new(entry),
    })
    .expect("register");

    // This is what revocation looks like from the bus's side.
    let response = host
        .send(&Request::Unregister {
            binding_digest: digest,
        })
        .expect("unregister");
    assert_eq!(response, Response::ok());

    let listed = host.send(&Request::List).expect("list");
    assert!(matches!(listed, Response::Ok { ref records } if records.is_empty()));
}

#[test]
fn one_connection_cannot_withdraw_another_connections_record() {
    let (path, _registry) = start();
    let entry = record('4', "https://d.invalid/boundary");
    let digest = entry.binding_digest().to_owned();

    let mut host = BusClient::connect(&path).expect("host connects");
    host.send(&Request::Register {
        record: Box::new(entry),
    })
    .expect("register");

    let mut other = BusClient::connect(&path).expect("other connects");
    let response = other
        .send(&Request::Unregister {
            binding_digest: digest,
        })
        .expect("exchange");
    match response {
        Response::Error { code, .. } => assert_eq!(code, "UNREGISTER_REFUSED"),
        other @ Response::Ok { .. } => unreachable!("expected a refusal, got {other:?}"),
    }

    // The address is still there.
    let listed = host.send(&Request::List).expect("list");
    assert!(matches!(listed, Response::Ok { ref records } if records.len() == 1));
}

#[test]
fn a_malformed_line_is_refused_without_dropping_the_connection() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let (path, _registry) = start();
    let mut stream = UnixStream::connect(&path).expect("connects");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));

    stream.write_all(b"not json\n").expect("write");
    stream.flush().expect("flush");
    let mut line = String::new();
    reader.read_line(&mut line).expect("read");
    let response: Response = serde_json::from_str(&line).expect("parses");
    match response {
        Response::Error { code, .. } => assert_eq!(code, "INVALID_REQUEST"),
        other @ Response::Ok { .. } => unreachable!("expected a refusal, got {other:?}"),
    }

    // The connection survives, so one bad line does not cost a host its
    // registrations.
    stream.write_all(b"{\"op\":\"list\"}\n").expect("write");
    stream.flush().expect("flush");
    line.clear();
    reader.read_line(&mut line).expect("read");
    assert!(serde_json::from_str::<Response>(&line).is_ok());
}

#[test]
fn an_overlong_line_is_refused_without_taking_the_daemon_down() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let (path, _registry) = start();
    let mut stream = UnixStream::connect(&path).expect("connects");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));

    // 64 KiB is the intended per-line cap. One extra byte plus a newline is
    // enough to prove the reader must refuse rather than buffer the line.
    let mut overlong = vec![b'x'; 64 * 1024 + 1];
    overlong.push(b'\n');
    stream.write_all(&overlong).expect("write");
    stream.flush().expect("flush");

    let mut line = String::new();
    reader.read_line(&mut line).expect("read");
    let response: Response = serde_json::from_str(&line).expect("parses");
    match response {
        Response::Error { code, .. } => assert_eq!(code, "LINE_TOO_LONG"),
        other @ Response::Ok { .. } => unreachable!("expected a refusal, got {other:?}"),
    }

    let mut caller = BusClient::connect(&path).expect("later client connects");
    let listed = caller.send(&Request::List).expect("list after overlong");
    assert!(
        matches!(listed, Response::Ok { ref records } if records.is_empty()),
        "the daemon must still serve a well-formed request"
    );
}

#[test]
fn a_second_bind_against_a_live_socket_fails_without_unlinking_it() {
    let path = socket_path();
    let first = BusServer::bind(&path).expect("first bind");
    let second = BusServer::bind(&path);
    match second {
        Err(boundary_bus::BusError::AlreadyBound { .. }) => {}
        Err(other) => panic!("expected AlreadyBound, got {other}"),
        Ok(_) => panic!("a live socket must not be stolen"),
    }

    // Connecting is the liveness proof: the first listener is still there.
    BusClient::connect(&path).expect("first server still accepts");
    drop(first);
}

/// Serves one fixed HTTP response on a loopback port for as long as the test
/// keeps the handle. Enough to prove possession, or fail to.
fn serve_manifest(body: String) -> (String, std::thread::JoinHandle<()>) {
    serve_manifest_with_etag(body, None)
}

fn serve_manifest_with_etag(
    body: String,
    etag: Option<String>,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let handle = std::thread::spawn(move || {
        use std::io::{Read as _, Write as _};
        // One request is all a possession check makes.
        if let Ok((mut stream, _)) = listener.accept() {
            let mut scratch = [0u8; 2048];
            let _ = stream.read(&mut scratch);
            let etag_header = etag
                .as_deref()
                .map(|value| format!("ETag: {value}\r\n"))
                .unwrap_or_default();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{etag_header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (format!("http://127.0.0.1:{port}/boundary/v1"), handle)
}

/// First registration of a digest is otherwise unauthenticated, and binding
/// digests are content-derived and published. Without a possession proof any
/// process running as this user could claim a legitimate application's digest
/// before it starts and capture every input a caller sends.
#[test]
fn a_squatter_cannot_claim_a_digest_it_cannot_serve() {
    // The squatter serves a manifest for a *different* binding than the one
    // it claims — the realistic case, since it has to serve something.
    let served = format!("sha256:{}", "b".repeat(64));
    let (url, _server) = serve_manifest(format!(
        "{{\"version\":1,\"bindingDigest\":{served:?},\"installationId\":\"deploy:other:1\",\"interactions\":[]}}"
    ));

    let path = socket_path();
    let bus = BusServer::bind(&path).expect("bus binds");
    let socket = bus.path().to_path_buf();
    std::thread::spawn(move || {
        let _ = bus.serve_forever();
    });
    while std::os::unix::net::UnixStream::connect(&socket).is_err() {
        std::thread::yield_now();
    }

    let mut client = BusClient::connect(&socket).expect("client connects");
    let claimed = record('a', &url);
    let response = client
        .send(&Request::Register {
            record: Box::new(claimed),
        })
        .expect("the bus answers");

    match response {
        Response::Error { code, message } => {
            assert_eq!(code, "NOT_POSSESSED", "{message}");
        }
        Response::Ok { .. } => {
            panic!("a digest the registrant cannot serve must not be registered")
        }
    }
}

/// The other half: a host that really does serve the Binding it claims
/// registers normally. A proof that refused everything would be no proof.
#[test]
fn a_host_that_serves_its_own_binding_registers() {
    // The reviewed host-lifecycle vector carries a real Binding manifest, so
    // the surface this test stands up serves something a validating client
    // actually accepts rather than a hand-shaped stub.
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/host-lifecycle.json"
    ))
    .expect("vector parses");
    let manifest = &vector["artifacts"]["binding"];
    let digest = manifest["bindingDigest"]
        .as_str()
        .expect("binding digest")
        .to_owned();
    let body = serde_json::to_string(manifest).expect("manifest encodes");
    let (url, _server) = serve_manifest_with_etag(body, Some(format!("\"{digest}\"")));

    let path = socket_path();
    let bus = BusServer::bind(&path).expect("bus binds");
    let socket = bus.path().to_path_buf();
    std::thread::spawn(move || {
        let _ = bus.serve_forever();
    });
    while std::os::unix::net::UnixStream::connect(&socket).is_err() {
        std::thread::yield_now();
    }

    let mut client = BusClient::connect(&socket).expect("client connects");
    let owned =
        ReachRecord::new(digest, "deploy:test:1", [Transport::Http { url }]).expect("record");
    let response = client
        .send(&Request::Register {
            record: Box::new(owned),
        })
        .expect("the bus answers");
    assert!(
        matches!(response, Response::Ok { .. }),
        "a genuine host must still register, got {response:?}"
    );
}
