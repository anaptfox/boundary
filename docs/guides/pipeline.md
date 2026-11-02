---
title: "The explicit pipeline"
description: "Compile, implement, install, project, and bind as separate steps when the short path does not take the step you need."
---

# The explicit pipeline

`surface`, `install`, and `connect` compose five functions and return their
artifacts. `@foxworth/boundary/pipeline` exports those functions so a host can
take one step on its own. Reach for it when you need something the short path
deliberately does not do:

| Need | Pipeline step |
| --- | --- |
| A selection you persist, inspect, or ship as a generated reference before any implementation exists | `projectInteractions` or `projectSurface`, then `@foxworth/boundary/build` |
| Realization ids that are not `<interactionId>:<mode>:<version>` | `installInteractions({ realizationIds })` |
| A narrower caller derived from a live Binding, keeping its admission and revocation lineage | `restrictBinding` |
| Your framework's own dispatcher and targets, with native outcome evidence | `bindNativeInteractions` |
| Composition of several modules' compilations into one Program | `composeCompiledInteractions`, `diffCompiledInteractions` |
| A candidate deployment assessed without binding | `assessSurface` |
| The agent-facing presentation of a selection, with its own digest | `presentSurface` |

Everything else is the same model. The pipeline returns the same
`CompiledInteractions`, `InteractionInstallation`, `CompiledSurface`, and
`Binding` values the short path exposes as `app.compiled`, `app.installation`,
and `app.binding(caller)`.

## The steps

```ts
import { defineInteraction, surface, admitWhen } from "@foxworth/boundary";
import {
  bindSurface, compileInteractions, createCaller, implementInteractions,
  installInteractions, projectSurface, realizationIdsFor,
} from "@foxworth/boundary/pipeline";

const compiled = await compileInteractions(docs);                         // Program + inert handles
const implementations = implementInteractions<typeof docs, Actor>(docs, handlers);
const { installation, controller } = await installInteractions(compiled, {
  installationId: "docs:local:1",
  implementations,
  realizationIds: realizationIdsFor(compiled, "documents@1"),
});
const selection = await projectSurface(compiled, surface(docs, { call: ["search"] }));
const bound = await bindSurface(selection, installation, {
  admit: admitWhen((actor: Actor) => actor.kind === "assistant"),
});
if (bound.status !== "bound") throw new Error("unrealized", { cause: bound.report });
const assistant = createCaller(bound.binding);                           // the same caller shape connect() returns
```

- `compileInteractions(record)` derives one Program and one typed handle per
  alias. Handles are inert: they name a contract, they do not call it.
- `implementInteractions(record, functions)` pairs every alias with exactly one
  function. Missing or extra entries fail at construction.
- `installInteractions(compiled, { installationId, implementations | bindings, realizationIds, requests? })`
  makes those functions live under host-issued identities. The separately
  returned `controller` revokes the Installation.
- `projectInteractions(compiled, { alias: { interaction, modes } })` selects
  handles and modes by hand; `projectSurface(compiled, surface)` does the same
  from a Surface. Either yields a `CompiledSurface` whose `manifest` and
  `projectionDigest` are portable artifacts.
- `bindSurface(selection, installation, { admit, observation?, coordinate? })`
  checks every selected interaction against the Installation's actual
  contracts and modes. It returns `bound` with a `Binding` and a host-held
  `BindingController`, or `unrealized` with an exhaustive report.
- `createCaller(binding)` builds the caller adapters take. `binding.connect()`
  is the lower-level handle-based caller: `call(handle, input, actor)` and
  `request(handle, input, actor)`.

Identity does not move between the paths: a Surface compiled here and a Surface
connected through `install` produce the same `projectionDigest`, and the
Binding manifests are equal for the same inputs. The short path's tests assert
exactly that.

## Restriction

```ts
const reads = await projectSurface(compiled, surface(docs, { call: ["search"] }));
const child = await restrictBinding(bound.binding, { projection: reads, admit: admitWhen(...) });
```

A restricted Binding keeps the parent's admission, observer, exact realization
pins, and revocation lineage. It can select fewer interactions or modes and
rename aliases; it cannot add anything the parent did not carry.

## Where the pipeline is taught

- [Host reference](../reference/host.md): every function and type.
- [Compose native modules](./module-composition.md): several compilations, one
  installation, module-local selections.
- [Native dispatch](./native-dispatch.md): a framework's own dispatcher behind
  `bindNativeInteractions`, with coordination and outcome evidence.
- [Testing the seams](./testing.md): what each step proves.
