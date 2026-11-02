# Exact host-import signature fixtures

Real components built from hand-written, checked-in WAT. The host import is
`boundary:guest/footprints@1.0.0#images`, provided as
`(string) -> result<string, string>`. Reviewed expectations live in
`tests/conformance/v1/plugin-import-abi.json`; Rust and TypeScript consume them
independently. Regenerating bytes never regenerates expectations.

- `extra-parameter`, `wrong-parameter`, `absent-result`, `wrong-result` declare
  an incompatible import signature. Their core start function calls the import
  and then traps, so any admission would show up as a host entry. Refusal must
  precede startup with zero host entries.
- `async-profile` is a valid component using component-model async, outside the
  synchronous profile. It imports nothing; admission refuses it on both hosts.
  It validates only with `cm-async` enabled, which `just fixtures-verify` passes
  for this fixture alone.
- `alias-export-admitted` / `alias-outer-admitted` have the matching signature
  reached through an alias of a type exported by an in-component instance and
  through an outer alias; both are admitted and called. `alias-export-mismatch`
  puts an extra parameter behind the exported-type alias and is refused before
  startup. wasmtime 49 does not accept components that export types from a
  nested component, so that shape is not a fixture.
- `startup-trap` has the matching signature, enters the host in core startup,
  then traps.
- `import-call` enters the host from its export and returns the reply.
- `invoke-trap` enters the host from its export, then traps.

The core modules leave the imported function unnamed and call it by index. A
name-bearing `call $images` is also read correctly now (an identifier is the
token after its keyword, covered by `tests/typescript/plugin-component-projection.test.ts`),
but the fixtures stay as reviewed.

`just fixtures-verify` parses every `*.wat` with the pinned `wasm-tools`
(`config/wasm-versions.json`), validates it, and requires the bytes to match the
checked-in `*.component.wasm`. It never writes a fixture.
