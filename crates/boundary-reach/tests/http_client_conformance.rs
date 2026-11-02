//! Round-trips the blocking HTTP client against a small in-process
//! server, so the client half of `docs/spec/06-http-framing.md` is checked
//! against real bytes on a real socket rather than only against values.
#![cfg(feature = "client")]
#![allow(clippy::expect_used)]

use std::io::{BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

use boundary_core::lifecycle::project;
use boundary_core::lifecycle::{
    BindResult, BindingManifest, InstallationContribution, InstallationId, admit_all, bind, install,
};
use boundary_reach::{
    MANIFEST_CACHE_CONTROL, RESPONSE_CONTENT_TYPE, Transport, fetch_manifest, invoke, manifest_etag,
};
use serde_json::{Value, json};

/// One recorded request, so a test can assert on what the client actually
/// sent as well as script what the server sends back.
struct RecordedRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> RecordedRequest {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut request_line = String::new();
    read_line(&mut reader, &mut request_line);
    let mut parts = request_line.split_whitespace();
    let method = parts.next().expect("method").to_owned();
    let path = parts.next().expect("path").to_owned();

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        read_line(&mut reader, &mut line);
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').expect("header line");
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }

    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(0, |(_, value)| {
            value.parse().expect("content-length is a number")
        });
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).expect("read request body");

    RecordedRequest {
        method,
        path,
        headers,
        body,
    }
}

fn read_line(reader: &mut BufReader<TcpStream>, out: &mut String) {
    use std::io::BufRead;
    let mut raw = String::new();
    reader.read_line(&mut raw).expect("read line");
    raw.trim_end_matches(['\r', '\n']).clone_into(out);
}

fn write_response(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &[u8]) {
    use std::fmt::Write as _;
    let mut head = format!("HTTP/1.1 {status} \r\nContent-Length: {}\r\n", body.len());
    for (name, value) in headers {
        let _ = write!(head, "{name}: {value}\r\n");
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).expect("write head");
    stream.write_all(body).expect("write body");
    stream.flush().expect("flush");
}

