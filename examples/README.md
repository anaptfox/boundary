# Boundary examples

Examples are grouped by what they are for. Applications show complete,
host-owned experiences. Concepts isolate one engineering idea. Guests compare
the same portable WebAssembly boundary across languages. Documentation snippets
are executable source for the public docs.

Runtime fixtures used to prove framework behavior live under
[`tests/fixtures/runtimes`](../tests/fixtures/runtimes/README.md), not here.

## Applications

- [`apps/typescript/document-workspace`](apps/typescript/document-workspace/README.md) — a
  Next.js document workspace with human review, MCP, WebMCP, and local agents.
- [`apps/typescript/persistent-bot`](apps/typescript/persistent-bot/README.md) —
  a bounded Bun bot with durable jobs, interruption, and reconciliation.
- [`apps/typescript/todo-multisurface`](apps/typescript/todo-multisurface) — one
  Todo installation reached through browser, MCP, WebMCP, and Electron surfaces.

## Focused concepts

- [`concepts/typescript/control-durable`](concepts/typescript/control-durable/README.md)
  — a host-owned SQLite Control journal and crash recovery proof.
- [`concepts/typescript/live-observations`](concepts/typescript/live-observations/README.md)
  — cross-process mutation observations refreshing a human view.
## Rust and C hosts

Rust host examples are workspace members. Run them from the repository root:

- [`concepts/rust/todo`](concepts/rust/todo/README.md): a native Rust Todo host.
  `cargo run -p boundary-todo-example`
- [`concepts/rust/controlled-mutation`](concepts/rust/controlled-mutation/README.md):
  one interaction through request, approval, grant, and receipt.
  `cargo run -p boundary-controlled-mutation-example`
- [`concepts/c`](concepts/c/README.md): C11 and C++ consumers of the C ABI.
  `just native-abi-smoke`

The Rust examples are not part of the MSRV promise. See the
[Rust reference](../docs/reference/rust.md) for the crates they use.

## WebAssembly guests

[`guests/thumbnail`](guests/thumbnail) contains Rust, JavaScript, Go, Python,
and Zig realizations of the same thumbnail guest world. The Rust crate in
[`guests/thumbnail/rust`](guests/thumbnail/rust/README.md) is a WebAssembly guest
run by the `boundary-plugin` host. It is not a host example and is not a Cargo
workspace member. Run `just wasm-guest-smoke`; its summary reports unavailable
toolchains as blocked rather than passed.

## Documentation snippets

[`snippets/typescript`](snippets/typescript) contains executable source embedded
in `README.md` and `docs/`. These files support documentation checks; they are
not separate applications.
