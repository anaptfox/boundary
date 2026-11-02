# Rust/TypeScript Todo process proof

Run `just test-cross-language` from the repository root. L3 (`just gate`)
includes this recipe. The default TypeScript unit suite excludes this directory;
TypeScript compilation still checks its sources and generated type assertions.

It exercises the current
`compile_interaction` / Installation / Binding / checked Handoff and TypeScript
Host / SurfaceClient / Control APIs. The Rust program lives under
`crates/boundary-core/examples/cross_language_todo` to reuse the crate's existing
development dependencies. It is test infrastructure, not a recommended public
application example. Neither production implementation embeds the other.

## What the tests establish

- `scenarios.v1.json` retains the seven-interaction Todo trace, including the
  missing-item domain error, whose details are `{ "id": ... }` and whose code
  is `todo_not_found`. The codes `todo_not_found` and `todo_unavailable`
  satisfy the current TypeScript token rules.
  The explicit zero-input Rust codec now uses the current TypeScript Handoff
  representation, `null`, instead of the old fixture's empty object.
- Rust executes through a real installed Binding and checked Handoff in a
  child process. TypeScript separately declares and realizes the same domain
  behavior. The tests compare returned values and native declared errors
  against the scenario; they do not equate the two contract identities.
- Generated references carry Rust-owned IDs, digests, arities, and bounded
  input/output types. They are checked against the live handshake before use.
  A stale reference rejects. Compile-only assertions exercise required inputs,
  output types, zero-input arity, and direct-only modes.
- Invalid input, stale Binding/contract identity, and unselected interactions or
  modes reject before the Rust create handler runs. The fixture's private
  statistics prove the effect count in these tests.
- Caller-side Control requests, approves, grants, and executes a create. The
  transport discards its response after Rust finishes. Execution stays
  `uncertain`, repeated execution does not create again, and reconciliation
  observes the existing row after lease expiry. The test checks one create
  throughout, including replay after completion.

The recovery policy assumes a fresh, single-writer host. Matching a title is
valid only under that bounded fixture assumption; concurrent production writers
would need durable mutation identity and appropriate fencing. The journal is
in memory, the Rust process stays alive, and no crash durability or Rust
request-mode Control parity is claimed.

## Declared-error interoperability

Both implementations validate the complete `{ code, details }` value against
the contract's `errorSchema` (see `tests/conformance/v1/declared-errors.json`).
Rust's `TodoFault` is a `#[derive(Fault)]` enum marked
`tag = "code", content = "details"`, so its Schemars schema is itself the
code-specific `oneOf` that TypeScript builds from `errors: { code: schema }`; so
all seven interactions share input, output, error schema, and contract digest
with the TypeScript declaration. A Rust declared error now completes through
the production TypeScript client.

## Regenerating derived references

After a deliberate Rust declaration change, build the fixture and run:

```console
cargo build -p boundary-core --example cross_language_todo --features derive
node tests/typescript/cross-language/generate.mjs --write
just test-cross-language
```

Review the generated diff. Normal checks compare without rewriting. The
generator supports only the closed-object, array, string, boolean, null, and
enum subset used here. It emits no runtime handlers and no typed-error promise.
It is not a general JSON Schema compiler. The scenario is reviewed evidence
and is never regenerated from either implementation.

A reverse TypeScript-host / Rust-client direction is not covered.
