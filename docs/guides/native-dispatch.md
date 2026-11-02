---
title: "Native dispatch"
description: "Select, inspect and coordinate native interactions while preserving host ownership and exact identities."
---

# Native dispatch

Use these surfaces when a library already owns its dispatcher, request journal
and policy. They remove repeated SDK wiring while leaving those decisions in
the application. The packed qualification fixture exercises a host change,
lost acknowledgement, process restart and retained outcome through both native
callers and the HTTP Handoff adapter.

For several modules that share local names such as `mutate` and `query`, follow
[Compose native modules](./module-composition.md). It shows explicit
assembly aliases, one installation, selected module-local interfaces and
input-sensitive admission. Ordinary functions can use `implementInteractions`
directly; native dispatch is useful when it supplies explicit outcomes.

## Select aliases and bind a native dispatcher

Select a mode per alias with a shorthand string:

```ts
const projection = await projectInteractions(compiled, {
  inspect: "direct",
  export: "request",
});
```

The explicit form names the handle and its modes:

```ts
const projection = await projectInteractions(compiled, {
  inspect: { interaction: compiled.handles.inspect, modes: ["direct"] },
  export: { interaction: compiled.handles.export, modes: ["request"] },
});
```

Both forms have the same identity. Omitted aliases stay omitted. Unknown
shorthand aliases reject; use the explicit form for renamed aliases and
multiple modes. The resulting handles retain their input, output, arity and
selected mode types.

`bindNativeInteractions(compiled, targets, dispatchers)` accepts two closed
records with exactly the compiled aliases. Each dispatcher receives its own
typed input, native target, context and request-owned outcome factory:

```ts
type Context = Readonly<{ principal: string }>;
const bindings = bindNativeInteractions<
  typeof definitions, typeof targets, Context
>(compiled, targets, {
  async inspect({ input, target, context, outcomes }) {
    return outcomes.returned(await target.inspect(input, context));
  },
  export({ input, target, context, outcomes }) {
    return target.dispatch(input, context, outcomes);
  },
});
```

These bindings provide direct realizations. Pass them to `installInteractions`
with explicit realization IDs. The request-only `export` selection above also
requires an explicit Control request contribution.
Native outcome tokens belong to the exact dispatch that created them;
foreign tokens and ordinary outcome-shaped values cannot claim execution
certainty.

## Inspect the selected contracts

`describeBinding(binding)` requires an authentic native Binding and returns an
immutable array of its selected mode entries. Each entry has alias, arity,
expected and actual descriptors, contract digests, realization identity, and
request preview/control pins when selected. Restricted bindings expose only
their selected entries. The shared Program `bindingDescriptions(manifest)`
joins already checked declaration data without authenticating its source;
Handoff adapter resolution uses that same join.

An integration that describes tools adds application names and trusted
participant context to this checked description instead of reconstructing the
join. Descriptions contain no dispatcher, target, admission function or revoke
capability. They describe selected declarations and pins; they do not promise
live permission or availability.

## Coordinate all invocation routes

Decorating `binding.invoke` does not intercept typed callers. Instead,
`bindProjection` accepts an optional native `coordinate(invocation, proceed)`
function. Typed direct/request calls, raw calls, Binding invocation and checked
Handoff execution all enter it. `restrictBinding` inherits the required
coordinator and cannot replace or bypass it.

The invocation order is:

1. Verify the selected interaction identity and mode, and check revocation.
2. Normalize and validate input against both pinned contracts.
3. Evaluate inherited admission oldest-parent-first and recheck revocation.
4. Enter host coordination with frozen input and pins, plus the exact context.
5. `proceed()` rechecks revocation and dispatches at most once with those facts.
6. Validate the returned or retained outcome; attempt publication once through
   the configured observer, when present.

The host may use its journal to return an authorized retained outcome. It must
bind that record to the exact request input and domain identity; Boundary checks
the returned pins, result schema and certainty, rather than owning storage or
deduplication. Admission runs before retained disclosure on every invocation.
No input or context argument can be substituted through the zero-argument
continuation. Repeated calls to it share one execution. A synchronous return
expires it before yielding; an asynchronous hook retains it until Boundary
receives its result. Revocation while waiting prevents dispatch and retained
disclosure if the current invocation has not entered its continuation.

Coordinator errors, mismatched retained pins and invalid retained results yield
`unknown`. Request coordination failures also remain `unknown` through Handoff.
An ordinary request-realization failure before effects remains `not-started`.
Neither `unknown` nor a retained outcome causes an automatic retry.
Cancellation, queueing, fencing, durable publication and recovery remain host
policy.

Native Rust exposes `coordinate_binding(bound, coordinator)` with an
ownership-consuming one-shot continuation. Attachment refuses replacement of an
existing required coordinator. Ordinary native typed calls keep their
codec-free path; opting into coordination deliberately uses the portable codecs
for checked retained outcomes. `describe_binding` borrows immutable selected
descriptors. Independent native tests consume the reviewed
[coordination laws](../../tests/conformance/v1/invocation-coordination.json).

## Schemas, artifacts and evidence

| Integration need | Supported path |
| --- | --- |
| Accept nullable Zod schemas without a normalization shim. | Built-in Zod compilation lowers generated type arrays to `anyOf`, retaining sibling constraints and annotation paths. Changing a schema still changes exact contract content and digests. |
| Verify package receipts, hashes, exports and runtime requirements. | [Node artifact tooling](../reference/artifact.md) verifies supplied bytes and reports content, receipt, export, runtime and supplied declaration changes. |
| Distinguish invocation completion from child-work state. | [Causal execution evidence](../reference/execution-evidence.md) carries invocation completion and uncertain subject state, with host-chosen links. |

Run `just gate` for the packed consumer proofs. The Boundary integration proof uses
four real Node processes and host-owned local records; its HTTP adapter handles
standard Request/Response objects. The separate causal-evidence proof uses real
localhost sockets. These bounded fixtures do not establish production journal
transactions, distributed fencing or physical runtime acceptance. `just e2e`
adds the repository's installed-runtime matrix.
