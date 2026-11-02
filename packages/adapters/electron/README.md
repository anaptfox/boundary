# `@foxworth/boundary/electron`

Explicit Electron main/renderer transports for an injected Boundary HTTP handler.
The application owns windows, IPC exposure, credentials, and lifecycle.

Renderer bundles may import `electronIpcTransport` and `createElectronIpcFetch`
from `@foxworth/boundary/electron/ipc`. This entry excludes the Node HTTP/window adapter.
