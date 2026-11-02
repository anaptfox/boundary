# Import-check fixtures

Nine real components, built with `wasm-tools` 1.261.0. They exist so the
absence test checks a component binary rather than a mock.

`wasm-tools component embed --dummy` generates a core module implementing a
world without any guest language involved. That is exactly right here: these
fixtures test what a component *imports*, and a dummy body imports the same
names a real implementation would. The Zig guest under `examples/guests/thumbnail/zig`
covers the executing path separately.

## Reproduce

The WIT each fixture is built from is checked in beside it under `wit/<name>/`,
so the source is a file rather than a paragraph. Building is two steps:

```console
wasm-tools component embed --dummy wit/<name> -o core.wasm
wasm-tools component new core.wasm -o <name>.component.wasm
```

`just fixtures-verify` does exactly that into a temporary directory and
compares digests. It never writes a fixture: these bytes are the input to the
security boundary test, so a rebuild is a deliberate act, and a fixture that
quietly stopped matching its WIT would change what "refused" means with
nothing to notice. The build is byte-reproducible with the pinned
`wasm-tools` in `config/wasm-versions.json`.

The WIT below is reproduced for reading; `wit/<name>/` is the source of truth.

### `compliant.component.wasm`

Imports one footprint. Binds against an offer of `images`.

```wit
package boundary:guest@1.0.0;

interface footprints {
  images: func(request: string) -> result<string, string>;
}

world guest {
  import footprints;
  export images-make-thumbnail: func(input: string) -> result<string, string>;
}
```

### `overreach.component.wasm`

The same world plus `publications: func(request: string) -> result<string, string>;`
in the `footprints` interface. Identical export. It is refused against an offer
of `images` alone and admitted once `publications` is provided, which is the
point: the bytes never changed, the host's decision did.

### `wasi.component.wasm`

The compliant world plus `import wasi:clocks/wall-clock@0.2.0;`, with a minimal
stand-in package under `deps/clocks/`:

```wit
package wasi:clocks@0.2.0;

interface wall-clock {
  now: func() -> u64;
}
```

A local stand-in is sufficient because the check never inspects WASI semantics.
It refuses the import for the same reason it refuses any unprovided name, which
is the claim under test: WASI is withheld by construction, not by a special
case.

### `import-shapes.component.wasm`

Imports `footprints#images`, a separate `secondary#publications` instance, and
the standalone function `direct-call`. The reviewed vector names every
required import and admits only `images`; the other two must both be reported
as unmapped. This exercises multiple component instance types and direct
function imports in both native implementations. It is built from
`wit/import-shapes/guest.wit` with the same pinned two-step recipe above.

### `aliased-imports.component.wasm`

The imported `provider` instance exports an instance type called `shape`.
The component aliases that type and uses it for the separate `derived` host
import. Inspection must report both `provider#shape` and `derived#run`;
resolving the type does not merge or grant their distinct host imports.
TypeScript and a test-only native wasmparser validator independently consume
this required set and refusal report from the reviewed vector. Wasmtime 49.0.2
refuses this type-export shape; the native runtime test separately
asserts its `unsupported type export` load refusal.

This fixture uses component WAT to express the alias directly. Reproduce with
`wasm-tools parse aliased-imports.wat -o aliased-imports.component.wasm`, then
`wasm-tools validate --features component-model aliased-imports.component.wasm`.
`just fixtures-verify` performs these steps in a temporary directory and compares
the exact checked-in bytes without rewriting them.


### `instantiated-alias-imports.component.wasm`

A local component accepts and re-exports a type with an `allowed` member.
Instantiation supplies a wider type with both `allowed` and `extra`, then the
root aliases the re-export and imports `derived` using that type. Inspection
must report both `derived#allowed` and `derived#extra`. The actual type argument
controls the exported type; retaining only the declared lower bound would
silently omit a host requirement.

Reproduce from `instantiated-alias-imports.wat` with the same WAT parse and
validation recipe. `just fixtures-verify` compares its checked-in bytes, and
TypeScript and the native validator oracle consume the exact required set and
refusal report. The Wasmtime load refusal is checked separately, as above.

### `outer-alias-imports.component.wasm`

A root instance type is aliased with an outer-zero alias and used for the
`derived` import. Both production readers can inspect this shape: the required
set is `derived#run`. It contains no instance-type export, so it also tests
aliases through Wasmtime's supported runtime profile.

Reproduce from `outer-alias-imports.wat` with the same WAT parse/validation recipe.

### `component-argument-imports.component.wasm`

