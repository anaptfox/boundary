//! The MCP surface: tool derivation and outcome reporting.
//!
//! Parity target is `packages/callers/mcp/server.ts`, which the TypeScript adapter
//! already ships. Catalog and outcome cases are shared; the process consumer
//! separately qualifies modern stdio interoperability, not full SDK parity.
#![allow(clippy::expect_used, clippy::panic)]

use boundary_mcp::{
    PROTOCOL_VERSION, ServerInfo, ToolError, ToolInvoker, ToolTarget, handle, merge, tool_result,
    tools_from_manifest,
};
use serde_json::{Value, json};

/// A manifest shaped like the one the protocol serves, with two interactions:
/// one read-only, one that changes state.
fn manifest(binding: &str, alias_prefix: &str) -> Value {
    json!({
        "version": 1,
        "bindingDigest": format!("sha256:{binding}"),
        "installationId": "deploy:demo:1",
        "expectedProgram": {
            "version": 1,
            "interactions": [
                {
                    "contract": {
                        "version": 1,
                        "id": "images.inspect",
                        "inputSchema": {"type":"object","properties":{"imageId":{"type":"string"}},"required":["imageId"],"additionalProperties":false},
                        "outputSchema": {"type":"object","additionalProperties":false},
                        "reads": ["images"],
                        "changes": []
                    },
                    "docs": { "summary": "Inspect an image" }
                },
                {
                    "contract": {
                        "version": 1,
                        "id": "images.makeThumbnail",
                        "inputSchema": {"type":"object","properties":{"imageId":{"type":"string"}},"required":["imageId"],"additionalProperties":false},
                        "outputSchema": {"type":"object","additionalProperties":false},
                        "reads": ["images"],
                        "changes": ["images"]
                    },
                    "docs": { "description": "Make a thumbnail" }
                }
            ]
        },
        "interactions": [
            {
                "alias": format!("{alias_prefix}inspect"),
                "interactionId": "images.inspect",
                "expectedContractDigest": "sha256:aaa",
                "actualContractDigest": "sha256:bbb",
                "inputArity": 1,
                "mode": "direct",
                "realizationId": "inspect:v1"
            },
            {
                "alias": format!("{alias_prefix}thumbnail"),
                "interactionId": "images.makeThumbnail",
                "expectedContractDigest": "sha256:ccc",
                "actualContractDigest": "sha256:ddd",
                "inputArity": 1,
                "mode": "direct",
                "realizationId": "thumb:v1"
            }
        ]
    })
}

