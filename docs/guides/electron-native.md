---
title: "Electron native integration"
description: "Serve a pinned Binding over trusted IPC from an existing Electron main process."
---

# Electron native integration

Use the Electron adapter from an existing main process. Boundary does not own the
window, preload, session, application lifecycle, or authorization policy.

The complete host-owned setup is in
[`tests/fixtures/runtimes/electron/trusted-ipc.ts`](../../tests/fixtures/runtimes/electron/trusted-ipc.ts),
with injected behavior covered by
[`tests/typescript/electron.native.test.ts`](../../tests/typescript/electron.native.test.ts).
That fixture binds `workspace.read` and `workspace.increment` once, derives the
workspace from the exact trusted WebContents/frame pair, and routes each
observation only to the matching workspace. The application must remove those
observation subscriptions and revoke its Binding on logout, navigation, or
window close; these are host lifecycle events, not facts inferred from IPC.

When the host uses `allowElectronSender`, the IPC listener checks the exact
`sender` WebContents object, exact `senderFrame` object, live main-frame
identity, non-destroyed state, and expected frame URL before it deserializes a
request, creates host context, or invokes the handler. A second window at the
same URL and a navigated/subframe sender are rejected. A custom
`validateSender` callback owns its own predicate and must provide equivalent
checks if it replaces the helper. Renderer headers and payload fields are not
identity and must not be used as authorization. `createContext` is host-owned
and is called once per accepted invocation; its result is passed as the
required context argument to the IPC handler, with sender validation repeated
after asynchronous context creation.

The preload should expose one selected method through `contextBridge`, not raw
`ipcRenderer`. The adapter's IPC door is text-only serialized Fetch: it does
not claim streaming, binary, or Electron-process parity. HTTP and the custom
scheme remain explicitly optional doors.

Call `main.close()` when the host retires the projection. This removes the IPC
handler and custom-scheme handler and closes the optional HTTP listener. Window
close, navigation, logout, and host binding revocation remain application
events. The host must attach its own lifecycle listeners to stop observations
or revoke the host-owned binding; the sender validator only enforces its
supplied sender/frame/URL predicate at invocation time. Closing or interrupting
a request is not evidence that
an already-started effect was rolled back, and the adapter never retries it.

The focused tests use injected Electron-shaped APIs. They prove ordering,
fail-closed sender checks, context isolation, a real bound read/change surface,
workspace-scoped observations, logout/navigation revocation, and cleanup; they
do not prove a real Electron process, preload, renderer navigation, or packaged
application.
For current support and acceptance status, see the central
[availability page](../concepts/current-status.md).
The separate `just electron-native-smoke` fixture launches an actual sandboxed
Electron process against the built bridge. It checks an accepted exact frame,
a different window at the same URL, and navigation. That bounded process proof
does not establish a packaged product, streaming IPC, or controlled effects.
For the platform rationale, see Electron's
[security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
which requires validating IPC senders and avoiding unrestricted preload APIs.
