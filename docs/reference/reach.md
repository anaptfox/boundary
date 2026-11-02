---
title: "Reach records and the local bus"
description: "Name where a Binding can be reached without reopening its identity."
---

# Reach records and the local bus

A Binding pins a caller surface to one installation. It does not say where that
installation is. A **Reach record** names the transports without reopening
identity: it references a binding digest and is reissued when a deployment
moves.

A Reach record is not authority. Holding one lets a caller find a surface and
fetch its manifest. The caller still binds atomically, and the host still admits
every invocation. Records are unsigned in version 1; the signature field is
reserved and excluded from the digest.

```text
host installs
   │
   └── registers a Reach record on the per-user bus
            │
boundary list / boundary call / boundary mcp
            │
            └── fetch the manifest, then Handoff over the named transport
```

## The bus

`boundary bus` is a resolver, not a broker. It answers where a Binding can be
reached. It does not invoke, hold context, or journal receipts. Receipts stay
with Control in the application that executed the effect.

Trust is the OS user. The socket lives in a directory created `0700`, so the
kernel refuses another user's `connect` before bus code runs. The
implementation does **not** read `SO_PEERCRED`: directory permissions are
portable and enforced in one place. This establishes which OS user is on the
other end. It says nothing about which application.

A second `boundary bus` against a live socket fails rather than unlinking it. A
leftover socket from a dead process is removed only after a connect proves
nothing is listening. Lines longer than 64 KiB are refused with `LINE_TOO_LONG`;
the daemon keeps serving.

Registration proves possession. Binding digests are content-derived and
published, so a claim alone means nothing: the bus fetches `{base}/manifest`
from the transport the record names and refuses the record unless the manifest
it gets back names the same Binding (`NOT_POSSESSED`). A host must therefore be
listening before it registers, which is the right order anyway — a record
naming an address that does not answer is not yet reachable.

This is not authentication against a determined local attacker, who can still
race the real application to a port. It removes the free case: squatting now
means serving a valid manifest for a Binding you do not have.

The TypeScript client is `@foxworth/boundary/bus`. The Rust client is `boundary_bus`.

## Discover and select an interaction

Build the local command with `just boundary-build`, then use
`./target/debug/boundary --help`. `boundary bus --help`, `boundary list --help`,
and `boundary call --help` display usage before socket activity. Unknown flags
are rejected before starting or contacting a bus.

`boundary list` fetches and validates each advertised manifest, checks its Binding
and Installation against the Reach record, and prints interaction IDs with their
available `direct` or `request` modes. It lists valid rows while naming unavailable
or changed manifests on stderr, then exits non-zero if the listing is incomplete.
Discovery does not grant authority; the host still admits each invocation.
Implicit call resolution also refuses an incomplete inspection: unavailable
manifests cannot establish a unique matching Binding. Select an inspected digest
explicitly rather than guessing what the unavailable host exposes.

When more than one Binding exposes the same interaction, `boundary call` refuses
the ambiguity and names the candidate digests. Pass `--binding DIGEST` with one
exact digest from the listing to select it. An unregistered, changed, or unreachable
selection is an error; it never falls back to another Binding. `--mode request`
also remains an exact selection. Without `--mode`, a dual-mode interaction uses
request mode. One invocation is sent over the inspected transport, with no retry.

## HTTP and HTTPS

Version 1 Handoff HTTP framing is specified in
[section 6](../spec/06-http-framing.md). `boundary call` speaks `http://` and
`https://`. HTTPS is TLS in `boundary-reach`; it is never a silent downgrade
to plaintext. Response bodies, chunk sizes, and lengthless streams above 8 MiB
are refused before a buffer of the claimed size is allocated, and header lines
above 16 KiB are refused too.

A transport address is limited to ASCII alphanumerics and `-._~:/%`. Records
are unsigned in version 1, so whoever hands one over chooses the address a
caller dials; a strict allowlist means a record cannot carry a newline into a
request line and turn one request into two. The check runs both when a record
is made and again at the socket.

## `boundary mcp`

One MCP server per OS user. Tools are derived from the Binding manifests of
reachable surfaces.

**The Projection is the only narrowing.** Every interaction on a reachable
Binding's manifest is published as a tool. There is no second list that hides
one, so there is nothing for this server to fail to honour: narrow what a model
sees by publishing a narrower Projection, which also keeps the interaction out of
the Binding. Admission is still the gate — the surface admits every call it
receives.

An unreachable surface is a tool error, not a JSON-RPC error, because
reporting it as a malformed request would claim the interaction definitely did
not run. A tool call is sent over exactly one transport: retrying an
invocation on a second transport could apply an effect the first already
started.

<!-- snippet:examples/snippets/typescript/reach-bus.ts#reach-register -->
```ts
const record = await createReachRecord(bindingDigest, "deploy:docs:1", [
  { kind: "http", url: "http://127.0.0.1:8080/boundary/v1" },
]);
const bus = await BusClient.connect(socket);
await bus.register(record);
const listed = await bus.list();
bus.close();
return listed.length;
```
