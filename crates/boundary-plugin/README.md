# boundary-plugin

WASM guest realizations: a component implements a Program's interactions in any guest language, and the host admits it under an explicit import map.

- **Tier:** composition · **Minimum Rust:** 1.96 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** `@foxworth/boundary/plugin`, which runs guests through jco workers without Rust's runtime limits

Two rules:

- **Authority is absence.** A plugin reaches only the host functions the host maps by name. The bind-time check refuses any import outside that map. Whether a mapped function honors its declared read or change class stays a host review obligation.
- **Context never crosses.** The per-invocation context is never serialized and never reaches guest code.

Public API:

- `HostImports` lists the imports a guest may use, built with `.provide(footprint)`.
- `HostFunctions` holds the host implementations, registered with `.provide`.
- `PluginComponent::load` loads a component, and `check_imports` runs the bind-time import check against `HostImports`. `GuestLimits` and `guest_engine` set wasmtime fuel and memory limits.
- `project_wit` spells a Program as a WIT world.

Conformance: `tests/wasm_projection_conformance.rs` reads `wasm-projection.json`, and `tests/wasm_import_subset.rs` reads `wasm-import-subset.json`. TypeScript reads both as well.

Guest examples are in [`examples/guests/thumbnail`](../../examples/guests/thumbnail). Run `just wasm-guest-smoke`. A missing toolchain is reported as blocked, not passed. The [plugin reference](../../docs/reference/plugin.md) covers the TypeScript and Rust APIs.
