# Go guest

Realizes `images.makeThumbnail` as a TinyGo `wasm-unknown` core module with a
hand-written Canonical ABI, then `wasm-tools component embed` / `component new`
with no WASI adapter. `wasip2` is refused: it imports WASI.

The matching Go toolchain is pinned in `config/wasm-versions.json`. TinyGo 0.41
was built with Go 1.26; `-go-compatibility=false` lets a newer host Go invoke
that toolchain.

```console
just wasm-go-guest
```

Missing TinyGo is **blocked**, not passed. Bind identity matches the Zig guest.
Behavior is not claimed equivalent.