/// Starts a server that accepts exactly one connection, hands the recorded
/// request to `respond`, and writes back whatever it returns.
fn serve_once(
    respond: impl FnOnce(RecordedRequest) -> (u16, Vec<(&'static str, String)>, Vec<u8>)
    + Send
    + 'static,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("local address").port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept one connection");
        let request = read_request(&mut stream);
        let (status, headers, body) = respond(request);
        let borrowed: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
            .collect();
        write_response(&mut stream, status, &borrowed, &body);
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

/// A real, minimal, self-consistent Binding manifest: no interactions, built
/// through the crate's own atomic pipeline rather than hand-assembled, so its
/// digest and shape are authentic.
fn empty_binding_manifest() -> BindingManifest {
    let projection = project(Vec::new()).expect("project an empty surface");
    let installed = install(
        InstallationId::new("test:install:1").expect("installation id"),
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

fn returned_outcome(binding_digest: &str) -> Value {
    json!({
        "version": 1,
        "bindingDigest": binding_digest,
        "installationId": "test:install:1",
        "interactionId": "todos.create",
        "expectedContractDigest": format!("sha256:{}", "a".repeat(64)),
        "actualContractDigest": format!("sha256:{}", "a".repeat(64)),
        "mode": "direct",
        "realizationId": "realize:1",
        "certainty": "completed",
        "result": { "kind": "returned", "value": { "id": "todo-1" } }
    })
}

fn declared_error_outcome(binding_digest: &str) -> Value {
    json!({
        "version": 1,
        "bindingDigest": binding_digest,
        "installationId": "test:install:1",
        "interactionId": "todos.create",
        "expectedContractDigest": format!("sha256:{}", "a".repeat(64)),
        "actualContractDigest": format!("sha256:{}", "a".repeat(64)),
        "mode": "direct",
        "realizationId": "realize:1",
        "certainty": "completed",
        "result": { "kind": "declared-error", "code": "TITLE_TAKEN", "details": {} }
    })
}

fn invocation_json(binding_digest: &str) -> Value {
    json!({
        "version": 1,
        "bindingDigest": binding_digest,
        "installationId": "test:install:1",
        "interactionId": "todos.create",
        "expectedContractDigest": format!("sha256:{}", "a".repeat(64)),
        "actualContractDigest": format!("sha256:{}", "a".repeat(64)),
        "mode": "direct",
        "realizationId": "realize:1",
        "input": { "title": "write the framing client" }
    })
}

#[test]
fn fetches_a_manifest_and_its_matching_etag() {
    let manifest = empty_binding_manifest();
    let digest = manifest.binding_digest().as_str().to_owned();
    let etag = manifest_etag(&digest);
    let body = serde_json::to_vec(&manifest).expect("serialize the manifest");

    let (base, handle) = serve_once(move |request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/boundary/v1/manifest");
        (
            200,
            vec![
                ("Content-Type", RESPONSE_CONTENT_TYPE.to_owned()),
                ("Cache-Control", MANIFEST_CACHE_CONTROL.to_owned()),
                ("ETag", etag.clone()),
            ],
            body,
        )
    });

    let transport = Transport::Http {
        url: format!("{base}/boundary/v1"),
    };
    let fetched = fetch_manifest(&transport).expect("fetches the manifest");
    assert_eq!(fetched.binding_digest().as_str(), digest);
    handle.join().expect("server thread completes");
}

#[test]
fn a_returned_outcome_round_trips_on_200() {
    let digest = format!("sha256:{}", "b".repeat(64));
    let outcome_body = serde_json::to_vec(&returned_outcome(&digest)).expect("serialize outcome");

    let (base, handle) = serve_once(move |request| {
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/boundary/v1/invoke");
        assert!(!request.body.is_empty(), "the invocation body must be sent");
        assert!(
            request
                .headers
                .iter()
                .any(|(name, value)| name == "content-type" && value == "application/json"),
            "the request must declare its JSON content type"
        );
        (
            200,
            vec![("Content-Type", RESPONSE_CONTENT_TYPE.to_owned())],
            outcome_body,
        )
    });

    let transport = Transport::Http {
        url: format!("{base}/boundary/v1"),
    };
    let invocation = serde_json::from_value(invocation_json(&digest)).expect("build invocation");
    let outcome = invoke(&transport, &invocation).expect("reads the outcome");
    assert_eq!(
        serde_json::to_value(outcome.result()).expect("result to value")["kind"],
        "returned"
    );
    handle.join().expect("server thread completes");
}

#[test]
fn a_declared_error_round_trips_on_422_rather_than_erroring() {
    let digest = format!("sha256:{}", "c".repeat(64));
    let outcome_body =
        serde_json::to_vec(&declared_error_outcome(&digest)).expect("serialize outcome");

    let (base, handle) = serve_once(move |_request| {
        (
            422,
            vec![("Content-Type", RESPONSE_CONTENT_TYPE.to_owned())],
            outcome_body,
        )
    });

    let transport = Transport::Http {
        url: format!("{base}/boundary/v1"),
    };
    let invocation = serde_json::from_value(invocation_json(&digest)).expect("build invocation");
    // A 422 still carries a valid outcome envelope, so the client must read
    // it as one rather than treating the status as a transport failure.
    let outcome = invoke(&transport, &invocation).expect("reads the outcome despite the status");
    let result = serde_json::to_value(outcome.result()).expect("result to value");
    assert_eq!(result["kind"], "declared-error");
    assert_eq!(result["code"], "TITLE_TAKEN");
    handle.join().expect("server thread completes");
}

#[test]
fn a_rejection_before_an_outcome_exists_is_reported_as_a_rejection() {
    let digest = format!("sha256:{}", "d".repeat(64));
    let rejection_body = serde_json::to_vec(&json!({
        "error": {
            "kind": "protocol",
            "code": "ROUTE_NOT_FOUND",
            "path": "request.url",
            "message": "No version 1 protocol route matched."
        }
    }))
    .expect("serialize rejection");

    let (base, handle) = serve_once(move |_request| (404, Vec::new(), rejection_body));

    let transport = Transport::Http {
        url: format!("{base}/boundary/v1"),
    };
    let invocation = serde_json::from_value(invocation_json(&digest)).expect("build invocation");
    let error = invoke(&transport, &invocation).expect_err("a rejection is not an outcome");
    assert!(
        matches!(error, boundary_reach::ClientError::Rejected { .. }),
        "expected a rejection, got {error:?}"
    );
    handle.join().expect("server thread completes");
}

#[test]
fn an_https_transport_attempts_tls_rather_than_downgrading_or_claiming_unsupported() {
    let transport = Transport::Http {
        url: "https://example.invalid/boundary/v1".to_owned(),
    };
    let error = fetch_manifest(&transport).expect_err("https must not silently succeed");
    assert!(
        !matches!(error, boundary_reach::ClientError::UnsupportedScheme { .. }),
        "https is TLS now, not an unsupported scheme; got {error:?}"
    );
    assert!(
        matches!(error, boundary_reach::ClientError::Io { .. }),
        "an unresolvable https origin is a connection failure, got {error:?}"
    );
}
