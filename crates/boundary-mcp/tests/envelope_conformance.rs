//! The reviewed tool result envelope, shared with the TypeScript MCP and `WebMCP`
//! adapters through `tests/conformance/v1/mcp-envelope.json`.
#![allow(clippy::expect_used, clippy::panic)]

use boundary_mcp::{describe_outcome, tool_result};
use serde_json::Value;

fn vector() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/conformance/v1/mcp-envelope.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("vector file")).expect("vector json")
}

#[test]
fn every_reviewed_case_is_described_exactly() {
    let vector = vector();
    assert_eq!(vector["version"], 1);
    let cases = vector["cases"].as_array().expect("cases");
    assert!(cases.len() >= 7);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let outcome = &case["outcome"];
        let described = describe_outcome(outcome);
        assert_eq!(
            described.kind,
            case["kind"].as_str().expect("kind"),
            "{name}: kind"
        );
        assert_eq!(
            described.summary,
            case["summary"].as_str().expect("summary"),
            "{name}: summary"
        );
        assert_eq!(
            described.is_error,
            case["isError"].as_bool().expect("isError"),
            "{name}: isError"
        );

        let result = tool_result(outcome);
        assert_eq!(
            &result["structuredContent"], outcome,
            "{name}: envelope carried unchanged"
        );
        let text = result["content"][0]["text"].as_str().expect("text");
        assert!(
            text.starts_with(&format!("{}\n", described.summary)),
            "{name}: text opens with the summary"
        );
        assert_eq!(
            result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            described.is_error,
            "{name}: isError flag"
        );
    }
}

#[test]
fn uncertainty_is_never_folded_into_failure() {
    for case in vector()["cases"].as_array().expect("cases") {
        let certainty = case["outcome"]["certainty"].as_str().expect("certainty");
        if certainty == "unknown" || certainty == "not-completed" {
            assert_eq!(case["kind"], "uncertain");
            assert!(
                case["summary"]
                    .as_str()
                    .expect("summary")
                    .contains("Do not repeat it")
            );
        }
    }
}
