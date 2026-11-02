---
title: "Plugin reference"
description: "WIT projection, plugin inspection, and loading a component realization."
---

# Plugin reference

Boundary plugins are one realization of a host's declared interactions. A plugin is
usually a WebAssembly component; the component is the artifact format and a
guest is the runtime instance created from it. Neither one becomes the source
of interaction meaning or authority.

`@foxworth/boundary/plugin` is a subpath in the public SDK candidate. The
independent `boundary-plugin` Rust crate remains workspace-private. The examples below describe the checked-in APIs;
they are not a publication or support promise.

```text
Program and contracts (host meaning)
              │ projectWit
              ▼
       boundary:guest WIT world
              │ inspectPlugin
              ▼
component imports ── subset of host imports? ── loadPlugin ── runtime calls
```

The host chooses the WIT package and version, maps host functions to an
`HostImports`, and decides whether the component is admitted. The actual
component imports are inspected; a claimed target world is not enough. An
unmapped import returns `refused` before plugin code runs. The check does not
prove that a mapped function honors its declared reads or changes. That remains
a host review and execution obligation.

Every provided import has one signature, `(request: string) -> result<string,
string>`. A component whose declared import differs in parameters or result is
refused before any guest code runs, including its core start function, with
`not-started` certainty and no host entry. Rust links typed functions, so Wasmtime
checks the signature before instantiation; Node checks the decoded component
before transpile. Both resolve the signature through whatever type aliases name
it, whether defined in place, aliased from an enclosing scope, or aliased from a
type exported by an instance, and admit the same components. Node refuses a
root import that is not a function or an instance of functions.

Plugins are synchronous. Component-model async (async function types, async or
callback canon options, streams, futures, tasks and waitables) is off in both
hosts, whatever the build graph enables: `guest_engine()` disables the Wasmtime
feature explicitly, so another crate unifying `component-model-async` into the
build cannot turn it on, and Node refuses such a component before transpile. A
component that uses it is refused with `not-started` certainty and no host
entry. A host that builds its own `Engine` owns that choice.

`boundary:guest` is deliberately retained as the WIT identity. A package/version
change is a different interface, even when the function names look the same.
WASI, clocks, files, and sockets are absent unless the host explicitly provides
them through the chosen profile.

## TypeScript

`@foxworth/boundary/plugin` exports the WIT projector, host imports, inspection, and
loader:

Assume `program` is the host's existing Program and `componentBytes` is the
component artifact supplied by its author.

```ts
import {
  HostImports,
  createPluginExecutor,
  inspectPlugin,
  loadPlugin,
  projectWit,
} from "@foxworth/boundary/plugin";
import { createHash } from "node:crypto";

const wit = projectWit(program);
const imports = new HostImports("boundary:guest/footprints@1.0.0")
  .provide("images");
// Hash the exact WIT source bytes persisted by the host.
const witDigest = `sha256:${createHash("sha256").update(wit.wit).digest("hex")}`;
const inspection = await inspectPlugin(componentBytes, imports, witDigest);
const executor = createPluginExecutor();

if (inspection.check.status === "refused") {
  throw new Error(`plugin asks for ${inspection.check.unmapped.join(", ")}`);
}

const loaded = await loadPlugin({
  bytes: componentBytes,
  imports,
  witDigest,
  host: {
    images: async (request, { signal }) => {
      if (signal.aborted) return { tag: "unknown", val: "aborted" };
      const { imageId } = JSON.parse(request) as { imageId: string };
      return imageId === "original"
        ? JSON.stringify({ width: 800, height: 600 })
        : JSON.stringify({ width: 50, height: 20 });
    },
  },
  executor,
});
if (loaded.status === "refused") {
  throw new Error(`unmapped imports: ${loaded.unmapped.join(", ")}`);
}
if (loaded.status === "fault") throw new Error(loaded.reason);
```

The exact `host` function type is `PluginHostFunction`: it returns a JSON
string, `{ tag: "ok" | "err", val }`, or `{ tag: "unknown", val }`. The last
answer traps the plugin so an effect with an uncertain outcome cannot be
flattened into a declared error and reported as success. `loaded.instance`
uses `GuestInstance`; call an exported interaction with its derived WIT name.
`loaded.inspection` is the inspection produced by that load, including its
realization and authority digests. Use its realization id when installing the
plugin behind a host Binding.

