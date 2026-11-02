//! Consumes the reviewed HTTP framing vector.
//!
//! The same file drives `tests/typescript/http-framing-conformance.test.ts`,
//! which checks the shipped TypeScript handler. Both implementations are held
//! to one piece of reviewed evidence rather than to each other, so neither can
//! drift by agreeing with itself.
#![allow(clippy::expect_used)]

use boundary_core::handoff::{HandoffFaultCause, HandoffResult};
use boundary_reach::{
    MANIFEST_CACHE_CONTROL, REQUEST_CONTENT_TYPE, RESPONSE_CONTENT_TYPE, Rejection, RejectionKind,
    Route, is_fresh, manifest_etag, resolve, status_for_result,
};
use serde_json::Value;

fn vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/http-framing.json"
    ))
    .expect("http-framing vector parses")
}

/// Reads a reviewed status. A value outside the HTTP status range is a broken
/// vector rather than something to truncate silently.
fn status(value: &Value) -> u16 {
    u16::try_from(value.as_u64().expect("reviewed status is a number"))
        .expect("reviewed status fits an HTTP status code")
}

fn text<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    let mut cursor = value;
    for key in path {
        cursor = &cursor[*key];
    }
    cursor
        .as_str()
        .expect("reviewed vector field must be a string")
}

/// Builds the result the vector names. A cause the crate does not know cannot
/// be constructed here, which is the point: the vector lists causes literally
/// and this mapping fails to compile or fails the test if one is unhandled.
fn result_for(case: &Value) -> HandoffResult {
    let kind = text(case, &["result", "kind"]);
    match kind {
        "returned" => HandoffResult::Returned { value: Value::Null },
        "proposed" => HandoffResult::Proposed {
            proposal: Value::Null,
        },
        "denied" => HandoffResult::Denied {
            code: "DENIED".to_owned(),
        },
        "declared-error" => HandoffResult::DeclaredError {
            code: "REFUSED".to_owned(),
            details: Value::Null,
        },
        "fault" => HandoffResult::Fault {
            cause: cause_for(text(case, &["result", "cause"])),
            issues: Vec::new(),
        },
        // An unreviewed kind must not silently pass as something else.
        other => unreachable!("unknown reviewed result kind {other:?}"),
    }
}

fn cause_for(name: &str) -> HandoffFaultCause {
    match name {
        "invalid-input" => HandoffFaultCause::InvalidInput,
        "invalid-invocation" => HandoffFaultCause::InvalidInvocation,
        "revoked" => HandoffFaultCause::Revoked,
        "admission-failed" => HandoffFaultCause::AdmissionFailed,
        "request-failed" => HandoffFaultCause::RequestFailed,
        "invalid-realization-outcome" => HandoffFaultCause::InvalidRealizationOutcome,
        "realization-failed" => HandoffFaultCause::RealizationFailed,
        other => unreachable!("unknown reviewed fault cause {other:?}"),
    }
}

#[test]
fn routes_match_the_reviewed_methods_and_suffixes() {
    let vector = vector();
    let base = "/boundary/v1";

    let manifest = &vector["routes"]["manifest"];
    assert_eq!(Route::Manifest.method(), text(manifest, &["method"]));
    assert_eq!(Route::Manifest.suffix(), text(manifest, &["suffix"]));
    assert_eq!(
        resolve(
            base,
            text(manifest, &["method"]),
            &format!("{base}{}", text(manifest, &["suffix"]))
        ),
        Some(Route::Manifest)
    );

    let invoke = &vector["routes"]["invoke"];
    assert_eq!(Route::Invoke.method(), text(invoke, &["method"]));
    assert_eq!(Route::Invoke.suffix(), text(invoke, &["suffix"]));
    assert_eq!(
        resolve(
            base,
            text(invoke, &["method"]),
            &format!("{base}{}", text(invoke, &["suffix"]))
        ),
        Some(Route::Invoke)
    );
}

#[test]
fn nothing_outside_the_two_reviewed_routes_resolves() {
    let base = "/boundary/v1";
    assert_eq!(resolve(base, "GET", base), None);
    assert_eq!(resolve(base, "GET", "/boundary/v1/other"), None);
    // A reviewed path under the wrong method is no route, not that route.
    assert_eq!(resolve(base, "POST", "/boundary/v1/manifest"), None);
    assert_eq!(resolve(base, "GET", "/boundary/v1/invoke"), None);
}

#[test]
fn content_types_and_cache_directive_match_the_vector() {
    let vector = vector();
    assert_eq!(
        RESPONSE_CONTENT_TYPE,
        text(&vector, &["contentType", "response"])
    );
    assert_eq!(
        REQUEST_CONTENT_TYPE,
        text(&vector, &["contentType", "request"])
    );
    assert_eq!(
        MANIFEST_CACHE_CONTROL,
        text(&vector, &["manifest", "cacheControl"])
    );
}

