# Todo room over WebSocket

A local Node host uses AI SDK **7.0.137** `WebSocketChatTransport`, deferred
`toolSearch`, and `onUIMessageStepEnd` checkpoints. The default provider is a
deterministic local fixture. Ask **complete 1**: the guide reads the board and
records a proposal. The visible approval button invokes the screen Binding.
The model's Binding contains only `todos.list`; approval is absent from its
catalog. Removing Boundary leaves the host's proposals, store and policy intact.

```sh
pnpm --dir examples/apps/typescript/websocket-room dev
# Open http://127.0.0.1:4318
```

To use an already-installed Ollama model, set `BOUNDARY_ROOM_MODEL` when running
the command. Inference uses only `http://127.0.0.1:11434/v1`, rejects redirects,
and has no provider credential. No model is downloaded automatically.

The host validates SDK frames, correlates requests, deduplicates accepted
message ids, and stores complete response replays. Reconnect never reruns a
model or approved effect. Stop aborts inference; it cannot undo a completed
proposal or effect. Approval checks the exact observed todo, marks execution
before awaiting, and preserves an uncertain outcome without allowing replay.

State and checkpoints are process-local. Restart loses the board, proposals
and replay history; nothing resumes automatically. This is a shared local demo,
not a multi-user authentication service. HTTP approvals and WebSocket upgrades
check the local host and browser Origin. SDK application-frame headers do not
establish an authenticated browser handshake.

Bounds: 32 KiB input frames, 50 messages, 64 chats, eight concurrent jobs,
256 accepted message ids, 256 proposals, 256 chunks / 512 KiB per replay,
512 KiB socket send buffering, and a 60-second job deadline. At capacity the
host refuses more work instead of evicting deduplication evidence. Slow sockets
close and may reconnect for replay.

Qualification: `tests/typescript/websocket-room.test.ts` covers host policy and
stream lifecycle; `tests/typescript/live/websocket-room.test.ts` runs the native
SDK over a real loopback socket. `just websocket-room-smoke` builds the browser
and runs that consumer proof; it is included in `just e2e`.