A supplied component exports a wider instance type, while its declared
component parameter exports the smaller type. Forwarding that component
preserves the declared shape: the root import requires only `derived#allowed`.
Type arguments and component arguments follow different substitution laws.

### `ascribed-alias-imports.component.wasm`

A type export uses an explicit smaller ascription before its new type slot
is used by a root instance import. Only `derived#allowed` is required;
the original type's `extra` member is no longer in the exported shape.

Both fixtures are reproduced from their matching WAT files. TypeScript and
the native validator check their exact import sets. Wasmtime's production
reader also checks the ascription case; the component-argument case separately
asserts the runtime's type-export load refusal.

## 2026-09-21 toolchain review

The fixtures were deliberately rebuilt from unchanged WIT when the pinned
`wasm-tools` moved from 1.258.0 to 1.259.0. Each binary changed at exactly four
bytes: the `8` in each `producers` custom section's
`processed-by: wit-component 0.258.0` became `9` for version 0.259.0.
No other bytes changed. Original file sizes remain 1,621 bytes for `compliant`,
1,947 for `overreach`, and 1,920 for `wasi`.

Review used `wasm-tools print`, `wasm-tools component wit`, and
`wasm-tools strip --delete '^producers$'` on both revisions. All three pairs
have identical decoded WIT and byte-identical output after removing only the
producer sections. Both old and new components pass `wasm-tools validate
--features component-model`. The executable code, types, imports, exports,
and other custom sections therefore remain byte-identical; the host-offer
claims under test are unchanged. The reviewed conformance vectors were not
regenerated. Full component digests do change, as they must when artifact
bytes change.

The original binaries remain in Git revision
`5516353fc592c3677a2c401307963d12208c0705`. Their SHA-256 digests and the replacements are:

| Fixture | wasm-tools 1.258.0 | wasm-tools 1.259.0 |
| --- | --- | --- |
| `compliant` | `73e8947c3d86f763fd75cfb39870f37b3b4abdbe0412c3f2219e00e3ac0291a8` | `e62768cfc8069373c3c702337deb9ce6105a6be405c32f9f6ed287fef3adc2cb` |
| `overreach` | `fca81025a7529095211a4b0180468bd31b71a8b1f6587cb4d81fb0fbfc0ec370` | `1770f92a5a875dc08d47225710036dcaf484c9600dd8cbda3e586310cde1765a` |
| `wasi` | `01d6a00eba67ebb350967c776f1f62a2d63374e6244ba24b3a68d4e3c8b7da63` | `438699b66f384bc16528acec671187b5977a3756e353b70441577552018abded` |

After removing only `producers`, the old and new versions share these SHA-256
digests:

- `compliant`: `83e3d9a6bb0c314ff49adc9d70dccb14d5158f02c9ce876ad4807955f5c6382e`
- `overreach`: `cd1268559eee7141875376ddf2852f61fc1f32140ec755a3e9d7a35402cd6fda`
- `wasi`: `2f097e1cfc104968426d643ebc87ffdc8ac7fadcca5dd0f27f25d2eefe4d5411`

Recover an original for an independent comparison with:

```console
git show 5516353fc592c3677a2c401307963d12208c0705:tests/fixtures/wasm-imports/<name>.component.wasm > old.component.wasm
wasm-tools strip --delete '^producers$' old.component.wasm -o old.stripped.wasm
wasm-tools strip --delete '^producers$' <name>.component.wasm -o new.stripped.wasm
cmp old.stripped.wasm new.stripped.wasm
```

## 2026-10-10 toolchain review

Rebuilt from unchanged WIT with wasm-tools 1.261.0. All three decoded WIT
outputs match their previous revisions, and stripping only `producers` gives
byte-identical binaries. Both revisions validate. Reviewed conformance vectors
remain unchanged.

| Fixture | Previous SHA-256 | Current SHA-256 |
| --- | --- | --- |
| `compliant` | `d94cea1e0090739339369056c7202b7d10a65a0ad8287a6a90c1c52ebc2f442c` | `d9df1f1f5eedb27761eead29215a17f96ca0decba94e215e29b581af48559dd9` |
| `overreach` | `4eda22b9e323ce7a37f97b5507dd1f332377e789dd982ba084b58f2d1146da46` | `a981cbef939d57c199ab6ffb95bdf99c0b979d98fcde39b9a4531906fad99b8f` |
| `wasi` | `a3a4ecddcca557ad4aa32e5ad007139a46010914bde4ebe0d80c05b515ee82bb` | `94d531f1466bb2404df6961d471c34f38488b9c904ac128c596e8aa11d3cd05f` |
