---
title: "Compose native modules"
description: "Assemble modules with shared local names into one installation and bind selected callers with input-sensitive host policy."
---

# Compose native modules

A task module and a capacity module can each call their interactions `mutate`
and `query`. The application gives those declarations distinct aliases in its
shared installation, then binds a task editor, a task reader and a capacity
reader to selected interfaces. Each caller retains the module's input and
output types, and current host policy checks the requested project.

This recipe uses existing Boundary functions. The executable
[module composition example](../../examples/snippets/typescript/module-composition.ts)
owns its in-memory state, handlers and policy. Boundary checks declarations,
contracts, selections, binding identity and invocation outcomes. Module
composition does not make several changes one atomic transaction; the host
still owns workflow planning, transactions, receipts and recovery.

## Keep local names and choose assembly aliases

The modules declare different interaction IDs even though their local alias
names match. Their declarations contain schemas and read/change footprints;
implementation functions are supplied separately. The complete example defines
strict object schemas for task/project IDs, completion state and capacity.

<!-- snippet:examples/snippets/typescript/module-composition.ts#modules -->
```ts
// Module-local aliases may repeat; the host-owned interaction IDs do not.
export const taskModule = {
  mutate: defineInteraction({
    id: "tasks.mutate",
    input: TaskInput,
    output: Task,
    errors: { missing: TaskQuery },
    reads: ["tasks"],
    changes: ["tasks"],
  }),
  query: defineInteraction({
    id: "tasks.query",
    input: TaskQuery,
    output: Task,
    errors: { missing: TaskQuery },
    reads: ["tasks"],
  }),
} as const;

export const capacityModule = {
  mutate: defineInteraction({
    id: "capacity.mutate",
    input: CapacityInput,
    output: CapacityInput,
    reads: ["capacity"],
    changes: ["capacity"],
  }),
  query: defineInteraction({
    id: "capacity.query",
    input: CapacityQuery,
    output: CapacityInput,
    reads: ["capacity"],
  }),
} as const;
```

Compiling both local records and passing them directly to
`composeCompiledInteractions` would collide on `mutate` and `query`. Choose
explicit host aliases before composing the records:

<!-- snippet:examples/snippets/typescript/module-composition.ts#assembly -->
```ts
const tasks = compileInteractions({
  taskMutate: taskModule.mutate,
  taskQuery: taskModule.query,
});
const capacity = compileInteractions({
  capacityMutate: capacityModule.mutate,
  capacityQuery: capacityModule.query,
});
const compiled = composeCompiledInteractions(tasks, capacity);
```

The aliases make the assembly readable while preserving each declared
interaction ID and contract. `composeCompiledInteractions` rejects duplicate
aliases and duplicate interaction IDs. It does not infer a namespace, check
application module dependencies, or assign write ownership.

An alias change is observable through the compiled handle record and any
projection that uses that alias. Preserve exposed aliases unless a deliberate
interface change calls for new ones. Handler changes alone leave portable
declaration identity intact; the host chooses realization versions separately.

## Install ordinary application functions

Use `implementInteractions` when a native handler returns an ordinary value or
throws an authentic declared interaction error. Installation accepts those
implementations directly:

<!-- snippet:examples/snippets/typescript/module-composition.ts#ordinary-installation -->
```ts
const implementations = implementInteractions<typeof hostDefinitions, Context>(
  hostDefinitions, targets,
);
return installInteractions<typeof hostDefinitions, Context>(compiled, {
  ...identity, implementations,
});
```

The implementations receive the declaration's typed input and the invocation's
context. The shared installation realizes both modules. Boundary validates the
returned value before exposing it to the caller. Missing/extra implementation
members reject during setup.

## Choose native dispatch for explicit outcome evidence

Use `bindNativeInteractions` when the host owns another dispatcher or needs to
report an explicit native outcome. The target stays private to the host, and
the dispatcher receives a request-owned outcome factory:

<!-- snippet:examples/snippets/typescript/module-composition.ts#native-installation -->
```ts
const bindings = bindNativeInteractions<typeof hostDefinitions, typeof targets, Context>(
  compiled, targets, {
    taskMutate: async ({ target, input, context, outcomes }) =>
      outcomes.returned(await target(input, context)),
    taskQuery: ({ target, input, context, outcomes }) =>
      outcomes.returned(target(input, context)),
    capacityMutate: ({ target, input, context, outcomes }) =>
      outcomes.returned(target(input, context)),
    capacityQuery: ({ target, input, context, outcomes }) =>
      outcomes.returned(target(input, context)),
  },
);
return installInteractions<typeof hostDefinitions, Context>(compiled, {
  ...identity, bindings,
});
```

The example wraps ordinary returned values to compare the two installation
paths. A real native dispatcher can instead return `denied`, `notStarted`,
`notCompleted` or `unknown` when its evidence supports that result. Its outcome
token belongs to that invocation; an ordinary outcome-shaped object or a token
from an earlier dispatch cannot assert certainty.

| Handler behavior | Ordinary installation and native returned wrapper |
| --- | --- |
| Valid value | Completed returned value. |
| Authentic declared error | Completed declared error, correlated with its declaration. |
| Invalid returned value | Unknown with `invalid-realization-outcome`. |
| Unexpected exception | Unknown with `realization-failed`; no automatic retry. |

