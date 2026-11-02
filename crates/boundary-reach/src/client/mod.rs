//! A blocking HTTP/1.1 and Unix-socket client for the version 1
//! Handoff HTTP framing specified in
//! `docs/spec/06-http-framing.md`.
//!
//! ureq owns HTTP parsing and TLS. Boundary selects exactly one `GET` or
//! `POST` with a JSON body over TCP, TLS, or a Unix domain socket and never
//! redirects or repeats a request. `https://` is TLS in this crate, never a
//! silent downgrade to plaintext. Unknown schemes still produce
//! [`ClientError::UnsupportedScheme`].
//!
//! A fault is still an outcome per section 6 of the framing, carried on a
//! non-2xx status. [`invoke`] reads the response body as an outcome envelope
//! regardless of status and falls back to the rejection envelope only when
//! the body is not a valid outcome.

mod http;
#[cfg(unix)]
mod unix;

use std::time::Duration;

use boundary_core::handoff::{HandoffInvocation, HandoffOutcome};
use boundary_core::lifecycle::BindingManifest;

use crate::framing::{
    REQUEST_CONTENT_TYPE, RESPONSE_CONTENT_TYPE, Rejection, Route, manifest_etag,
};
use crate::record::Transport;
use http::{HttpResponse, Target};

/// Deadline for resolution, connection and every request/response exchange,
/// including a Unix connect behind a saturated accept queue. Nothing retries.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Why an HTTP or Unix-socket Handoff call could not produce a trusted
/// manifest or outcome.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ClientError {
    /// The record named a scheme this client does not speak.
    #[error("reaching {url} names an unsupported scheme")]
    UnsupportedScheme {
        /// The url that named the unsupported scheme.
        url: String,
    },
    /// The transport's own address was malformed.
    #[error("transport address is invalid: {reason}")]
    InvalidAddress {
        /// What was wrong.
        reason: String,
    },
    /// The connection or exchange failed at the socket layer.
    #[error("could not reach {address}: {source}")]
    Io {
        /// What was being reached.
        address: String,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// The response body was not valid JSON.
    #[error("response from {address} was not valid JSON: {reason}")]
    InvalidBody {
        /// What was being reached.
        address: String,
        /// What was wrong.
        reason: String,
    },
    /// The manifest response did not decode into a valid Binding manifest.
    #[error("manifest from {address} is invalid: {reason}")]
    InvalidManifest {
        /// What was being reached.
        address: String,
        /// What was wrong.
        reason: String,
    },
    /// The manifest response carried an entity tag that did not match the
    /// manifest's own binding digest.
    #[error(
        "manifest from {address} carries etag {actual:?}, which does not match its binding digest ({expected:?})"
    )]
    EtagMismatch {
        /// What was being reached.
        address: String,
        /// The tag the manifest's own binding digest implies.
        expected: String,
        /// The tag the response actually carried.
        actual: String,
    },
    /// The receiver rejected the request before producing an outcome.
    #[error("{address} rejected the request: {rejection:?}")]
    Rejected {
        /// What was being reached.
        address: String,
        /// The rejection envelope, boxed to keep this error small to move.
        rejection: Box<Rejection>,
    },
    /// The response was neither a valid outcome nor a recognized rejection.
    #[error(
        "response from {address} (status {status}) was neither a valid outcome nor a recognized rejection"
    )]
    Unrecognized {
        /// What was being reached.
        address: String,
        /// The HTTP status observed.
        status: u16,
    },
}

/// Fetches the version 1 Binding manifest from `{base}/manifest`.
///
/// Checks that a returned `etag` header, if present, matches the fetched
/// manifest's own binding digest: the manifest already self-validates its
/// digest on deserialization, so this catches a receiver whose framing and
/// manifest identity have drifted apart from each other.
///
/// # Errors
///
/// Returns [`ClientError`] when the transport cannot be reached, names an
/// unsupported scheme, or the response is not a valid manifest.
pub fn fetch_manifest(transport: &Transport) -> Result<BindingManifest, ClientError> {
    let target = Target::new(transport, DEFAULT_TIMEOUT)?;
    let address = target.address();
    let response = target.request(Route::Manifest, &[])?;

    if response.status != 200 {
        return Err(reject_or_unrecognized(address, &response));
    }

    let manifest: BindingManifest =
        serde_json::from_slice(&response.body).map_err(|error| ClientError::InvalidManifest {
            address: address.to_owned(),
            reason: error.to_string(),
        })?;

    if let Some(etag) = response.etag.as_deref() {
        let expected = manifest_etag(manifest.binding_digest().as_str());
        if etag != expected {
            return Err(ClientError::EtagMismatch {
                address: address.to_owned(),
                expected,
                actual: etag.to_owned(),
            });
        }
    }

    Ok(manifest)
}

/// Performs one Handoff invocation against `{base}/invoke`.
///
/// A fault is still an outcome and is carried on a non-2xx status, so this
/// reads the body as an outcome envelope regardless of status and only falls
/// back to the rejection envelope when the body is not a valid outcome.
///
/// # Errors
///
/// Returns [`ClientError`] when the transport cannot be reached, names an
/// unsupported scheme, or the response is neither a valid outcome nor a
/// recognized rejection.
pub fn invoke(
    transport: &Transport,
    invocation: &HandoffInvocation,
) -> Result<HandoffOutcome, ClientError> {
    let target = Target::new(transport, DEFAULT_TIMEOUT)?;
    let address = target.address();
    let body = serde_json::to_vec(invocation).map_err(|error| ClientError::InvalidBody {
        address: address.to_owned(),
        reason: error.to_string(),
    })?;
    let response = target.request(Route::Invoke, &body)?;

    serde_json::from_slice::<HandoffOutcome>(&response.body)
        .map_err(|_| reject_or_unrecognized(address, &response))
}

fn reject_or_unrecognized(address: &str, response: &HttpResponse) -> ClientError {
    match serde_json::from_slice::<Rejection>(&response.body) {
        Ok(rejection) => ClientError::Rejected {
            address: address.to_owned(),
            rejection: Box::new(rejection),
        },
        Err(_) => ClientError::Unrecognized {
            address: address.to_owned(),
            status: response.status,
        },
    }
}
