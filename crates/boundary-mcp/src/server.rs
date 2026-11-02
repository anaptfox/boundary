//! A Model Context Protocol server over reachable interaction surfaces.
//!
//! JSON-RPC 2.0 over stdio, hand-written. The protocol surface a tool server
//! needs is four methods, which does not justify pulling an SDK and an async
//! runtime into a workspace that has neither.
//!
//! The model is an ordinary caller here. It gets tools derived from what
//! applications published, and every call it makes is admitted by the
//! application that owns the interaction. This server never decides whether a
//! call is allowed; it carries pins across and reports what came back.

use std::io::{BufRead, Write};

use serde_json::{Map, Value, json};

use crate::tools::{ToolEntry, ToolTarget};

/// The protocol version this server speaks, matching the SDK the TypeScript
/// adapter is built on.
pub const PROTOCOL_VERSION: &str = "2026-07-28";

/// What a host does when a model calls a tool.
///
/// The invoker reaches the surface over whatever transport its Reach record
/// named and returns the outcome envelope as untrusted JSON. Returning an
/// envelope rather than a typed value is deliberate: the outcome's certainty
/// belongs to the executing host, and nothing in this crate may reinterpret it.
pub trait ToolInvoker {
    /// Invokes one tool and returns the outcome envelope, or a transport-level
    /// failure message when no envelope came back at all.
    ///
    /// # Errors
    ///
    /// Returns a message when the surface could not be reached. A surface that
    /// answered with a fault is a success at this level: the envelope is the
    /// answer.
    fn invoke(&self, target: &ToolTarget, input: Value) -> Result<Value, String>;
}

/// Identifies this server to a client.
#[derive(Clone, Debug)]
pub struct ServerInfo {
    /// Server name.
    pub name: String,
    /// Server version.
    pub version: String,
}

/// What a model must tell apart about one outcome, independent of transport.
///
/// Parity target is `describeOutcome` in `packages/core/remote/describe.ts`;
/// `tests/conformance/v1/mcp-envelope.json` pins the wording for both.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutcomeDescription {
    /// `success`, `proposed`, `declared-error`, `denied`, `invalid`, `failed`, or `uncertain`.
    pub kind: &'static str,
    /// One or two sentences a model can act on.
    pub summary: String,
    /// Whether the tool result is flagged `isError`.
    pub is_error: bool,
}

/// Describes one checked outcome for a model.
///
/// Uncertainty is never folded into failure: an outcome whose certainty is
/// `unknown` or `not-completed` says so, forbids a repeat, and names the
/// installation to check with.
#[must_use]
pub fn describe_outcome(outcome: &Value) -> OutcomeDescription {
    let id = outcome["interactionId"]
        .as_str()
        .unwrap_or("the interaction");
    let certainty = outcome["certainty"].as_str().unwrap_or("unknown");
    let installation = outcome["installationId"]
        .as_str()
        .unwrap_or("the installation");
    let result = &outcome["result"];
    let kind = result["kind"].as_str().unwrap_or("fault");
    let described = |kind: &'static str, summary: String, is_error: bool| OutcomeDescription {
        kind,
        summary,
        is_error,
    };
    match kind {
        "returned" => described(
            "success",
            format!("{id} completed and returned a value (certainty: completed)."),
            false,
        ),
        "proposed" => described(
            "proposed",
            format!(
                "{id} was proposed, not run: a Proposal record now awaits host review (certainty: not-started). Do not call again to retry; the host decides."
            ),
            false,
        ),
        "declared-error" => {
            let code = result["code"].as_str().unwrap_or("");
            described(
                "declared-error",
                format!(
                    "{id} completed with its declared outcome \"{code}\" (certainty: completed). Read details before deciding what to do next."
                ),
                true,
            )
        }
        "denied" => {
            let code = result["code"].as_str().unwrap_or("");
            described(
                "denied",
                format!(
                    "{id} was denied by the host ({code}); nothing ran (certainty: not-started)."
                ),
                true,
            )
        }
        _ if certainty == "unknown" || certainty == "not-completed" => described(
            "uncertain",
            format!(
                "{id} may have run; its outcome is not known (certainty: {certainty}). Do not repeat it. Check with installation {installation} before acting."
            ),
            true,
        ),
        _ => describe_fault(id, result),
    }
}

