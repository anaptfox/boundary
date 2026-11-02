# Vite native lifecycle example

This is a bare Vite frontend fixture for the native lifecycle proof. It uses
the repository's existing Vite installation and does not add a demo package or
dependency.

Run the real dev-server proof from the repository root:

```sh
node tests/fixtures/runtimes/vite/run.mjs
```

The proof creates its own temporary host entry, starts Vite on ephemeral ports,
binds a real `vite.todos.list`/`vite.todos.create` workflow to a JSON-backed
application store, edits implementation and generation files, retains the old
generation through a rejected candidate, recovers in preview, and closes both
servers to verify cleanup. A successful local run is lifecycle evidence for
this fixture, not a production persistence or deployment claim.
