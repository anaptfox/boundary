# boundary-core

Native Rust foundations for interactions, Programs, Projection, Installation, Binding, Handoff, Control, and observed reads.

- **Tier:** pure · **Minimum Rust:** 1.88 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** `@foxworth/boundary` (`compile`, `project`, `install`, `bind`), with `/program`, `/handoff`, `/control`, `/observations`, and `/drafts`

Features: `schemars` (default) for the Schemars codec; `derive` for the `Interaction` and `Fault` macros; `test-util` for the in-memory Control fakes (`control::{InMemoryControlStore, ManualClock, DeterministicIds}`).

Control is always compiled. It is reached as `boundary_core::control`, not from the crate root.

## Use

Declare an interaction with the derive. This is from the [Todo example](../../examples/concepts/rust/todo/README.md):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.list", output = TodoList, error = TodoError, reads("todos"))]
/// List todos.
struct ListTodos {
    filter: Filter,
}
```

After compile, project, install, and bind, a Binding's Caller takes a context value on each call:

```rust
let created = caller
    .call(
        &(),
        &runtime.handles.create,
        CreateTodo {
            title: "Draft interaction".to_owned(),
        },
    )
    .await?;
```

The lifecycle is described in the [Rust reference](../../docs/reference/rust.md).