fn modern(mut request: Value) -> Value {
    request["params"]["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    request
}

struct Recorder {
    outcome: Value,
}

impl ToolInvoker for Recorder {
    fn invoke(&self, _target: &ToolTarget, _input: Value) -> Result<Value, String> {
        Ok(self.outcome.clone())
    }
}

struct Unreachable;

impl ToolInvoker for Unreachable {
    fn invoke(&self, _target: &ToolTarget, _input: Value) -> Result<Value, String> {
        Err("connection refused".to_owned())
    }
}

fn info() -> ServerInfo {
    ServerInfo {
        name: "boundary".to_owned(),
        version: "0.1.0".to_owned(),
    }
}

fn outcome(kind: &str) -> Value {
    let result = match kind {
        "returned" => json!({"kind":"returned","value":{"ok":true}}),
        "declared-error" => json!({"kind":"declared-error","code":"REFUSED","details":{}}),
        "denied" => json!({"kind":"denied","code":"DENIED"}),
        _ => json!({"kind":"fault","cause":"realization-failed"}),
    };
    json!({
        "version": 1,
        "bindingDigest": "sha256:aaa",
        "installationId": "deploy:demo:1",
        "interactionId": "images.inspect",
        "expectedContractDigest": "sha256:aaa",
        "actualContractDigest": "sha256:bbb",
        "mode": "direct",
        "realizationId": "inspect:v1",
        "certainty": "completed",
        "result": result
    })
}

#[test]
fn tools_come_from_the_manifest_with_read_only_hints() {
    let entries = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    assert_eq!(entries.len(), 2);

    let inspect = &entries[0];
    assert_eq!(inspect.tool.name, "inspect");
    // The surface's own words, carried through unchanged but attributed: a
    // model must not read remote text as though Boundary wrote it.
    assert_eq!(
        inspect.tool.description.as_deref(),
        Some("[from binding sha256:aaa] Inspect an image")
    );
    assert_eq!(inspect.tool.annotations["readOnlyHint"], Value::Bool(true));

    let thumbnail = &entries[1];
    assert_eq!(
        thumbnail.tool.description.as_deref(),
        Some("[from binding sha256:aaa] Make a thumbnail")
    );
    assert_eq!(
        thumbnail.tool.annotations["readOnlyHint"],
        Value::Bool(false),
        "an interaction that declares changes is not read-only"
    );
}

#[test]
fn the_input_schema_is_the_expected_contract_verbatim() {
    let entries = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    assert_eq!(
        entries[0].tool.input_schema["properties"]["imageId"]["type"], "string",
        "a model must see the contract the surface promised, not a paraphrase"
    );
}

#[test]
fn pins_are_carried_through_untouched() {
    let entries = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    let target = &entries[1].target;
    assert_eq!(target.interaction_id, "images.makeThumbnail");
    assert_eq!(target.expected_contract_digest, "sha256:ccc");
    assert_eq!(target.actual_contract_digest, "sha256:ddd");
    assert_eq!(target.realization_id, "thumb:v1");
    assert_eq!(target.mode, "direct");
}

#[test]
fn every_bound_interaction_becomes_a_tool() {
    // No second list narrows what a model sees. An application that wants a
    // model to see less publishes a smaller Projection, which also keeps the
    // interaction out of the Binding — the only narrowing that is enforced.
    let entries = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    let ids: Vec<&str> = entries
        .iter()
        .map(|entry| entry.target.interaction_id.as_str())
        .collect();
    assert_eq!(ids, vec!["images.inspect", "images.makeThumbnail"]);
}

#[test]
fn surfaces_merge_into_one_catalog() {
    let first = tools_from_manifest(&manifest("aaa", "photos-")).expect("tools");
    let second = tools_from_manifest(&manifest("bbb", "docs-")).expect("tools");
    let merged = merge(vec![first, second]);
    assert!(merged.dropped.is_empty(), "distinct names do not clash");
    assert_eq!(merged.entries.len(), 4);
    // Sorted, so a model sees a stable catalog across runs.
    let names: Vec<&str> = merged
        .entries
        .iter()
        .map(|entry| entry.tool.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            "docs-inspect",
            "docs-thumbnail",
            "photos-inspect",
            "photos-thumbnail"
        ]
    );
}

/// A clash is reported and the clashing pair dropped — never resolved by
/// prefixing or by picking a winner, which would hide which surface a model
/// reached.
#[test]
fn a_name_offered_by_two_surfaces_is_dropped_and_reported() {
    let first = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    let second = tools_from_manifest(&manifest("bbb", "")).expect("tools");
    let merged = merge(vec![first, second]);

    assert!(
        merged.entries.is_empty(),
        "every name in this pair clashes, so none survives"
    );
    let names: Vec<&str> = merged
        .dropped
        .iter()
        .map(|duplicate| duplicate.name.as_str())
        .collect();
    assert_eq!(names, vec!["inspect", "thumbnail"]);
    for duplicate in &merged.dropped {
        assert_eq!(duplicate.bindings, vec!["sha256:aaa", "sha256:bbb"]);
    }
}

/// The whole point of dropping rather than failing: one surface claiming an
/// existing alias must not deny the user every tool from every application.
#[test]
fn one_clashing_surface_does_not_deny_the_others() {
    let honest = tools_from_manifest(&manifest("aaa", "photos-")).expect("tools");
    let other = tools_from_manifest(&manifest("bbb", "docs-")).expect("tools");
    let squatter = tools_from_manifest(&manifest("ccc", "photos-")).expect("tools");

    let merged = merge(vec![honest, other, squatter]);
    let names: Vec<&str> = merged
        .entries
        .iter()
        .map(|entry| entry.tool.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["docs-inspect", "docs-thumbnail"],
        "the uninvolved surface keeps every one of its tools"
    );
    assert_eq!(merged.dropped.len(), 2, "both clashing names are reported");
}

/// Aliases are chosen by whoever serves the manifest, so a name a model reads
/// cannot be allowed to carry homoglyphs, control characters, or padding.
#[test]
fn an_alias_outside_the_name_charset_is_refused() {
    for hostile in [
        "photos\u{202e}sotohp",
        "photos\ninspect",
        "photos inspect",
        "phot\u{043e}s-inspect",
        "",
    ] {
        let mut value = manifest("aaa", "");
        value["interactions"][0]["alias"] = serde_json::Value::String(hostile.to_owned());
        let error = tools_from_manifest(&value)
            .err()
            .unwrap_or_else(|| panic!("{hostile:?} must be refused as a tool name"));
        assert!(
            matches!(error, ToolError::UnusableName { .. }),
            "expected an unusable-name refusal, got {error:?}"
        );
    }
}

