# boundary-mcp

A Model Context Protocol server over the interactions that reachable Bindings expose.

- **Tier:** composition · **Minimum Rust:** 1.96 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** `@foxworth/boundary/mcp`

One server per OS user exposes every interaction that applications on the machine currently expose. An application narrows what it shows only through its own Projection. This crate holds no authority, and each application still admits every call it receives.

- Protocol: `PROTOCOL_VERSION` is `2026-07-28`. Legacy initialization is rejected.
- Entry points: `serve` runs the stdio loop, and `handle` answers one JSON-RPC request. `tools_from_manifest` and `merge` turn Binding manifests into tools. `tool_result` formats outcomes, and `ToolInvoker` is the trait a host implements.
- Command: `boundary mcp`, provided by [`boundary-cli`](../boundary-cli/README.md).
- Tests: `tests/protocol.rs`. Example: `examples/protocol_fixture.rs`.

`just rust-mcp-modern-smoke` runs a test-only TypeScript caller against the Rust stdio server. Its synthetic invoker shows wire interoperability and unknown outcomes. It does not run application code.
