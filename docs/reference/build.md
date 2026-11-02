---
title: "Host build reference"
description: "Load interaction modules and write portable Host artifacts from a Node build."
---

# Host build reference

`@foxworth/boundary/build` is the optional Node build entry for explicit interaction
module loading and portable artifact files. It drives the same
[`compileInteractions`](./host.md#compileinteractions) library path used by direct
imports; it is not a second interaction model, project framework, scanner, or
runtime wrapper.

The root `@foxworth/boundary` entry never imports this module. Build-only Node and
filesystem dependencies therefore do not enter normal host or caller bundles.

For receipt-aware consumer maintenance, `@foxworth/boundary/artifact` verifies
explicit package-content manifests and adjacent tarball receipts, then compares
exports, runtime requirements, and caller-supplied contract changes. Its
read-only comparison never installs or updates a consumer. See the
[package artifact reference](./artifact.md).

## Explicit interaction module

`*.boundary.ts` is an optional TypeScript convention. A conforming interaction module
exports one named, closed record:

```ts
import { defineInteraction } from "@foxworth/boundary";

export const interactions = {
  create: defineInteraction({ /* portable declaration */ }),
  list: defineInteraction({ /* portable declaration */ }),
} as const;
```

The suffix and export name improve locality for authors and tools. They do not
create interaction identity, select authority, imply deployment, or enter any
digest. The interaction IDs inside the definitions remain authoritative.

`loadInteractionsEntry({ entry, loadModule? })` receives one explicit path or file
URL. It evaluates that module through native ESM by default or through the
injected loader adapter, then snapshots the named `interactions` export. It:

- ignores adjacent exports;
- rejects a missing export, factory, Promise or other thenable, mutable
  registry, invalid record key, or forged definition;
- performs no directory scan, glob, configuration discovery, route discovery,
  or implicit aggregation.

Applications with several declaration modules compose an explicit root record
with ordinary imports. The loader does not invent merge ordering or collision
semantics.

Module evaluation is arbitrary user code. It may read environment state,
perform I/O, or otherwise be non-hermetic before the loader receives the
export. “Reads only `interactions`” describes which export the loader consumes;
it does not claim that other top-level module code did not execute. An injected
loader is an Adapter at that evaluation seam and carries the same limitation.

## Deterministic compilation boundary

After loading, the build path calls the ordinary library compiler:

```ts
const loaded = await loadInteractionsEntry({ entry });
const compiled = await compileInteractions(loaded.interactions);
```

`compileInteractions` snapshots, validates, canonicalizes, and hashes the inert
declarations. Given the same validated declaration snapshot and compiler
version, it produces the same Program and handle identities. That claim does
not extend backward across module evaluation or a host-supplied
`InteractionLowering`.

## Pure artifact rendering

`renderHostArtifacts` accepts already-created values and returns one immutable
`HostArtifactSet` containing normalized relative paths, exact UTF-8 bytes, and a
versioned inventory. It performs no filesystem work.

```ts
const artifacts = renderHostArtifacts({
  program: { name: "todos", value: compiled.program },
  projections: {
    agent: { name: "agent", value: agentProjection },
  },
  references: {
    agent: {
      name: "clients/agent",
      value: {
        binding: agentBinding,
        source: {
          compiled,
          module: "./todos.boundary.js",
          export: "interactions",
        },
        exportName: "agentReferences",
        members: {
          list: { definition: "list" },
          create: {
            definition: "create",
            requestOutput: {
              module: "./proposal-types.js",
              export: "CreateProposal",
            },
          },
        },
      },
    },
  },
});
```

The portable outputs are:

- one explicitly named `*.program.json` for each supplied Program;
- one explicitly named `*.projection.json` for each supplied Projection;
- optional `*.references.ts` modules from a Projection or successful Binding, only when the
  caller supplies explicit definition-record, member, generated-export, and
  request-output type metadata for a real package, process, build, or language
  seam.

Program and Projection artifacts contain no handlers, implementations,
availability invented by the build tool, policy, context, credentials, or
authority. Projection artifacts preserve durable caller-facing aliases because
those aliases name the selected interface and enter Projection identity.
Definition-record aliases, presentation names, and output filenames stay
outside identity.

Typed references are opt-in. Same-package callers use `compiled.handles` or
`projection.handles` directly. Generated references are frozen structural data:
interaction ID, expected contract digest, arity, and selected modes. Their imports
are type-only, so they do not depend on the JavaScript module instance that
created the surface. Supply exactly one of `projection` or `binding`.
Projection-based request references return `JsonValue` and reject a
`requestOutput` override because the proposal schema is not yet realized.
Binding-based request references require an explicit full public request-output type. The renderer never reverse-engineers TypeScript module
names, source bindings, request types, or phantom types from runtime values.

The renderer authenticates `source.compiled` and proves that every
`members[alias].definition` names the exact interaction ID, contract digest, and
arity selected by the Projection or Binding. The `source.module` and `source.export` strings
remain trusted type-only build metadata: Boundary cannot prove that a future module
at that specifier still exports the same definition record, nor can runtime
validation prove that TypeScript annotations inside that module honestly
describe their schemas. Keep source definitions and generated references under
ordinary source review; `pinProjectionReferences` rejects runtime identity
drift from the live Binding, but it cannot authenticate erased TypeScript types.

An `InstallationManifest` may be rendered only from an actual live
`InteractionInstallation`. A `ProjectionBindingManifest` may be rendered
only from an actual successful Binding. The build module does not synthesize
either from a Program, Catalog, Projection, filename, or deployment config.

## Explicit filesystem writer

`writeHostArtifacts(artifacts, { destination })` is the only filesystem effect.
The destination is required. There is no current-working-directory default,
config-file lookup, or implicit write during loading, compilation, Projection,
Installation, or Binding construction.

The writer may create or replace only:

- files named by the supplied immutable artifact set; and
- stale files named by the previous valid inventory owned by that same
  destination.

It must not delete an unmanaged file, infer ownership from an extension, or
clean a parent directory. It rejects a symbolic-link destination and symbolic
links in managed path components, including before inventory-owned stale
deletion. Stale deletion is therefore inventory-only and destination-confined.

`checkHostArtifacts(artifacts, { destination })` performs the same exact-byte
comparison without writing. It reports missing, changed, and previously
inventoried stale outputs. A successful check establishes agreement with the
evaluated declaration snapshot; it does not establish hermetic source
evaluation or behavioral correctness.

## Artifact commitment policy

Definitions remain authoring truth. Generated files are derived artifacts.
Commit a Program, Projection, or typed-reference file only when another package,
process, language, deployment review, or drift gate consumes it. Generated
output must never overwrite reviewed conformance vectors.

The build entry exposes library functions, not a generic CLI. A framework or
application may place a thin command around them while keeping entry,
destination, Projection selection, and write/check policy explicit.

For offline generation, replace `binding: agentBinding` in the example with
`projection: agentProjection` and omit every `requestOutput` member. No
implementation, Installation, admission policy, or credentials are required.
After deployment, call `pinProjectionReferences(client, references)` to verify
the structural references against the live handshake before invocation.
