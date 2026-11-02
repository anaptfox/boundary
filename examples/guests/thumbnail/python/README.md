# Python guest

Realizes `images.makeThumbnail` via `componentize-py --stub-wasi`. Stubs trap
WASI inside the component; the bound import list is still only
`boundary:guest/footprints`. CPython is large (~18MiB) and needs a higher instance
count than the default guest limits. The wasm is not checked in.

```console
just wasm-python-guest
```

Missing `componentize-py` is **blocked**, not passed. Bind identity matches the
Zig guest. Behavior is not claimed equivalent.