#[test]
fn the_validator_is_the_binding_digest_in_the_reviewed_format() {
    let vector = vector();
    let format = text(&vector, &["manifest", "etagFormat"]);
    let digest = "sha256:abc";
    assert_eq!(
        manifest_etag(digest),
        format.replace("{bindingDigest}", digest),
        "the entity tag format must match the reviewed shape"
    );
    assert!(is_fresh(Some(&manifest_etag(digest)), digest));
    assert!(!is_fresh(Some("\"sha256:stale\""), digest));
    assert!(!is_fresh(None, digest));
}

#[test]
fn every_reviewed_outcome_status_matches() {
    let vector = vector();
    let cases = vector["statusForOutcome"]
        .as_array()
        .expect("statusForOutcome");
    assert_ne!(cases.as_slice(), [] as [serde_json::Value; 0]);

    for case in cases {
        let name = text(case, &["name"]);
        let expected = status(&case["status"]);
        assert_eq!(
            status_for_result(&result_for(case)),
            expected,
            "case {name}"
        );
    }
}

#[test]
fn the_vector_covers_every_fault_cause_the_protocol_defines() {
    // A new cause added upstream without a reviewed status is caught here
    // rather than falling through to 500 unnoticed. The wildcard in
    // `status_for_result` exists only because the upstream enum is
    // non-exhaustive; it is not a licence to leave a cause unreviewed.
    let vector = vector();
    let mut reviewed: Vec<String> = vector["statusForOutcome"]
        .as_array()
        .expect("statusForOutcome")
        .iter()
        .filter(|case| case["result"]["kind"] == "fault")
        .map(|case| text(case, &["result", "cause"]).to_owned())
        .collect();
    reviewed.sort();

    let mut known = vec![
        "admission-failed".to_owned(),
        "invalid-input".to_owned(),
        "invalid-invocation".to_owned(),
        "invalid-realization-outcome".to_owned(),
        "realization-failed".to_owned(),
        "request-failed".to_owned(),
        "revoked".to_owned(),
    ];
    known.sort();
    assert_eq!(reviewed, known);
}

#[test]
fn every_reviewed_rejection_matches() {
    let vector = vector();
    for case in vector["rejections"]["cases"]
        .as_array()
        .expect("rejection cases")
    {
        let name = text(case, &["name"]);
        let expected_status = status(&case["status"]);
        let rejection = match name {
            "route-not-found" => Rejection::route_not_found(),
            "empty-body" | "malformed-json" => {
                Rejection::protocol("INVALID_REQUEST", "request.body")
            }
            "internal-failure" => Rejection::internal(),
            other => unreachable!("unknown reviewed rejection {other:?}"),
        };

        assert_eq!(rejection.status(), expected_status, "case {name}: status");
        assert_eq!(
            rejection.error.code,
            text(case, &["code"]),
            "case {name}: code"
        );

        let expected_kind = match text(case, &["kind"]) {
            "protocol" => RejectionKind::Protocol,
            "internal" => RejectionKind::Internal,
            other => unreachable!("unknown reviewed kind {other:?}"),
        };
        assert_eq!(rejection.error.kind, expected_kind, "case {name}: kind");

        match case["path"].as_str() {
            Some(path) => assert_eq!(rejection.error.path.as_deref(), Some(path), "case {name}"),
            None => assert!(
                rejection.error.path.is_none(),
                "case {name}: an internal rejection must not report a path"
            ),
        }
    }
}

#[test]
fn stale_pins_are_conflicts_and_malformed_requests_are_not() {
    let vector = vector();
    let rule = &vector["rejections"]["conflictStatusRule"];
    let conflict = status(&rule["status"]);
    let otherwise = status(&rule["otherwise"]);

    for prefix in rule["codePrefixes"].as_array().expect("codePrefixes") {
        let code = format!("{}BINDING", prefix.as_str().expect("prefix"));
        assert_eq!(
            Rejection::protocol(code.clone(), "handoff").status(),
            conflict,
            "{code} must be a conflict so a caller re-handshakes"
        );
    }
    for code in rule["codes"].as_array().expect("codes") {
        let code = code.as_str().expect("code");
        assert_eq!(Rejection::protocol(code, "handoff").status(), conflict);
    }
    assert_eq!(
        Rejection::protocol("INVALID_REQUEST", "request.body").status(),
        otherwise
    );
}

#[test]
fn the_rejection_envelope_serializes_under_an_error_key() {
    let rejection = Rejection::route_not_found();
    let encoded = serde_json::to_value(&rejection).expect("serializes");
    assert_eq!(encoded["error"]["kind"], "protocol");
    assert_eq!(encoded["error"]["code"], "ROUTE_NOT_FOUND");
    assert_eq!(encoded["error"]["path"], "request.url");

    // An internal rejection omits the path rather than emitting null, so a
    // caller cannot learn host structure from its absence or presence shape.
    let internal = serde_json::to_value(Rejection::internal()).expect("serializes");
    assert_eq!(internal["error"]["kind"], "internal");
    assert!(internal["error"].get("path").is_none());
}
