# `@foxworth/boundary/webmcp`

Browser-local WebMCP tools backed by an explicit Boundary Binding and a caller-owned
browser registration lifecycle.

`webMcpTool(handle, { consequentialHint, debugging, untrustedContentHint })`
publishes host-selected browser metadata. Consequence defaults to true for a
direct tool with declared changes; an explicit boolean overrides that hint.
Annotations do not change Binding admission, execution mode, or grants.

`sync({ binding, tools })` republishes tools whose browser metadata changes and
retains unchanged tools. The adapter accepts the current `document.modelContext`
surface; browser discovery and `executeTool(tool, inputObject)` remain owned by
the page.

See the [adapter reference](../../docs/reference/adapters.md) for registration,
origin exposure, and invocation behavior.
