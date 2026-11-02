// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Real-binary CLI proofs using a real bus and bounded synthetic HTTP peers.
//! Peers validate exact invocation pins but do not execute application effects.
#![allow(clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use boundary_bus::{BusClient, Request, Response};
use boundary_core::{
    EmptyObjectCodec, Handler, Interaction, JsonCodec, NoError, ReadFootprint, ReadOnly,
    handoff::HandoffInvocation,
    lifecycle::{
        BindResult, BindingManifest, InstallationId, InteractionMode, ProjectionModes,
        RealizationId, admit_all, bind, compile_interaction, direct_realization, install, project,
        select,
    },
};
use boundary_reach::{ReachRecord, Transport};
use serde_json::{Value, json};

fn socket_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    PathBuf::from(format!(
        "/tmp/b-cli-{}-{name}-{nanos}/bus.sock",
        std::process::id()
    ))
}

fn run(args: &[&str], socket: &Path) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_boundary"))
        .args(args)
        .env("BOUNDARY_BUS_SOCKET", socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run binary");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().expect("poll binary").is_some() {
            return child.wait_with_output().expect("binary output");
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop stalled binary");
            let output = child.wait_with_output().expect("stalled output");
            panic!("CLI did not complete: {output:?}");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn command_help_and_invalid_flags_never_create_or_contact_a_bus() {
    for command in ["bus", "list", "mcp", "call"] {
        let socket = socket_path(command);
        let output = run(&[command, "--help"], &socket);
        assert!(output.status.success(), "{command}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("boundary"));
        assert!(!socket.parent().expect("parent").exists());
    }
    for command in ["bus", "list", "mcp"] {
        for flags in [
            vec!["--sockte", "ignored"],
            vec!["unexpected"],
            vec!["--socket", "--help"],
            vec!["--socket", "one", "--socket", "two"],
        ] {
            let socket = socket_path(command);
            let mut args = vec![command];
            args.extend(flags);
            let output = run(&args, &socket);
            assert!(!output.status.success(), "{args:?}: {output:?}");
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(!error.contains("could not reach the bus"), "{error}");
            assert!(!socket.parent().expect("parent").exists());
        }
    }
}

#[test]
fn invalid_or_duplicate_binding_selectors_fail_before_contacting_a_bus() {
    let socket = socket_path("binding-args");
    let digest = format!("sha256:{}", "a".repeat(64));
    for args in [
        vec!["call", "greetings.read", "--binding"],
        vec!["call", "greetings.read", "--binding", "not-a-digest"],
        vec![
            "call",
            "greetings.read",
            "--binding",
            &digest,
            "--binding",
            &digest,
        ],
    ] {
        let output = run(&args, &socket);
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{output:?}");
        assert!(error.contains("--binding"), "{error}");
        assert!(!error.contains("could not reach the bus"), "{error}");
    }
}

#[derive(Default)]
struct Greeting;
impl Interaction for Greeting {
    const ID: boundary_core::StaticInteractionId = boundary_core::interaction_id!("greetings.read");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = EmptyObjectCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["greetings"])
    }
}
struct GreetingHandler;
impl Handler<Greeting> for GreetingHandler {
    async fn handle(&self, (): &(), _: Greeting) -> Result<String, NoError> {
        Ok("hello".to_owned())
    }
}
fn manifest(name: &str) -> BindingManifest {
    let compiled = compile_interaction::<Greeting>().expect("compile");
    let projection = project([select("read", &compiled, ProjectionModes::Direct).expect("select")])
        .expect("project");
    let installed = install(
        InstallationId::new(name).expect("installation id"),
        [direct_realization(
            &compiled,
            RealizationId::new(format!("{name}/read")).expect("realization"),
            GreetingHandler,
        )],
    )
    .expect("install");
    match bind(&projection, &installed.installation, admit_all()) {
        BindResult::Bound(bound) => bound.binding.manifest().clone(),
        BindResult::Unrealized(report) => panic!("fixture must bind: {report:?}"),
    }
}