The equivalence above covers a returned-only native wrapper. Explicit native
certainty outcomes have their own evidence and are not ordinary return values.
Request mode still requires an explicit request realization; this recipe uses
direct interactions.

## Bind selected local interfaces to the shared installation

Build each caller's projection from the relevant module's own compilation.
Local aliases remain convenient even though installation aliases differ:

<!-- snippet:examples/snippets/typescript/module-composition.ts#selected-projections -->
```ts
const localCompiled = {
  tasks: compileInteractions(taskModule),
  capacity: compileInteractions(capacityModule),
};
const taskEditor = projectAllDirect(localCompiled.tasks);
const taskReader = pickProjection(taskEditor, "query");
const capacityReader = pickProjection(
  projectAllDirect(localCompiled.capacity), "query",
);
```

`bindProjection` matches expected interactions to installed realizations by
identity and compatibility, then pins the actual realization. It does not
require matching alias names between the projection and installation. A task
reader selects only `query`; the installation's other interactions do not
widen that surface. A failed binding returns an exhaustive unrealized result
with no partial caller.

## Authorize exact input on every invocation

Selection makes an interaction available to a caller. Host admission decides
whether this particular invocation may execute. The example matches the
declared interaction and checks the validated project ID against the
authenticated context's allowed projects:

<!-- snippet:examples/snippets/typescript/module-composition.ts#admission -->
```ts
const admit: Admission<Context> = request => {
  // Binding validated input before admission. Match the installed ID and
  // both contract digests before restoring this host's correlated union.
  const known = Object.values(compiled.handles).some(handle =>
    handle.interactionId === request.handle.interactionId &&
    handle.contractDigest === request.handle.expectedContractDigest &&
    handle.contractDigest === request.handle.actualContractDigest,
  );
  if (!known) return { decision: "deny", reason: "unknown module contract" };
  const call = {
    interaction: request.handle.interactionId,
    input: request.input,
    context: request.context,
  } as InstalledCall;
  telemetry.admissions.push(request);
  if (!call.context.projects.includes(call.input.project)) {
    return { decision: "deny", reason: "project is outside the principal's scope" };
  }
  if ((call.interaction === "tasks.mutate" || call.interaction === "capacity.mutate") &&
      !call.context.mayMutate) {
    return { decision: "deny", reason: "principal may only query" };
  }
  return { decision: "allow" };
};
```

Boundary normalizes and validates input before calling admission. The
application's private type narrowing must match the selected declaration; a
route, alias or guessed identifier cannot authorize access. Unknown interaction
contracts deny.
The fixture's context objects stand in for authenticated sessions. A remote
host must authenticate its transport input before constructing them.

Admission receives the exact context object supplied to the caller. Denial
prevents dispatch, and malformed input stops before admission. Every call runs
current policy; possessing a selected handle is not a durable grant.

Applications with atomic workflows additionally own resource checks at their
transaction snapshot. A pure preview step has no mutation request ID or basis;
give its policy request a deliberate native shape rather than pretending it is
a full mutation invocation. Neither step metadata nor preview grants permission
to persist or run an external effect.

## Use the typed callers

<!-- snippet:examples/snippets/typescript/module-composition.ts#invocation -->
```ts
const context: Context = { principal: "fox", projects: ["public"], mayMutate: true };
const before = await host.callers.taskReader.call(
  host.projections.taskReader.handles.query, { project: "public", task: "todo-1" }, context,
);
const completed = await host.callers.taskEditor.call(
  host.projections.taskEditor.handles.mutate,
  { project: "public", task: "todo-1", completed: true }, context,
);
const after = await host.callers.taskReader.call(
  host.projections.taskReader.handles.query, { project: "public", task: "todo-1" }, context,
);
const capacity = await host.callers.capacityReader.call(
  host.projections.capacityReader.handles.query, { project: "public" }, context,
);
```

Input and output types flow from the module's declaration through its local
projection. Type tests reject a capacity input passed to a task handle,
excluded mutation handles on a reader, wrong output fields and unknown assembly
aliases. Runtime tests also refuse excluded and foreign selected handles.

`createHost` remains useful for a fixed direct-call surface whose
admission only needs context. This recipe keeps the explicit lifecycle because
it binds module-local surfaces to a shared installation and inspects input in
admission. Application scheduling, dependency rules and storage stay local.

## Run the checked recipe

```sh
pnpm exec vitest run --config config/vitest.config.ts tests/typescript/module-composition.test.ts
just check
node tests/process/module-composition.mjs
```

`just check` compiles the public examples and type assertions, runs in-process
tests and builds the package. The last command uses that built package to
create an isolated packed consumer, compiles the same example against installed
declarations and runs it on both installation paths. `just pack-smoke` also
includes this fixture in the existing packed consumer.

The focused proofs cover repeated local aliases, exact selected contracts,
input-sensitive denial, dispatch counts and ordinary/native outcome
equivalence. The packed proof separately verifies archive/content identity
and package resolution. These checks do not establish application transactions,
durable receipts, cross-process fencing, browser behavior or physical-device
acceptance. The TypeScript recipe adds no portable law or new runtime API;
native Rust remains an independent implementation.