Node uses jco in workers to transpile and instantiate the component. This path
applies the same import-subset check and certainty vocabulary, but it does not
enforce Rust wasmtime fuel, memory, table, or instance limits. A host that needs
those runtime limits must run the component through the Rust implementation.
Close each instance and then its executor when revoking a binding. Host
callbacks receive an `AbortSignal`; abort is advisory because an effect may
already have started.

## Rust limits and lifetime

Rust creates every instance with `GuestLimits`. The defaults are host policy,
not a property that a component can request:

| Limit | Default |
| --- | ---: |
| Startup fuel | 100,000,000 |
| Per-call fuel | 1,000,000,000 |
| Per-memory cap | 64 MiB |
| Memories | 4 |
| Aggregate linear memory | 256 MiB |
| Tables | 8 |
| Instances | 16 |
| Table elements | 10,000 |

| Host-call copy budget | 128 MiB |

The aggregate ceiling sums linear memory across all memories and refuses
growth beyond 256 MiB. Wasmtime's limiter also enforces the configured counts
instead of its larger defaults.

### Host-call copy budget

`GuestLimits::hostcall_copy_bytes` (Node: `hostcallCopyBytes` on
`createPluginExecutor`) bounds how many bytes a guest can make the host copy
through imports. The law is the same in both hosts:

- Counted: the UTF-8 byte length of every request string the guest sends plus
  every reply string the host returns, `ok` or declared `err`, summed.
  `HostReply::Unknown` and a thrown host error carry no payload and add nothing.
- Per invocation: startup and each call get a separate, full budget, like fuel,
  so a persistent guest is not charged for earlier calls.
- Exceeded means the total would pass the limit; equal is allowed. A request
  that would pass it is refused before the host function runs. A reply that would
  pass it is withheld from the guest after the host ran. Both trap the guest and
  report `unknown` certainty, never a declared error and never `not-started`:
  the guest was already running, and a withheld reply follows a host effect that
  may have happened.
- Not counted: the guest's own input and output (Node's separate
  `maxPayloadBytes` still applies per message), retained host data, JSON
  expansion, or host callback time.

Under `per-call`, every call gets a fresh store and instance. Under
`persistent`, the store is reused until a trap and guest heap state can survive
between calls. Lifetime is part of the realization id:

| Lifetime | Store | Effect |
| --- | --- | --- |
| `per-call` | one per call | no guest state crosses calls |
| `persistent` | reused until a trap | guest state may cross calls |

A poisoned persistent store is rebuilt from the same component and import map;
the next call does not inherit its heap.

## Host replies and certainty

The WIT profile uses `result<string, string>`, leaving room for output and a
declared error. `HostReply::Unknown` and the TypeScript `{ tag: "unknown" }`
answer stop the call instead of crossing that wire:

| Host answer | Guest sees | Outcome |
| --- | --- | --- |
| `Returned` / `ok` | `ok(payload)` | guest result |
| `DeclaredError` / `err` | `err(payload)` | whatever the guest returns |
| `Unknown` | nothing; the guest traps | fault with `unknown` certainty |

An exhausted budget, trap, or malformed reply may have reached a host function,
so it remains `unknown` until the host reconciles it. `not-started` is reserved
for a pre-start configuration refusal, such as a queued timeout or capacity
limit. A failure during guest startup, after the signature check admitted the
component, is `unknown` because a provided import may already have run. This
holds for the first instantiation and for any rebuild.

## Supported evidence

| Host | Runtime | Evidence boundary |
| --- | --- | --- |
| Rust | wasmtime | component execution with fuel and memory limits |
| Node | jco workers | import check and execution; no Rust runtime limits |
| Browser, Workers, Electron renderer | jco path | packaging notes; execution not proved |

The component built from the checked-in Zig thumbnail implementation runs through the Rust host and is the
reference end-to-end workflow. The shared WIT and import laws are consumed from
reviewed conformance vectors. A digest establishes artifact identity; it does
not establish domain correctness or behavioral parity.

## Rust

