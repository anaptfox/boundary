---
title: "Inspect a Binding in a browser"
description: "Mount a framework-independent inspector that shows a selected Binding and invokes one mode on explicit submit."
---

# Inspect a Binding in a browser

The optional `@foxworth/boundary/inspector` entry mounts a framework-independent
interaction inspector in a host-owned element. It shows the selected Binding's
contract and identity pins, accepts JSON input and invokes one selected mode only
when the user submits. A selection is a declaration, not permission or a promise
that an interaction is legal next; the host still decides admission per attempt.

```ts
import { createBindingInspectorTransport, mountInspector } from "@foxworth/boundary/inspector";

// `binding` is the host's selected, live Binding. Context is supplied per attempt.
const transport = await createBindingInspectorTransport(binding, () => makeContext());
const inspector = mountInspector(element, { transport, colorScheme: "dark" });
// On host disconnect or component unmount:
inspector.dispose();
```

For a separate process, supply `InspectorTransport`: `manifest()` returns the
selected Binding manifest, and `invoke(invocation)` makes exactly one Handoff
attempt and returns its outcome. The host chooses transport, authentication,
context, UI placement and lifecycle. Keep credentials in the host transport,
not in the manifest, input, displayed result or browser storage. Never expose a
Binding more broadly than the host intends. Use `setTransport(null)` on
connection loss, `setTransport(next)` on replacement, and `refresh()` to reload
its selected manifest. Dispose on unmount. Refresh cannot itself prove a Binding
is live: admission and revocation are checked by the host when invoked.

The inspector validates manifest identity, input against both pinned contracts,
and the returned Handoff response against the sent invocation. Invalid JSON or
schema input is rejected before invoking the transport. Request mode produces a
proposal and is distinct from direct execution. A lost or invalid response after
an attempt is shown as unknown; it is not retried. The host must reconcile the
actual effect before deciding what to do next. Changing selection or transport keeps a visible, attempt-specific pending record.
A late checked result updates that record without overwriting the current view;
a failed or invalid response remains unknown. The inspector keeps up to 20
in-memory records; remove a settled record to make room. Removing a record does
not reconcile an unknown outcome. Disposal removes these records and cannot
cancel an already started effect, so the host must manage reconciliation across
the inspector lifetime. Choose `colorScheme: "light"`, `"dark"`, or omit it to use the browser default.
Attempt summaries remain visible; expand them to inspect the full identity and
outcome. The UI does not persist input or results. Its open shadow root scopes styles and
provides stable `data-testid` hooks for host tests.
