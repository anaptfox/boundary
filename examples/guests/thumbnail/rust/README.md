# Rust guest

Realizes `images.makeThumbnail` as a WebAssembly component via
`cargo-component`. Arithmetic only; the host decodes images.

Built for `wasm32-unknown-unknown` so the adapter does not import WASI.
`wasm32-wasip1` would pull `wasi:cli` and fail the import-subset check.

```console
just wasm-rust-guest
```

Missing `cargo-component` is **blocked**, not passed. Bind identity matches
the Zig guest. Behavior is not claimed equivalent.