The independent native crate is `boundary-plugin`. Its public component
surface is `PluginComponent`, `PluginError`, and `PluginLifetime`; runtime
support remains `GuestInstance`, `GuestOutcome`, `HostImports`, and
`HostReply`:

```rust
use boundary_plugin::{
    guest_engine, GuestInstance, GuestLimits, HostImports, HostReply,
    PluginComponent, PluginLifetime,
};

let engine = guest_engine()?;
let component = PluginComponent::load_with(
    &engine, &component_bytes, wit_digest, PluginLifetime::PerCall,
)?;
let imports = HostImports::new().provide("images", |_request| {
    // The host supplies dimensions; the plugin calculates the thumbnail.
    HostReply::Returned(r#"{"width":800,"height":600}"#.to_owned())
})?;
let instance = GuestInstance::instantiate(
    &engine, &component, &imports, "boundary:guest/footprints@1.0.0", GuestLimits::default(),
)?;
```

Rust instances receive host-declared fuel and aggregate memory limits. A trap,
budget exhaustion, or malformed reply is an infrastructure fault with
`unknown` certainty when the plugin may have reached a host function. A
pre-start refusal, including an import signature mismatch, is
`PluginError::Load` with `not-started` certainty; a guest that started and then
fails is `PluginError::Startup` with `unknown`. `PluginError::certainty()` reports
which. These outcomes are not ordinary
interaction errors and remain visible for host reconciliation.

## Identity and lifetime

`await inspectPlugin(...)` reports the component digest, authority digest, the actual
required imports, and a realization id. The realization id includes the
component, the caller-supplied WIT source digest, and lifetime (`per-call` by
default or `persistent`). The host imports are reported separately as authority:
changing what the host provides changes what the plugin can reach without
changing the component bytes.

TypeScript `inspectPlugin` and `readRequiredImports` return Promises and require
the existing `@bytecodealliance/jco` peer. Inspection captures the artifact bytes
and host imports before awaiting Jco's binary decoder, then checks a bounded
structural projection of its canonical WAT. It retains full interface versions
and every imported instance member, including resource/type names. The
projection resolves scoped type and instance aliases, static instance export
bags, component instantiation type substitutions, and export ascriptions.
Unresolved references or incompatible alias kinds reject inspection. Guest
internal imports do not become root host requirements, and inspection never
instantiates the guest. Full executable validation, resource identity, and
runtime subtyping remain separate Jco transpilation prerequisites during worker
preparation after admission.

Per-call instances start with a fresh runtime state. A persistent instance may
retain guest heap state between calls and therefore has a different realization
identity. A trap poisons a persistent Rust store; the next call rebuilds it and
checks imports again.
The compiled component and resolved import linkage are retained across Rust
store rebuilds; every per-call invocation still receives fresh guest state.

The Node executor defaults are four workers, 64 live artifact instances, 32
pending calls including active and queued work, 64 MiB source artifacts, 128
MiB prepared artifacts, 1 MiB payloads, a 128 MiB host-call copy budget per invocation, a 60 second
preparation deadline, and a 30 second call deadline. The prepared-artifact limit is checked after
transpilation both per artifact and in aggregate; it is not a strict transient
peak-memory bound. These controls bound queue and artifact work; they are not
total RSS bounds or WebAssembly fuel and linear-memory limits. Calls for one
artifact are serialized. A queued timeout is `not-started`; a dispatched
timeout is `unknown` and terminates the worker, invalidating bindings for that
artifact. Calls are not retried automatically.

The opt-in plugin benchmark is:

```console
pnpm exec vitest run --config config/vitest.perf.config.ts tests/typescript/perf/plugin.bench.ts
```

It records preparation, compilation, instantiation, invocation, and total
wall-time measurements, plus payload size, event-loop delay, and RSS deltas.
RSS is a sampled delta, not a peak-memory measurement.

Digests establish artifact and authority identity. They do not establish that a
plugin produces correct domain results or that two implementations behave the
same. The reviewed cross-language evidence remains the source of any parity
claim.

The WIT digest is supplied by the host. Inspection checks actual imports; it
does not attest that the component was built from that WIT source or validate
its exported interaction schemas. The host Binding validates interaction inputs
and outputs when the plugin is composed behind it.
