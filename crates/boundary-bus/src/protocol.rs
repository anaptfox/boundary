//! The local bus wire protocol.
//!
//! Line-delimited JSON over a Unix domain socket. One request per line, one
//! response per line, in order. The protocol is deliberately tiny: the bus
//! answers where things are and nothing else.
//!
//! There is no invoke here. A caller that finds a surface reaches it directly
//! over the transport the record names, so the bus never sits in the call path,
//! never sees an invocation, and never becomes a second source of truth about
//! what happened. Receipts stay with Control in the application that executed
//! the effect.

use boundary_reach::ReachRecord;
use serde::{Deserialize, Serialize};

/// A request from a client to the bus.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Request {
    /// Announce that a Binding is reachable. Re-registering the same binding
    /// digest replaces the record, which is how a host reissues after a move.
    Register {
        /// Where the Binding can be reached.
        record: Box<ReachRecord>,
    },
    /// Withdraw a record, on revocation.
    Unregister {
        /// The binding digest to withdraw.
        binding_digest: String,
    },
    /// List every currently reachable record.
    List,
}

/// A response from the bus.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Response {
    /// The request succeeded and carries whatever it asked for.
    Ok {
        /// Records, for `list`. Empty for the others.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        records: Vec<ReachRecord>,
    },
    /// The request was refused.
    Error {
        /// Stable code.
        code: String,
        /// What went wrong, without host internals.
        message: String,
    },
}

impl Response {
    /// An empty success.
    #[must_use]
    pub const fn ok() -> Self {
        Self::Ok {
            records: Vec::new(),
        }
    }

    /// A success carrying records.
    #[must_use]
    pub const fn records(records: Vec<ReachRecord>) -> Self {
        Self::Ok { records }
    }

    /// A refusal.
    #[must_use]
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{Request, Response};
    use boundary_reach::{ReachRecord, Transport};

    fn record() -> ReachRecord {
        ReachRecord::new(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "deploy:example:1",
            [Transport::Unix {
                path: "/tmp/boundary.sock".to_owned(),
                base: "/boundary/v1".to_owned(),
            }],
        )
        .expect("record")
    }

    #[test]
    fn requests_round_trip_as_one_line_of_json() {
        for request in [
            Request::Register {
                record: Box::new(record()),
            },
            Request::Unregister {
                binding_digest: "sha256:abc".to_owned(),
            },
            Request::List,
        ] {
            let line = serde_json::to_string(&request).expect("serializes");
            assert!(!line.contains('\n'), "a request must fit one line");
            let decoded: Request = serde_json::from_str(&line).expect("deserializes");
            assert_eq!(decoded, request);
        }
    }

    #[test]
    fn responses_round_trip_as_one_line_of_json() {
        for response in [
            Response::ok(),
            Response::records(vec![record()]),
            Response::error("UNKNOWN_RECORD", "no such binding digest"),
        ] {
            let line = serde_json::to_string(&response).expect("serializes");
            assert!(!line.contains('\n'), "a response must fit one line");
            let decoded: Response = serde_json::from_str(&line).expect("deserializes");
            assert_eq!(decoded, response);
        }
    }

    #[test]
    fn the_protocol_has_no_way_to_invoke() {
        // A bus that could invoke would sit in the call path and become a
        // second place to ask what happened. This test exists so adding one
        // has to be deliberate.
        let encoded = serde_json::to_string(&Request::List).expect("serializes");
        assert_eq!(encoded, r#"{"op":"list"}"#);
        assert!(serde_json::from_str::<Request>(r#"{"op":"invoke"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"op":"call"}"#).is_err());
    }
}
