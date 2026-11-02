# boundary-bus

A per-user local bus that resolves where a Binding can be reached.

- **Tier:** composition · **Minimum Rust:** 1.96 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** `@foxworth/boundary/bus`

The bus is a resolver, not a broker. It holds Reach records and nothing else: no authority, no invocation context, and no record of calls. A caller reaches the Binding directly. Trust is the OS user, and there is no network listener. Registration proves possession by fetching the manifest (`prove_possession_by_manifest`, Unix only).

Public API: `BusServer`, `BusClient`, `Registry`, `Request`, and `Response`.

- Examples: `examples/register.rs` and `examples/announce.rs` show registration and announcement.
- Tests: `tests/socket_lifecycle.rs`. Run `just bus-test`, which covers this crate and `boundary-reach`.
- Used by: [`boundary-cli`](../boundary-cli/README.md), which provides the `boundary bus` command.
