//! The version 1 Handoff HTTP framing.
//!
//! Handoff itself is transport-neutral: the Rust crate has always carried the
//! envelopes and left framing to the host. Every TypeScript mount, meanwhile,
//! already shares one framing. This module promotes that convention to a
//! specified transport so a Rust host can serve what a TypeScript client
//! reaches, and the other way round, both checked against one reviewed vector.
//!
//! It is deliberately transport-library-free. Routing, status selection, and
//! the rejection envelope are pure decisions over values; binding them to a
//! server or a client is the caller's choice, so this crate pulls in no
//! runtime and imposes none.

use boundary_core::handoff::{HandoffFaultCause, HandoffOutcome, HandoffResult};
use serde::{Deserialize, Serialize};

/// Response media type. Requests carry `application/json`.
pub const RESPONSE_CONTENT_TYPE: &str = "application/json; charset=utf-8";
/// Request media type.
pub const REQUEST_CONTENT_TYPE: &str = "application/json";
/// Cache directive on the manifest, so a client always revalidates.
pub const MANIFEST_CACHE_CONTROL: &str = "no-cache";

/// The two routes this protocol defines, relative to a host-chosen base path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Route {
    /// `GET {base}/manifest`
    Manifest,
    /// `POST {base}/invoke`
    Invoke,
}

impl Route {
    /// Returns the path suffix for this route.
    #[must_use]
    pub const fn suffix(self) -> &'static str {
        match self {
            Self::Manifest => "/manifest",
            Self::Invoke => "/invoke",
        }
    }

    /// Returns the method this route answers.
    #[must_use]
    pub const fn method(self) -> &'static str {
        match self {
            Self::Manifest => "GET",
            Self::Invoke => "POST",
        }
    }
}

/// Resolves a request to a route.
///
/// A path that matches a route under the wrong method is not that route. It is
/// no route at all, which keeps the surface exactly two entries rather than two
/// paths with method-dependent behavior.
#[must_use]
pub fn resolve(base: &str, method: &str, path: &str) -> Option<Route> {
    let base = base.trim_end_matches('/');
    for route in [Route::Manifest, Route::Invoke] {
        if path == format!("{base}{}", route.suffix()) && method == route.method() {
            return Some(route);
        }
    }
    None
}

/// Formats the manifest entity tag from a binding digest.
///
/// The validator is exact Binding identity rather than a timestamp: a replaced
/// Installation produces a different digest and therefore a different tag, so a
/// stale client revalidates instead of trusting a cached surface.
#[must_use]
pub fn manifest_etag(binding_digest: &str) -> String {
    format!("\"{binding_digest}\"")
}

/// Returns whether a cache validator matches the current manifest.
#[must_use]
pub fn is_fresh(if_none_match: Option<&str>, binding_digest: &str) -> bool {
    if_none_match.is_some_and(|value| value == manifest_etag(binding_digest))
}

/// Status for a completed invocation.
///
/// A fault is still an outcome and is carried on a non-2xx status, so a client
/// must read the envelope rather than infer meaning from the status alone. A
/// declared error is 422 rather than 400 because it is a domain outcome the
/// contract predicted, not a malformed request.
#[must_use]
pub fn status_for_outcome(outcome: &HandoffOutcome) -> u16 {
    status_for_result(outcome.result())
}

/// Status for one result.
///
/// The status depends only on the result, so this is the form the reviewed
/// vector exercises. [`status_for_outcome`] is the convenience for a caller
/// holding a whole envelope.
#[must_use]
// The explicit 500 causes share a body with the non-exhaustive wildcard. That
// redundancy is deliberate: listing every known cause is how a reader sees
// which ones were reviewed, and collapsing them into the wildcard would hide a
// future cause behind a default nobody chose.
#[allow(clippy::match_same_arms)]
pub fn status_for_result(result: &HandoffResult) -> u16 {
    match result {
        HandoffResult::Returned { .. } => 200,
        HandoffResult::Proposed { .. } => 202,
        HandoffResult::Denied { .. } => 403,
        HandoffResult::DeclaredError { .. } => 422,
        HandoffResult::Fault { cause, .. } => match cause {
            // Before execution, and the caller can fix it.
            HandoffFaultCause::InvalidInput | HandoffFaultCause::InvalidInvocation => 400,
            // The pin is stale; the caller should re-handshake rather than retry.
            HandoffFaultCause::Revoked => 409,
            // The consequence is unknown and the caller cannot resolve it.
            HandoffFaultCause::AdmissionFailed
            | HandoffFaultCause::RequestFailed
            | HandoffFaultCause::InvalidRealizationOutcome
            | HandoffFaultCause::RealizationFailed => 500,
            // `HandoffFaultCause` is non-exhaustive, so a wildcard is required
            // rather than chosen. A cause this crate has not seen is treated as
            // an unknown consequence, which is the safe reading. It is not a
            // silent default: the reviewed vector lists every cause literally,
            // and its exhaustiveness check fails when the protocol grows one
            // without a reviewed status.
            _ => 500,
        },
        // `HandoffResult` is likewise non-exhaustive. An unrecognized result
        // kind cannot be classified, so its consequence is unknown.
        _ => 500,
    }
}

