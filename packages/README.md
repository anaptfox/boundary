# Boundary SDK

`@foxworth/boundary` is one package with explicit subpath interfaces. The root
exports native host authoring. Core, discovery, guests, callers, and adapters
are source modules; they are not independently published packages. Optional
runtimes are peer dependencies loaded only by the selected subpath.

```text
packages/
  core/        program, host, drafts, artifact, handoff, remote, control
  discovery/   reach, bus
  guests/      plugin
  callers/     client, inspector, react, mcp, webmcp
  adapters/    http, frameworks, cloudflare, electron, yjs, automerge
```

Use `defineInteraction` from `@foxworth/boundary` for a declaration, then
`install` the handlers and `connect` a `surface` for each caller. The explicit
pipeline behind those calls is `@foxworth/boundary/pipeline`. The host retains
its domain identifiers and execution rules. `@foxworth/boundary/reach` locates a Binding;
`/bus` registers local Reach records; `/plugin` admits guest realizations
against the imports the host provides.

The browser [interaction inspector](../docs/guides/interaction-inspector.md) displays a selected Binding and invokes through a host-owned transport.

Install the SDK once. The Host root requires Zod; the portable `/program`
subpath does not. React, MCP, framework, Electron, Yjs, Automerge, and plugin
runtimes are optional peers required only by their owning subpaths. Yjs and
Automerge subpaths (`/yjs` and `/automerge`) are
**experimental** and capture local document versions
for isolated JSON reads; they do not provide a network provider or persistence layer.
Their APIs may change incompatibly; see the
[experimental integration status](../docs/concepts/current-status.md#experimental-integrations).

Each module is one folder of source files; there is no per-module `src/`.
`/host/control` is Host's request-contribution seam and lives in `core/host`.
`/control/host` is Control's contribution that plugs into it and lives in
`core/control`. Cross-module imports go through the owner's public subpath,
never into another module's files.

Subpaths whose built module graph imports a `node:` builtin publish only a
`node` condition, so a browser or worker bundle fails at resolution.

`package.json` is the only manifest: its `exports` point at source for the
workspace, and tsdown keeps `publishConfig.exports` pointing at `dist/`, which
`pnpm pack` applies. The build runs publint and arethetypeswrong and fails on
any finding. Applications and executable proofs remain under `examples/`
and `tests/`; Rust remains an independent native implementation under `crates/`.

## Subpath ownership

Generated from the `exports` map by `node scripts/check/docs.mjs --write`; the
docs check fails when it drifts.

<!-- subpaths:start -->
| Import | Owner | Source |
| --- | --- | --- |
| `@foxworth/boundary` | `core/host` | `core/host/index.ts` |
| `@foxworth/boundary/artifact` | `core/artifact` | `core/artifact/index.ts` |
| `@foxworth/boundary/automerge` | `adapters/automerge` | `adapters/automerge/index.ts` |
| `@foxworth/boundary/build` | `core/host` | `core/host/build/index.ts` |
| `@foxworth/boundary/bus` | `discovery/bus` | `discovery/bus/index.ts` |
| `@foxworth/boundary/client` | `callers/client` | `callers/client/index.ts` |
| `@foxworth/boundary/client/cache` | `callers/client` | `callers/client/cache.ts` |
| `@foxworth/boundary/client/observations` | `callers/client` | `callers/client/observations.ts` |
| `@foxworth/boundary/cloudflare` | `adapters/cloudflare` | `adapters/cloudflare/index.ts` |
| `@foxworth/boundary/control` | `core/control` | `core/control/index.ts` |
| `@foxworth/boundary/control/host` | `core/control` | `core/control/host.ts` |
| `@foxworth/boundary/control/testing` | `core/control` | `core/control/testing.ts` |
| `@foxworth/boundary/drafts` | `core/drafts` | `core/drafts/index.ts` |
| `@foxworth/boundary/electron` | `adapters/electron` | `adapters/electron/index.ts` |
| `@foxworth/boundary/electron/ipc` | `adapters/electron` | `adapters/electron/ipc.ts` |
| `@foxworth/boundary/frameworks/hono` | `adapters/frameworks` | `adapters/frameworks/hono.ts` |
| `@foxworth/boundary/frameworks/next` | `adapters/frameworks` | `adapters/frameworks/next.ts` |
| `@foxworth/boundary/frameworks/trpc` | `adapters/frameworks` | `adapters/frameworks/trpc.ts` |
| `@foxworth/boundary/frameworks/vite` | `adapters/frameworks` | `adapters/frameworks/vite.ts` |
| `@foxworth/boundary/handoff` | `core/handoff` | `core/handoff/index.ts` |
| `@foxworth/boundary/host/control` | `core/host` | `core/host/control.ts` |
| `@foxworth/boundary/http` | `adapters/http` | `adapters/http/index.ts` |
| `@foxworth/boundary/http/compose` | `adapters/http` | `adapters/http/compose.ts` |
| `@foxworth/boundary/http/node` | `adapters/http` | `adapters/http/node.ts` |
| `@foxworth/boundary/http/observations` | `adapters/http` | `adapters/http/observations.ts` |
| `@foxworth/boundary/http/openapi` | `adapters/http` | `adapters/http/openapi.ts` |
| `@foxworth/boundary/http/protocol` | `adapters/http` | `adapters/http/protocol.ts` |
| `@foxworth/boundary/inspector` | `callers/inspector` | `callers/inspector/index.ts` |
| `@foxworth/boundary/mcp` | `callers/mcp` | `callers/mcp/index.ts` |
| `@foxworth/boundary/observations` | `core/host` | `core/host/observations/index.ts` |
| `@foxworth/boundary/pipeline` | `core/host` | `core/host/pipeline.ts` |
| `@foxworth/boundary/plugin` | `guests/plugin` | `guests/plugin/index.ts` |
| `@foxworth/boundary/program` | `core/program` | `core/program/index.ts` |
| `@foxworth/boundary/program/zod` | `core/program` | `core/program/zod.ts` |
| `@foxworth/boundary/reach` | `discovery/reach` | `discovery/reach/index.ts` |
| `@foxworth/boundary/react` | `callers/react` | `callers/react/index.ts` |
| `@foxworth/boundary/remote` | `core/remote` | `core/remote/index.ts` |
| `@foxworth/boundary/webmcp` | `callers/webmcp` | `callers/webmcp/index.ts` |
| `@foxworth/boundary/yjs` | `adapters/yjs` | `adapters/yjs/index.ts` |
| `@foxworth/boundary/react/styles.css` | `callers/react` | `callers/react/styles.css` |
<!-- subpaths:end -->
