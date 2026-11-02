# Plugin worker fixtures

These are small, real Component Model binaries used to prove the Node worker
executor's lifecycle rules. They are not application plugins and do not claim
conformance with the thumbnail guest or another language runtime.

`counter.component.wasm` exports `run`. It keeps a counter in guest linear
memory, returns one decimal digit, and traps when the input is `t`. The worker
tests use it to distinguish a persistent instance, a per-call instance, and
a rebuilt instance after a trap.

`loop.component.wasm` exports `run` and loops forever. It proves that the
host event loop stays responsive and that a deadline terminates the worker.
The source directory remains named `spin` because it describes the behavior;
the generated artifact is named `loop.component.wasm` to make its test role
clear.

Rebuild the checked-in components with `wasm-tools` from the repository root:

```sh
wasm-tools component embed tests/fixtures/plugin-worker/counter/guest.wit --world guest tests/fixtures/plugin-worker/counter/counter.wat -o "${TMPDIR:-/tmp}"/plugin-counter.embed.wasm
wasm-tools component new "${TMPDIR:-/tmp}"/plugin-counter.embed.wasm -o tests/fixtures/plugin-worker/counter.component.wasm
wasm-tools component embed tests/fixtures/plugin-worker/spin/guest.wit --world guest tests/fixtures/plugin-worker/spin/spin.wat -o "${TMPDIR:-/tmp}"/plugin-loop.embed.wasm
wasm-tools component new "${TMPDIR:-/tmp}"/plugin-loop.embed.wasm -o tests/fixtures/plugin-worker/loop.component.wasm
wasm-tools validate --features component-model tests/fixtures/plugin-worker/counter.component.wasm
wasm-tools validate --features component-model tests/fixtures/plugin-worker/loop.component.wasm
```

The temporary `*.embed.wasm` core binaries are intentionally not checked in.
Both WAT modules implement only the Preview 2 ABI needed by their one string
export. Their `realloc` returns a fixed region suitable only for the bounded
test payloads; they do not provide a general allocator, memory-limit proof,
or a production guest implementation.
