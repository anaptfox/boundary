//! Consumes the reviewed exact-import-signature vector.
//!
//! Every host import a guest declares must match the provided import's
//! signature, decided before any guest code runs. The vector pins refusal
//! certainty and how many times the host was entered. TypeScript consumes the
//! same file.
#![allow(clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use boundary_plugin::{
    GuestInstance, GuestLimits, GuestOutcome, HostFunctions, HostReply, InvocationCertainty,
    PluginComponent, PluginLifetime, guest_engine,
};
use serde_json::Value;

fn vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/plugin-import-abi.json"
    ))
    .expect("plugin-import-abi vector parses")
}

fn fixture_bytes(vector: &Value, name: &str) -> Vec<u8> {
    let relative = vector["fixtures"][name]
        .as_str()
        .unwrap_or_else(|| panic!("fixture {name} is listed"));
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .join(relative);
    fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn certainty_token(certainty: InvocationCertainty) -> &'static str {
    match certainty {
        InvocationCertainty::NotStarted => "not-started",
        InvocationCertainty::Unknown => "unknown",
        InvocationCertainty::NotCompleted => "not-completed",
        InvocationCertainty::Completed => "completed",
    }
}

fn counting_host(count: &Arc<AtomicUsize>) -> HostFunctions {
    let count = Arc::clone(count);
    HostFunctions::new()
        .provide("images", move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            HostReply::Returned("{}".to_owned())
        })
        .expect("images is spellable")
}

#[test]
fn the_reviewed_vector_holds() {
    let vector = vector();
    let interface = vector["interface"].as_str().expect("interface");
    let engine = guest_engine().expect("engine");
    for case in vector["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let bytes = fixture_bytes(&vector, case["fixture"].as_str().expect("fixture"));
        let count = Arc::new(AtomicUsize::new(0));
        // A component outside the synchronous profile is refused at load,
        // which is also before any guest code can run.
        let admitted = PluginComponent::load(&engine, &bytes, "world").and_then(|component| {
            GuestInstance::instantiate(
                &engine,
                &component,
                &counting_host(&count),
                interface,
                GuestLimits::default(),
            )
        });
        let actual = match admitted {
            Err(error) => certainty_token(error.certainty()),
            Ok(mut instance) => {
                assert!(
                    case["invoke"].as_bool().expect("invoke"),
                    "{name}: admitted"
                );
                match instance.call("run", "") {
                    GuestOutcome::Fault { certainty, .. } => certainty_token(certainty),
                    GuestOutcome::Returned(payload) => {
                        assert_eq!(payload, "{}", "{name}");
                        "completed"
                    }
                    GuestOutcome::DeclaredError(payload) => panic!("{name}: declared {payload}"),
                }
            }
        };
        let expected_calls = usize::try_from(case["hostCalls"].as_u64().expect("hostCalls"))
            .expect("host calls fit usize");
        assert_eq!(
            count.load(Ordering::SeqCst),
            expected_calls,
            "{name}: host entries ({actual})"
        );
        assert_eq!(
            actual,
            case["certainty"].as_str().expect("certainty"),
            "{name}"
        );
    }
}

fn outcome_token(outcome: &GuestOutcome) -> &'static str {
    match outcome {
        GuestOutcome::Fault { certainty, .. } => certainty_token(*certainty),
        GuestOutcome::Returned(_) => "completed",
        GuestOutcome::DeclaredError(_) => "declared-error",
    }
}

#[test]
fn the_default_hostcall_copy_budget_is_the_reviewed_one() {
    let default = vector()["hostcallCopyBudget"]["default"]
        .as_u64()
        .expect("default budget");
    assert_eq!(
        GuestLimits::default().hostcall_copy_bytes as u64,
        default,
        "Rust and Node share one default"
    );
}

#[test]
fn the_reviewed_hostcall_copy_budget_law_holds() {
    let vector = vector();
    let interface = vector["interface"].as_str().expect("interface");
    let engine = guest_engine().expect("engine");
    for case in vector["hostcallCopyBudget"]["cases"]
        .as_array()
        .expect("cases")
    {
        let name = case["name"].as_str().expect("name");
        let bytes = fixture_bytes(&vector, case["fixture"].as_str().expect("fixture"));
        let lifetime = match case["lifetime"].as_str().expect("lifetime") {
            "persistent" => PluginLifetime::Persistent,
            _ => PluginLifetime::PerCall,
        };
        let component = PluginComponent::load_with(&engine, &bytes, "world", lifetime)
            .expect("valid component");
        let count = Arc::new(AtomicUsize::new(0));
        let reply = case["reply"].as_str().expect("reply").to_owned();
        let declared = case["replyKind"].as_str() == Some("err");
        let host = {
            let count = Arc::clone(&count);
            HostFunctions::new()
                .provide("images", move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                    if declared {
                        HostReply::DeclaredError(reply.clone())
                    } else {
                        HostReply::Returned(reply.clone())
                    }
                })
                .expect("images is spellable")
        };
        let limits = GuestLimits {
            hostcall_copy_bytes: usize::try_from(case["limit"].as_u64().expect("limit"))
                .expect("limit fits usize"),
            ..GuestLimits::default()
        };
        let actual: Vec<&str> =
            match GuestInstance::instantiate(&engine, &component, &host, interface, limits) {
                Err(error) => vec![certainty_token(error.certainty())],
                Ok(mut instance) => (0..case["calls"].as_u64().expect("calls"))
                    .map(|_| outcome_token(&instance.call("run", "")))
                    .collect(),
            };
        let expected: Vec<&str> = case["outcomes"]
            .as_array()
            .expect("outcomes")
            .iter()
            .map(|token| token.as_str().expect("token"))
            .collect();
        assert_eq!(actual, expected, "{name}: outcomes");
        let expected_calls = usize::try_from(case["hostCalls"].as_u64().expect("hostCalls"))
            .expect("host calls fit usize");
        assert_eq!(
            count.load(Ordering::SeqCst),
            expected_calls,
            "{name}: host entries"
        );
    }
}
