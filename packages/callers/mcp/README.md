# `@foxworth/boundary/mcp`

MCP tools backed by an explicit Boundary Binding. The adapter projects admitted
interactions; it does not acquire host lifecycle or revocation authority.

`@modelcontextprotocol/server` is an intentional runtime dependency, not an
optional peer: every MCP server produced by this package uses that SDK.
