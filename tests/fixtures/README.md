# Test fixtures

This is the canonical home for checked-in inputs and small runtime shapes used
by Boundary tests. Fixtures are evidence dependencies, not user-facing examples.

- `runtimes` contains framework and transport proof applications.
- `wasm-imports` contains reviewed component binaries and their WIT sources.
- `plugin-import-abi` contains WAT-built components for the exact host-import
  signature law.
- `portable-runtime` contains consumers copied into packed-package runtime
  proofs.

Executable proof composition remains in the root `justfile`. A fixture may
include a colocated runner when that runner is specific to the fixture's native
runtime.
