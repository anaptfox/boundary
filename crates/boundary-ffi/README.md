# boundary-ffi

A synchronous, host-owned C ABI over Boundary's checked native lifecycle.

- **Tier:** composition · **Minimum Rust:** 1.96 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** none. The C ABI is Rust-only.

The crate builds `cdylib`, `staticlib`, and `rlib`. It is the only crate that may use `unsafe`, for C ABI exports and pointer conversion. Each safety contract is written in the header and at each unsafe operation.

```sh
just native-abi-build     # target/debug/libboundary_ffi.{dylib,so} and libboundary_ffi.a
just native-abi-smoke     # stages, relocates, and runs the C and C++ consumers
```

Exports: `boundary_abi_version`, `boundary_capabilities`, `boundary_host_create`, `boundary_host_add`, `boundary_host_bind`, `boundary_host_destroy`, `boundary_binding_manifest`, `boundary_binding_invocation`, `boundary_binding_invoke`, `boundary_binding_revoke`, `boundary_binding_destroy`, and `boundary_buffer_free`.

- Header: [`include/boundary.h`](include/boundary.h). It is hand-written, and the smoke test checks it against the exports.
- Guide: [Embed Boundary in a native host](../../docs/guides/native-embedding.md)
- Consumers: [`examples/concepts/c`](../../examples/concepts/c/README.md)
- Reference: [Rust reference, C ABI](../../docs/reference/rust.md#c-abi)