/// A fault proven not to have started: invalid input or invocation, an
/// outdated view after revocation, or another named cause.
fn describe_fault(id: &str, result: &Value) -> OutcomeDescription {
    let cause = result["cause"].as_str().unwrap_or("realization-failed");
    let described = |kind: &'static str, summary: String| OutcomeDescription {
        kind,
        summary,
        is_error: true,
    };
    match cause {
        "invalid-input" | "invalid-invocation" => {
            let what = if cause == "invalid-input" {
                "input"
            } else {
                "invocation"
            };
            let issues: Vec<String> = result["issues"]
                .as_array()
                .map(|issues| {
                    issues
                        .iter()
                        .map(|issue| {
                            format!(
                                "{}: {}",
                                issue["path"].as_str().unwrap_or(""),
                                issue["message"].as_str().unwrap_or("")
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let issue_text = if issues.is_empty() {
                String::new()
            } else {
                format!(" Issues: {}.", issues.join("; "))
            };
            described(
                "invalid",
                format!(
                    "{id} was not started: the {what} was rejected before anything ran (certainty: not-started).{issue_text} Fix it and call again."
                ),
            )
        }
        "revoked" => described(
            "failed",
            format!(
                "{id} was not started: this caller's view of the surface is outdated because its Binding was revoked (certainty: not-started). Obtain a fresh connection before calling again."
            ),
        ),
        other => described(
            "failed",
            format!("{id} was not started: {other} (certainty: not-started). Nothing ran."),
        ),
    }
}

/// Formats one outcome envelope as an MCP tool result.
///
/// `content[0].text` opens with the reviewed summary so a model is told plainly
/// whether the interaction returned, was proposed, was denied, was invalid, or
/// may have run; the envelope itself follows in full. Flattening it to prose
/// alone would lose the certainty a caller needs in order to know whether
/// retrying is even safe.
#[must_use]
pub fn tool_result(outcome: &Value) -> Value {
    let described = describe_outcome(outcome);
    let json = serde_json::to_string_pretty(outcome).unwrap_or_else(|_| "{}".to_owned());
    let text = format!("{}\n{json}", described.summary);

    let mut result = json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": outcome.clone(),
    });
    if described.is_error {
        result["isError"] = Value::Bool(true);
    }
    result
}

/// A transport failure, shaped as a tool result rather than a protocol error.
///
/// The distinction matters: a JSON-RPC error means the request was malformed,
/// while an unreachable surface means the call may or may not have happened.
/// Reporting the second as the first would tell a model the call definitely did
/// not occur, which nobody knows.
fn unreachable_result(message: &str) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": format!(
                "The surface could not be reached: {message}. Whether the interaction ran is unknown."
            ),
        }],
        "isError": true,
    })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok(id: &Value, result: &Value, info: &ServerInfo) -> Value {
    let mut result = result.clone();
    result["resultType"] = json!("complete");
    result["_meta"] = json!({ "io.modelcontextprotocol/serverInfo": { "name": info.name, "version": info.version } });
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Handles one JSON-RPC request, returning a response when one is owed.
///
/// A notification carries no id and is answered with `None`, per JSON-RPC.
#[must_use]
pub fn handle(
    request: &Value,
    info: &ServerInfo,
    entries: &[ToolEntry],
    invoker: &dyn ToolInvoker,
) -> Option<Value> {
    let method = request["method"].as_str().unwrap_or_default();
    let id = request.get("id").cloned();

    // Notifications get no response, whatever they are.
    let id = id?;

    if request["jsonrpc"] != "2.0"
        || method.is_empty()
        || !(id.is_string() || id.is_i64() || id.is_u64())
    {
        return Some(error(&Value::Null, -32600, "invalid JSON-RPC request"));
    }
    let envelope = &request["params"]["_meta"];
    let requested = envelope["io.modelcontextprotocol/protocolVersion"]
        .as_str()
        .or_else(|| request["params"]["protocolVersion"].as_str());
    if requested != Some(PROTOCOL_VERSION) || method == "initialize" {
        let mut response = error(&id, -32022, "unsupported protocol version");
        response["error"]["data"] = json!({ "supported": [PROTOCOL_VERSION] });
        if let Some(requested) = requested {
            response["error"]["data"]["requested"] = json!(requested);
        }
        return Some(response);
    }
    if !envelope["io.modelcontextprotocol/clientCapabilities"].is_object() {
        return Some(error(&id, -32602, "invalid modern request envelope"));
    }
    if let Some(client) = envelope.get("io.modelcontextprotocol/clientInfo")
        && (!client["name"].is_string() || !client["version"].is_string())
    {
        return Some(error(&id, -32602, "invalid client info"));
    }

    match method {
        "server/discover" => Some(ok(
            &id,
            &json!({
                "supportedVersions": [PROTOCOL_VERSION],
                "capabilities": { "tools": {} },
                "ttlMs": 0,
                "cacheScope": "private",
            }),
            info,
        )),
        "ping" => Some(ok(&id, &json!({}), info)),
        "tools/list" => {
            let tools: Vec<Value> = entries
                .iter()
                .map(|entry| serde_json::to_value(&entry.tool).unwrap_or(Value::Null))
                .collect();
            Some(ok(
                &id,
                &json!({ "tools": tools, "ttlMs": 0, "cacheScope": "private" }),
                info,
            ))
        }
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or_default();
            let Some(entry) = entries.iter().find(|entry| entry.tool.name == name) else {
                // An unknown tool is a malformed request: the model asked for
                // something that was never offered.
                return Some(error(&id, -32602, &format!("unknown tool: {name}")));
            };
            let arguments = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));

            if !arguments.is_object() {
                return Some(error(&id, -32602, "tool arguments must be an object"));
            }
            let result = match invoker.invoke(&entry.target, arguments) {
                Ok(outcome) => tool_result(&outcome),
                Err(message) => unreachable_result(&message),
            };
            Some(ok(&id, &result, info))
        }
        other => Some(error(&id, -32601, &format!("method not found: {other}"))),
    }
}

/// Serves the protocol over line-delimited JSON on the given streams.
///
/// # Errors
///
/// Returns an error only when the streams themselves fail. A malformed request
/// is answered, not fatal.
pub fn serve(
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    info: &ServerInfo,
    entries: &[ToolEntry],
    invoker: &dyn ToolInvoker,
) -> std::io::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, info, entries, invoker),
            Err(cause) => Some(error(
                &Value::Null,
                -32700,
                &format!("parse error: {cause}"),
            )),
        };

        if let Some(response) = response {
            let mut encoded = serde_json::to_string(&response)
                .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"internal error"}}"#.to_owned());
            encoded.push('\n');
            output.write_all(encoded.as_bytes())?;
            output.flush()?;
        }
    }
}
