# boundary-macros

Derives `Interaction` and `Fault` for `boundary-core`.

- **Tier:** pure · **Minimum Rust:** 1.88 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** `defineInteraction` from `@foxworth/boundary`

Do not depend on this crate directly. Enable the `derive` feature of `boundary-core`, which re-exports both macros as `boundary_core::{Interaction, Fault}`.

## Attributes

`#[interaction(...)]` on a struct with named fields:

- `id = "..."` and `output = Type` are required. `error = Type` is optional and defaults to `NoError`. `error_codec = Codec` (requires `error`) replaces the default `JsonCodec<Type>` with a `DeclaredErrorCodec`; override its `declared_schema` to declare a finite code vocabulary or code-specific details.
- `reads("...")` and `changes("...")` declare footprints. Any `changes` makes the interaction stateful. Without `reads`, the reads default to the changes.
- `no_input` marks a fieldless, zero-argument interaction.

`#[fault(code = "...")]` goes on every variant of an enum that derives `Fault`. Codes must be non-empty.

### The `{ code, details }` error envelope

Declare an error enum with `#[serde(deny_unknown_fields, tag = "code", content = "details")]` and `Fault` marks it as the portable envelope itself (`PortableFault::ENVELOPE`). The enum's own Schemars schema becomes the contract `errorSchema`, exactly the closed `oneOf` of `{ code: { const }, details }` objects that TypeScript builds from `errors: { code: schema }`, in code order. A Handoff carries `code` and `details` separately, so there is no second wrapper:

- a variant with a payload has the payload as `details` (`NotFound { id }` is `{ "code": "todo_not_found", "details": { "id": "x" } }`);
- a unit variant has `details: null`, since TypeScript requires `details` (its schema is `{ "type": "null" }`);
- each variant must be serialized under its fault code, so give it `#[serde(rename = "<code>")]` (or a matching identifier). The derive refuses a mismatch, and encoding refuses one at runtime;
- codes must be TypeScript tokens (`[A-Za-z][A-Za-z0-9_-]{0,63}`), the same rule `defineInteraction({ errors })` applies, so `todo.not_found` is not allowed here.

Any other error type keeps the generic envelope: the whole serialized error is `details` under any nonempty `code`. Both shapes validate the complete `{ code, details }` value, but only an envelope enum yields a contract identical to a TypeScript declaration. `error_codec = Codec` on `#[interaction]` selects a hand-written `DeclaredErrorCodec` instead.

Doc comments become the interaction's summary and description. Tuple structs are rejected. The compile-fail cases live in `tests/ui/`.

## Example

From the [Todo example](../../examples/concepts/rust/todo/README.md):

```rust
#[derive(Debug, Error, Serialize, Deserialize, JsonSchema, Fault)]
#[serde(deny_unknown_fields, tag = "code", content = "details")]
enum TodoError {
    #[error("todo {id} was not found")]
    #[fault(code = "todo_not_found")]
    #[serde(rename = "todo_not_found")]
    NotFound { id: String },
    #[error("todo state is unavailable")]
    #[fault(code = "todo_unavailable")]
    #[serde(rename = "todo_unavailable")]
    Unavailable,
}
```
