//! Test-only wire fixture; it does not establish a real Binding or app effect.
use boundary_mcp::{ServerInfo, Tool, ToolEntry, ToolInvoker, ToolTarget, serve};
use serde_json::{Value, json};
struct Fixture;
impl ToolInvoker for Fixture {
    fn invoke(&self, _target: &ToolTarget, _input: Value) -> Result<Value, String> {
        Ok(json!({ "certainty": "unknown", "result": { "kind": "fault" } }))
    }
}
fn main() -> std::io::Result<()> {
    let entries = [ToolEntry {
        tool: Tool {
            name: "probe".to_owned(),
            description: Some("Synthetic wire qualification".to_owned()),
            input_schema: json!({"type":"object","properties":{}}),
            annotations: serde_json::Map::new(),
        },
        target: ToolTarget {
            binding_digest: "fixture".to_owned(),
            installation_id: "fixture".to_owned(),
            interaction_id: "fixture.probe".to_owned(),
            expected_contract_digest: "fixture".to_owned(),
            actual_contract_digest: "fixture".to_owned(),
            mode: "direct".to_owned(),
            realization_id: "fixture".to_owned(),
            input_arity: 1,
        },
    }];
    serve(
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
        &ServerInfo {
            name: "boundary-wire-fixture".to_owned(),
            version: "1".to_owned(),
        },
        &entries,
        &Fixture,
    )
}
