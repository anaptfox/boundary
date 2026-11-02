//! Version 1 transport-neutral invocation and outcome boundary.

mod client;
mod observation;
mod protocol;
mod server;
pub(crate) use protocol::{input_is_valid, validate_outcome, validate_response};

pub use client::{
    HandoffTransport, RemoteCallError, RemoteCaller, RemoteRequestError, TransportFault,
};
pub use protocol::{
    HandoffDiagnosticCode, HandoffError, HandoffFaultCause, HandoffInvocation, HandoffOutcome,
    HandoffResult, HandoffValidationIssue,
};
pub use server::{CheckedHandoff, checked_handoff};