struct Host {
    transport: Transport,
    body: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Host {
    fn new(manifest: &BindingManifest) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("address").port();
        let body = Arc::new(Mutex::new(
            serde_json::to_value(manifest).expect("manifest JSON"),
        ));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (served, recorded, stopping) = (body.clone(), requests.clone(), stop.clone());
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Accepted sockets inherit O_NONBLOCK on BSD/macOS.
                        // The request reader needs blocking I/O with timeouts.
                        stream.set_nonblocking(false).expect("blocking stream");
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .expect("read timeout");
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .expect("write timeout");
                        let (method, input) = read_request(&stream);
                        recorded
                            .lock()
                            .expect("requests")
                            .push((method.clone(), input.clone()));
                        let body = served.lock().expect("body").clone();
                        let response = if method == "GET" {
                            body
                        } else {
                            let manifest: BindingManifest =
                                serde_json::from_value(body).expect("valid manifest");
                            let invocation: HandoffInvocation =
                                serde_json::from_value(input.clone()).expect("invocation");
                            let expected = HandoffInvocation::new(
                                &manifest,
                                invocation.interaction_id(),
                                InteractionMode::Direct,
                                json!({}),
                            )
                            .expect("pin invocation");
                            assert_eq!(
                                input,
                                serde_json::to_value(expected).expect("invocation JSON")
                            );
                            let mut outcome = input;
                            outcome.as_object_mut().expect("object").remove("input");
                            outcome["certainty"] = json!("completed");
                            outcome["result"] = json!({"kind":"returned", "value":"hello"});
                            outcome
                        };
                        write_response(&mut stream, &response);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept failed: {error}"),
                }
            }
        });
        Self {
            transport: Transport::Http {
                url: format!("http://127.0.0.1:{port}/boundary/v1"),
            },
            body,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn replace(&self, body: Value) {
        *self.body.lock().expect("body") = body;
    }
    fn count(&self, method: &str) -> usize {
        self.requests
            .lock()
            .expect("requests")
            .iter()
            .filter(|(found, _)| found == method)
            .count()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("host thread");
        }
    }
}

#[test]
fn host_waits_for_headers_after_accepting_a_connection() {
    let manifest = manifest("cli/delayed-headers");
    let host = Host::new(&manifest);
    let Transport::Http { url } = &host.transport else {
        panic!("HTTP fixture");
    };
    let address = url
        .strip_prefix("http://")
        .and_then(|value| value.split('/').next())
        .expect("fixture address");
    let mut stream = TcpStream::connect(address).expect("connect fixture");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    thread::sleep(Duration::from_millis(100));
    stream
        .write_all(b"GET /boundary/v1 HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .expect("delayed headers");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("response");
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    let (_, body) = response.split_once("\r\n\r\n").expect("response body");
    assert_eq!(
        serde_json::from_str::<Value>(body).expect("manifest body"),
        serde_json::to_value(manifest).expect("expected manifest")
    );
    assert_eq!(host.count("GET"), 1);
}

fn read_request(stream: &TcpStream) -> (String, Value) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("request line");
    let method = line.split_whitespace().next().expect("method").to_owned();
    let mut length = 0;
    loop {
        line.clear();
        reader.read_line(&mut line).expect("header");
        if line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().expect("length");
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).expect("body");
    (
        method,
        if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).expect("JSON")
        },
    )
}
fn write_response(stream: &mut TcpStream, value: &Value) {
    let body = serde_json::to_vec(value).expect("response JSON");
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).expect("header");
    stream.write_all(&body).expect("body");
    stream.flush().expect("flush");
}
struct TestBus {
    socket: PathBuf,
    child: std::process::Child,
}
impl std::ops::Deref for TestBus {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.socket
    }
}
impl Drop for TestBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(parent) = self.socket.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}
fn bus(name: &str) -> TestBus {
    let socket = socket_path(name);
    let child = Command::new(env!("CARGO_BIN_EXE_boundary"))
        .arg("bus")
        .arg("--socket")
        .arg(&socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start bus");
    let mut bus = TestBus { socket, child };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if BusClient::connect(&bus.socket).is_ok() {
            return bus;
        }
        assert!(
            bus.child.try_wait().expect("poll bus").is_none(),
            "bus exited early"
        );
        assert!(Instant::now() < deadline, "bus startup timed out");
        thread::sleep(Duration::from_millis(5));
    }
}

fn register(socket: &Path, manifest: &BindingManifest, host: &Host) -> BusClient {
    let mut client = BusClient::connect(socket).expect("registrar");
    let record = ReachRecord::new(
        manifest.binding_digest().to_string(),
        manifest.installation_id().as_str(),
        [host.transport.clone()],
    )
    .expect("record");
    let response = client
        .send(&Request::Register {
            record: Box::new(record),
        })
        .expect("register");
    assert!(matches!(response, Response::Ok { .. }), "{response:?}");
    client
}

#[test]
fn list_prints_interaction_ids_and_each_available_mode() {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/host-lifecycle.json"
    ))
    .expect("vector");
    let manifest: BindingManifest =
        serde_json::from_value(vector["artifacts"]["binding"].clone()).expect("manifest");
    let host = Host::new(&manifest);
    let socket = bus("list-modes");
    let _registrar = register(&socket, &manifest, &host);
    let output = run(&["list"], &socket);
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("todos.create [direct]"), "{text}");
    assert!(text.contains("todos.create [request]"), "{text}");
    assert_eq!(host.count("POST"), 0);
}

