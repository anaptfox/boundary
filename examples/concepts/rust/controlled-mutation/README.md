# Rust controlled mutation

One exact interaction, `todos.create`, takes the full controlled path: request, approval, grant, a fenced execution, and a receipt. A second execution with the same idempotency key returns the receipt without applying the effect again.

Run it from the repository root:

```sh
cargo run -p boundary-controlled-mutation-example
```

It prints `completed:` with attempt, receipt, and apply counts. The program asserts that `apply_calls` is 1 after the replay.

## What it shows

- The `CreateTodo` interaction derives `Interaction`, and `Program::builder().include::<CreateTodo>()` builds the Program that identifies it.
- `ControlledHandler` drives the steps in order: `request`, `approve`, `grant`, then `execute`. The `ControlledEffect` implementation applies the mutation, verifies it, and reconciles an uncertain result.
- The `Actor`, `DurationMillis`, and idempotency-key values are validated when they are constructed.

## Test-only parts

The example enables the `test-util` feature of `boundary-core`. That provides `InMemoryControlStore`, `ManualClock`, and `DeterministicIds`. They are for tests and demos, not a production journal or clock. A real host supplies its own `ExecutionJournal`, `AuthorityStore`, and `Clock`.

## Related

- [Rust lifecycle and conformance](../../../../docs/reference/rust.md), in the Control section
- [`boundary-core`](../../../../crates/boundary-core/README.md)
- The TypeScript durable Control concept, [`control-durable`](../../typescript/control-durable/README.md)
