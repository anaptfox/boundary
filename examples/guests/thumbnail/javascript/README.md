# JavaScript guest

Realizes `images.makeThumbnail` via `jco componentize --disable all`.
StarlingMonkey still ships inside the component (~12MiB). WASI is disabled, so
the bound import list is only `boundary:guest/footprints`. The wasm is not checked
in.

```console
just wasm-js-guest
```

Missing `jco` is **blocked**, not passed. Bind identity matches the Zig guest.
Behavior is not claimed equivalent.

