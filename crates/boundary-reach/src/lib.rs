#![doc = "Reach records, and the specified HTTP framing and client used to reach a Binding."]
#![forbid(unsafe_code)]

//! Handoff defines envelopes and leaves framing to the host. Every TypeScript
//! mount already shares one HTTP framing; this crate is the same framing as a
//! specification a Rust host can serve and a Rust client can reach, checked
//! against `tests/conformance/v1/http-framing.json` in both languages.
//!
//! Routing, status selection, and rejection shapes are decisions over values
//! without a transport runtime. The optional `client` feature uses ureq for
//! blocking HTTP/TLS and Unix-socket calls; serving remains the host's choice.

// The client dials `std::os::unix::net::UnixStream` for a Unix transport, so
// it needs a Unix target the same way the bus crate's socket transport does.
#[cfg(all(feature = "client", unix))]
mod client;
mod framing;
mod record;

#[cfg(all(feature = "client", unix))]
pub use client::{ClientError, fetch_manifest, invoke};
pub use framing::{
    MANIFEST_CACHE_CONTROL, REQUEST_CONTENT_TYPE, RESPONSE_CONTENT_TYPE, Rejection, RejectionBody,
    RejectionIssue, RejectionKind, Route, is_conflict, is_fresh, manifest_etag, resolve,
    status_for_outcome, status_for_result,
};
pub use record::{ReachError, ReachRecord, Transport};
