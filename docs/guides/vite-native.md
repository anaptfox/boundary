---
title: "Vite native lifecycle"
description: "Replace a Vite host during development and clean it up when the server stops."
---

# Vite native lifecycle

`@foxworth/boundary/frameworks/vite` provides two Vite integrations:

- `mountSurface({ handler, mount })` mounts an already-prepared HTTP
  surface at explicit Connect paths.
- `mountSurfaceLifecycle({ entry, validate, mount })` adds explicit
  development/preview entry replacement and cleanup around that same HTTP
  seam.

The lifecycle integration is deliberately host-owned. The application chooses
the entry module, prepares its Boundary binding and native resources, assigns a
generation identity, and releases those resources. Vite does not discover
routes, import configuration files, create an installation, or decide policy.
The tested executable harness is
[`tests/fixtures/runtimes/vite/run.mjs`](../../tests/fixtures/runtimes/vite/run.mjs), and its
focused lifecycle cases are in
[`vite.native-lifecycle.test.ts`](../../tests/typescript/vite.native-lifecycle.test.ts).
The harness uses a real bound `vite.todos.list`/`vite.todos.create` surface
over a JSON-backed application store. It proves that a created todo remains
visible after implementation replacement, an unrelated frontend edit does not
replace the useful generation, a rejected candidate leaves the prior bound
handler serving, and the same host entry starts in Vite preview. This is a
local native lifecycle proof, not persistence or deployment infrastructure.

Replacement is serialized. A candidate is prepared and validated before the
current generation is changed. If preparation or validation fails, the
candidate is disposed and the previous valid generation remains mounted. A
retired generation is disposed after its in-flight requests finish, so a
replacement cannot leak or interrupt an outstanding call.

Responses include `X-Boundary-Vite-Generation`. A client may send that value back in
the same header. If it names a retired generation, the adapter returns `409`
with `STALE_CLIENT` and the current generation. This is an explicit
reconnection signal; the adapter never rebinds an outstanding invocation or
retries an effect after hot replacement.

Startup and preview use the `entry` supplied by the application. Hot updates
call the same replacement path. Closing the Vite bundle disposes the current
generation once. Diagnostics are available through `onDiagnostic` and
`lifecycle.diagnostic()` when using `createSurfaceViteLifecycle` directly;
they distinguish rejected candidates, stale clients, unavailable startup, and
cleanup failures.

This integration targets the repository's supported Vite version (`8.3.0`). It
uses Vite's `configureServer`, `configurePreviewServer`, `handleHotUpdate`,
and `closeBundle` hooks. It does not depend on Vite's experimental Environment
API. For Workers-backed Vite applications, keep the Cloudflare workerd-backed
plugin as the runtime owner and use this adapter only for the explicit Boundary
surface mount.

Current support and remaining acceptance work are tracked on the
[availability page](../concepts/current-status.md); this guide describes the
interface, not a broader readiness claim.
