# Component inspection fixtures

`indexed-imports.component.wasm` is encoded from `indexed-imports.wat` with
Jco 1.37.0 (`jco-transpile` 0.18.0). It exercises numeric type indices after
both an exported type and an imported equality-bound type, a second imported
interface, a resource type member, a standalone function, and a nested core
module import that the root host does not supply.

Reproduce from the repository root:

```sh
node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "./packages/node_modules/@bytecodealliance/jco/dist/api.js";
const path = "tests/fixtures/plugin-inspection/indexed-imports";
writeFileSync(`${path}.component.wasm`, await parse(readFileSync(`${path}.wat`, "utf8")));
JS
```

The focused inspection test checks the encoded bytes against this source.
Inspection does not instantiate or call the component. Full execution
validation remains a separate Jco transpilation prerequisite in the loader.

The focused tests also encode scoped alias cases with the installed Jco peer:
imported, defined, exported, and instantiated instances; numeric and symbolic
references; immediate and nested outer scopes; instantiation of wider type
arguments; and narrowing export ascriptions. Required names include every
root imported instance member, while nested guest imports stay internal.

Alias rules were traced from Jco 1.37.0 commit
`e58dfbee7e72fb72fc4d88a09e71dd2d5b55855c` and its locked wasm-tools 1.259.0
commit `7fc33f279ec4fb3bf0623a14d388725ee8a1ce65`. Upstream fixtures read before
the implementation include `tests/cli/component-model/alias.wast`,
`resources.wast`, and `export-ascription.wast`; the corresponding validator
paths are `crates/wasmparser/src/validator/component.rs` and
`component_types.rs`. These are source evidence, not executed upstream tests.
The positive local alias fixtures were independently validated with the
installed wasm-tools 1.261.0.
