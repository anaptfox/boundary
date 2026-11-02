# Host-owned durable Control journal

`SqliteJournal` implements the TypeScript Control journal using `node:sqlite`
(Node 22.18 or newer). Node 22 labels this module experimental. This example adds
no storage dependency to Boundary; the application owns the database and effect.

`documentHost` replaces one document under an exact persisted attempt lease.
The mutation transaction checks owner, fence, expiry and execution state before
writing. The same transaction writes an effect ledger keyed by the exact proposal digest.
Verification and reconciliation inspect that ledger and never apply again; another
writer changing the document cannot falsify this interaction's recorded outcome.
The allow-all example policy is suitable for the proof; an application supplies
its own request, approval, grant, execution and reconciliation policy.

The journal uses WAL and FULL synchronization, unique indexes for record identity,
`BEGIN IMMEDIATE` for atomic insertion and compare-and-swap, and a bounded SQL
query for tenant-scoped pages. Readers revalidate all identities and scopes.
Synchronous SQLite is appropriate for this small host example; a busy database
blocks its Node event loop. Choose a worker or another host storage adapter for
workloads needing nonblocking database calls.

Run the proof from the repository root with the pinned Node runtime:

```sh
node node_modules/vitest/vitest.mjs run tests/typescript/control-journal-laws.test.ts tests/typescript/control-durable-crash.test.ts
```

The reusable adapter suite lives in
`tests/typescript/helpers/controlJournalLaws.ts`. Its factory supplies the journal,
reopen and cleanup. MemoryJournal's reopen means the same process; SQLite closes
and reopens the file. The crash proof additionally kills a real child process at
three committed boundaries and resumes from a new connection. Tests assert the
SIGKILL actually occurred. The child loader comes from the installed Vite/tsx
test toolchain.

These are local process-death and concurrency proofs. They do not qualify a
network filesystem, machine power loss, backup/restore, storage corruption,
replication, or a remote effect lacking atomic fencing. SQLite is a TypeScript
host example; Rust consumes the shared lifecycle evidence with its own native
records and does not run this adapter.