/// A description is written by the remote surface and read by a model as tool
/// documentation. It must arrive naming where it came from.
#[test]
fn a_description_names_the_binding_it_came_from() {
    let tools = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    for entry in &tools {
        let description = entry
            .tool
            .description
            .as_deref()
            .unwrap_or_else(|| panic!("every tool carries provenance"));
        assert!(
            description.starts_with("[from binding sha256:aaa]"),
            "got {description:?}"
        );
    }
}

#[test]
fn discovery_announces_the_supported_protocol_version() {
    let response = handle(
        &modern(json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}})),
        &info(),
        &[],
        &Recorder {
            outcome: outcome("returned"),
        },
    )
    .expect("discovery is answered");
    assert_eq!(
        response["result"]["supportedVersions"],
        json!([PROTOCOL_VERSION])
    );
    assert_eq!(
        response["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "boundary"
    );
    assert!(response["result"]["capabilities"]["tools"].is_object());
}

#[test]
fn a_notification_is_not_answered() {
    let response = handle(
        &json!({"jsonrpc":"2.0","method":"notifications/progress"}),
        &info(),
        &[],
        &Recorder {
            outcome: outcome("returned"),
        },
    );
    assert!(
        response.is_none(),
        "a notification carries no id and gets no reply"
    );
}

#[test]
fn tools_list_returns_the_catalog() {
    let entries = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    let response = handle(
        &modern(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})),
        &info(),
        &entries,
        &Recorder {
            outcome: outcome("returned"),
        },
    )
    .expect("answered");
    let tools = response["result"]["tools"].as_array().expect("tools");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], "inspect");
    assert!(tools[0]["inputSchema"].is_object());
}

#[test]
fn a_returned_outcome_is_not_an_error() {
    let result = tool_result(&outcome("returned"));
    assert!(result.get("isError").is_none());
    assert_eq!(result["structuredContent"]["result"]["kind"], "returned");
}

#[test]
fn a_declared_error_and_a_denial_are_both_reported_as_errors() {
    for kind in ["declared-error", "denied", "fault"] {
        let result = tool_result(&outcome(kind));
        assert_eq!(
            result["isError"],
            Value::Bool(true),
            "{kind} must be visible to a model as a failure"
        );
        // The envelope survives in full, so certainty is not lost.
        assert_eq!(result["structuredContent"]["certainty"], "completed");
    }
}

#[test]
fn an_unknown_tool_is_a_protocol_error() {
    let response = handle(
        &modern(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope"}})),
        &info(),
        &[],
        &Recorder {
            outcome: outcome("returned"),
        },
    )
    .expect("answered");
    assert_eq!(response["error"]["code"], -32602);
}

#[test]
fn an_unreachable_surface_does_not_claim_the_call_did_not_happen() {
    let entries = tools_from_manifest(&manifest("aaa", "")).expect("tools");
    let response = handle(
        &modern(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"inspect","arguments":{}}})),
        &info(),
        &entries,
        &Unreachable,
    )
    .expect("answered");

    // A transport failure is a tool error, not a JSON-RPC error: the request
    // was well formed and whether the interaction ran is unknown.
    assert!(response.get("error").is_none());
    assert_eq!(response["result"]["isError"], Value::Bool(true));
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("text");
    assert!(text.contains("unknown"), "{text}");
}

#[test]
fn an_unknown_method_is_reported_as_method_not_found() {
    let response = handle(
        &modern(json!({"jsonrpc":"2.0","id":5,"method":"resources/list"})),
        &info(),
        &[],
        &Recorder {
            outcome: outcome("returned"),
        },
    )
    .expect("answered");
    assert_eq!(response["error"]["code"], -32601);
}

#[test]
fn legacy_requests_and_missing_capabilities_are_rejected() {
    let invoker = Recorder {
        outcome: outcome("returned"),
    };
    let legacy = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}});
    let response = handle(&legacy, &info(), &[], &invoker).expect("rejection");
    assert_eq!(response["error"]["code"], -32022);
    assert_eq!(
        response["error"]["data"]["supported"],
        json!([PROTOCOL_VERSION])
    );
    let mut malformed = modern(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}));
    malformed["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"] = Value::Null;
    let response = handle(&malformed, &info(), &[], &invoker).expect("rejection");
    assert_eq!(response["error"]["code"], -32602);
}