/// Whether a rejection was recognized by the receiver.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RejectionKind {
    /// The receiver recognized the failure and names where it happened.
    Protocol,
    /// The receiver did not. No path is reported, because a path would leak
    /// host structure to an untrusted caller.
    Internal,
}

/// Portable evidence attached to a rejection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RejectionIssue {
    /// Where in the input the problem was found.
    pub path: String,
    /// What was wrong, without host internals.
    pub message: String,
}

/// The body of a rejection that happened before an outcome existed.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectionBody {
    /// Whether the receiver recognized the failure.
    pub kind: RejectionKind,
    /// Stable code.
    pub code: String,
    /// Where it happened. Absent for an internal rejection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Optional portable evidence.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<RejectionIssue>,
    /// Human-facing summary.
    pub message: String,
}

/// A rejection envelope, which wraps the body under an `error` key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Rejection {
    /// The rejection detail.
    pub error: RejectionBody,
}

impl Rejection {
    /// A rejection the receiver recognized.
    #[must_use]
    pub fn protocol(code: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            error: RejectionBody {
                kind: RejectionKind::Protocol,
                code: code.into(),
                path: Some(path.into()),
                issues: Vec::new(),
                message: "The version 1 Handoff invocation was rejected.".to_owned(),
            },
        }
    }

    /// A rejection the receiver did not recognize. Carries no path.
    #[must_use]
    pub fn internal() -> Self {
        Self {
            error: RejectionBody {
                kind: RejectionKind::Internal,
                code: "REMOTE_EXECUTION_FAILED".to_owned(),
                path: None,
                issues: Vec::new(),
                message: "The interaction could not be completed.".to_owned(),
            },
        }
    }

    /// The rejection for a request that matched no route.
    #[must_use]
    pub fn route_not_found() -> Self {
        Self {
            error: RejectionBody {
                kind: RejectionKind::Protocol,
                code: "ROUTE_NOT_FOUND".to_owned(),
                path: Some("request.url".to_owned()),
                issues: Vec::new(),
                message: "No version 1 protocol route matched.".to_owned(),
            },
        }
    }

    /// Attaches portable validation evidence.
    #[must_use]
    pub fn with_issues(mut self, issues: Vec<RejectionIssue>) -> Self {
        self.error.issues = issues;
        self
    }

    /// The HTTP status for this rejection.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self.error.kind {
            RejectionKind::Internal => 500,
            RejectionKind::Protocol => {
                if self.error.code == "ROUTE_NOT_FOUND" {
                    404
                } else if is_conflict(&self.error.code) {
                    409
                } else {
                    400
                }
            }
        }
    }
}

/// Whether a recognized code means a stale pin rather than a malformed request.
///
/// A conflict tells the caller to re-handshake; a bad request tells it to fix
/// the request. Collapsing the two would make a moved deployment look like a
/// caller bug.
#[must_use]
pub fn is_conflict(code: &str) -> bool {
    code.starts_with("STALE_") || matches!(code, "INTERACTION_NOT_EXPOSED" | "MODE_NOT_EXPOSED")
}

#[cfg(test)]
mod tests {
    use super::{Route, is_conflict, is_fresh, manifest_etag, resolve};

    #[test]
    fn resolves_both_routes_under_a_base_path() {
        assert_eq!(
            resolve("/boundary/v1", "GET", "/boundary/v1/manifest"),
            Some(Route::Manifest)
        );
        assert_eq!(
            resolve("/boundary/v1", "POST", "/boundary/v1/invoke"),
            Some(Route::Invoke)
        );
    }

    #[test]
    fn a_trailing_slash_on_the_base_does_not_change_the_routes() {
        assert_eq!(
            resolve("/boundary/v1/", "GET", "/boundary/v1/manifest"),
            Some(Route::Manifest)
        );
    }

    #[test]
    fn a_route_under_the_wrong_method_is_no_route() {
        assert_eq!(
            resolve("/boundary/v1", "POST", "/boundary/v1/manifest"),
            None
        );
        assert_eq!(resolve("/boundary/v1", "GET", "/boundary/v1/invoke"), None);
    }

    #[test]
    fn nothing_outside_the_two_routes_resolves() {
        assert_eq!(resolve("/boundary/v1", "GET", "/boundary/v1"), None);
        assert_eq!(resolve("/boundary/v1", "GET", "/boundary/v1/other"), None);
        assert_eq!(resolve("/boundary/v1", "GET", "/elsewhere/manifest"), None);
    }

    #[test]
    fn the_validator_is_the_binding_digest_in_quotes() {
        assert_eq!(manifest_etag("sha256:abc"), "\"sha256:abc\"");
        assert!(is_fresh(Some("\"sha256:abc\""), "sha256:abc"));
        assert!(!is_fresh(Some("\"sha256:other\""), "sha256:abc"));
        assert!(!is_fresh(None, "sha256:abc"));
    }

    #[test]
    fn stale_pins_are_conflicts_and_other_codes_are_not() {
        assert!(is_conflict("STALE_BINDING"));
        assert!(is_conflict("INTERACTION_NOT_EXPOSED"));
        assert!(is_conflict("MODE_NOT_EXPOSED"));
        assert!(!is_conflict("INVALID_REQUEST"));
    }
}
