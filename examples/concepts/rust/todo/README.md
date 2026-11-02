# Rust Todo host

A minimal native Rust host. It serves seven Todo interactions through one durable Projection and one live Binding.

Run it from the repository root:

```sh
cargo run -p boundary-todo-example
```

The program prints one summary line. For a clean run it should end with `changed_all=2 listed=2 cleared=1`. The line is derived from reading `src/main.rs`, not from a recorded run.

## What it shows

- **Declaring:** seven `#[derive(Interaction)]` request structs (`todos.list`, `todos.create`, `todos.rename`, `todos.set-completed`, `todos.remove`, `todos.set-all-completed`, `todos.clear-completed`). `TodoError` derives `Fault`, so each variant has a stable code such as `todo_not_found`.
- **Compiling:** `compile_interaction::<O>()` turns each declaration into a handler-free `CompiledInteraction`.
- **Selecting:** `project` builds a Projection that selects every interaction with direct mode, under the aliases `list`, `create`, `rename`, `setCompleted`, `remove`, `setAllCompleted`, and `clearCompleted`.
- **Realizing:** `install` binds each direct realization to the in-memory `TodoService`, under the installation ID `todo/local/v1`.
- **Binding:** `bind` with `admit_all()` returns the live Binding. If the Projection is unrealized, `main` returns an error that lists the issues.
- **Calling:** the program calls through `binding.caller()`, passing `&()` as the context, since this host has none.

Start reading at `build_runtime` in `src/main.rs`, then `run`.

## Related

- [Rust lifecycle and conformance](../../../../docs/reference/rust.md)
- [`boundary-core`](../../../../crates/boundary-core/README.md) and [`boundary-macros`](../../../../crates/boundary-macros/README.md)
- The test-only cross-language Todo, used by `just test-cross-language`, lives at [`crates/boundary-core/examples/cross_language_todo`](../../../../crates/boundary-core/examples/cross_language_todo). It is a proof fixture, not a second example of the same host.