#[test]
fn list_keeps_valid_rows_and_reports_invalid_manifests_as_incomplete() {
    let (first, second) = (manifest("cli/list/valid"), manifest("cli/list/invalid"));
    let (valid, invalid) = (Host::new(&first), Host::new(&second));
    let socket = bus("list-errors");
    let _registrars = [
        register(&socket, &first, &valid),
        register(&socket, &second, &invalid),
    ];
    invalid.replace(json!({"version":1}));
    let output = run(&["list"], &socket);
    assert!(!output.status.success(), "{output:?}");
    let (text, error) = (
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(text.contains(first.binding_digest().as_str()), "{text}");
    assert!(!text.contains(second.binding_digest().as_str()), "{text}");
    assert!(error.contains(second.binding_digest().as_str()), "{error}");
    assert!(error.contains("listing is incomplete"), "{error}");
    assert_eq!(valid.count("POST") + invalid.count("POST"), 0);
    let ambiguous = run(&["call", "greetings.read"], &socket);
    assert!(!ambiguous.status.success(), "{ambiguous:?}");
    assert!(String::from_utf8_lossy(&ambiguous.stderr).contains("cannot prove a unique Binding"));
    assert_eq!(valid.count("POST") + invalid.count("POST"), 0);
    let selected = run(
        &[
            "call",
            "greetings.read",
            "--binding",
            first.binding_digest().as_str(),
        ],
        &socket,
    );
    assert!(selected.status.success(), "{selected:?}");
    assert_eq!(valid.count("POST"), 1);
    assert_eq!(invalid.count("POST"), 0);
}

#[test]
fn exact_binding_selection_resolves_ambiguity_without_contacting_other_hosts() {
    let (first, second) = (manifest("cli/call/first"), manifest("cli/call/second"));
    let (one, two) = (Host::new(&first), Host::new(&second));
    let socket = bus("call-select");
    let _registrars = [
        register(&socket, &first, &one),
        register(&socket, &second, &two),
    ];
    let ambiguous = run(&["call", "greetings.read"], &socket);
    assert!(!ambiguous.status.success(), "{ambiguous:?}");
    assert!(String::from_utf8_lossy(&ambiguous.stderr).contains("--binding DIGEST"));
    assert_eq!(one.count("POST") + two.count("POST"), 0);
    let other_reads = two.count("GET");
    let selected = run(
        &[
            "call",
            "greetings.read",
            "--binding",
            first.binding_digest().as_str(),
        ],
        &socket,
    );
    assert!(selected.status.success(), "{selected:?}");
    let outcome: Value = serde_json::from_slice(&selected.stdout).expect("outcome");
    assert_eq!(outcome["bindingDigest"], first.binding_digest().as_str());
    assert_eq!(outcome["installationId"], first.installation_id().as_str());
    assert_eq!(two.count("GET"), other_reads);
    assert_eq!(one.count("POST"), 1);
    assert_eq!(two.count("POST"), 0);
    let missing = format!("sha256:{}", "a".repeat(64));
    let before = one.count("GET") + two.count("GET");
    let output = run(&["call", "greetings.read", "--binding", &missing], &socket);
    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("is not registered"));
    assert_eq!(one.count("GET") + two.count("GET"), before);
    assert_eq!(one.count("POST") + two.count("POST"), 1);
}

#[test]
fn changed_selected_manifest_is_rejected_without_dispatch_or_fallback() {
    let (first, replacement) = (manifest("cli/drift/old"), manifest("cli/drift/new"));
    let (one, two) = (Host::new(&first), Host::new(&replacement));
    let socket = bus("call-drift");
    let _registrars = [
        register(&socket, &first, &one),
        register(&socket, &replacement, &two),
    ];
    one.replace(serde_json::to_value(&replacement).expect("replacement JSON"));
    let other_reads = two.count("GET");
    let output = run(
        &[
            "call",
            "greetings.read",
            "--binding",
            first.binding_digest().as_str(),
        ],
        &socket,
    );
    assert!(!output.status.success(), "{output:?}");
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("serves Binding") && error.contains("expected"),
        "{error}"
    );
    assert_eq!(two.count("GET"), other_reads);
    assert_eq!(one.count("POST") + two.count("POST"), 0);
}

#[test]
fn list_rejects_a_record_whose_installation_does_not_match_its_manifest() {
    let manifest = manifest("cli/list/install");
    let host = Host::new(&manifest);
    let socket = bus("install-pin");
    let mut registrar = BusClient::connect(&socket.socket).expect("registrar");
    let record = ReachRecord::new(
        manifest.binding_digest().to_string(),
        "cli/list/wrong",
        [host.transport.clone()],
    )
    .expect("record");
    let registered = registrar
        .send(&Request::Register {
            record: Box::new(record),
        })
        .expect("register");
    assert!(matches!(registered, Response::Ok { .. }), "{registered:?}");
    let output = run(&["list"], &socket);
    assert!(!output.status.success(), "{output:?}");
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("cli/list/wrong") && error.contains("cli/list/install"),
        "{error}"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("greetings.read"));
    assert_eq!(host.count("POST"), 0);
}
