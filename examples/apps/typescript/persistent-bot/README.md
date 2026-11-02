# Planner: a bounded persistent bot

Planner is an application-owned Bun host example. It stores one named bot, a
saved conversation, delegated jobs, progress, review records, effect evidence,
and application task drafts in local SQLite. It is deliberately not an Boundary bot
runtime, scheduler, shell, browser-control service, routines engine, or
multi-bot system.

Run it with Bun 1.3.14:

```sh
bun examples/apps/typescript/persistent-bot/src/main.ts --db /tmp/planner.sqlite
```

The coordinator has integrated `@foxworth/boundary-example-persistent-bot` into the
pnpm workspace. Its existing Boundary/Zod dependencies and package scripts are
available through that workspace.

Open the printed localhost URL, delegate a task, then inspect the saved draft
and review record. The browser is only a client: closing it does not stop the
host. Stop the process with Ctrl-C when you intend to stop it.

The only bot-facing interactions are `persistent-bot.tasks.list` and
`persistent-bot.tasks.create`. They are declared through Boundary and dispatched by
the host. The database and UI are application-owned.

## Background work, interruption, and recovery

Submitting the form saves the delegation and its request ID, returns a redirect,
and schedules one host-owned worker. The worker reads current tasks through Boundary,
then creates exactly the delegated draft. Repeated submission of the same ID
returns the same job; it never replays the effect. A 500ms queue window permits
interruption before work starts. The app accepts at most 16 pending jobs and
1000 saved delegations per database. These are local example limits.

Use **Refresh saved progress** to inspect work after leaving or reconnecting.
The page does not need to stay open. Interruption before dispatch persists
`interrupted` without an effect. Once dispatch starts, interruption reports
that the interaction is settling; it cannot undo the write. Interrupting a
completed, failed, interrupted, or uncertain job leaves its history unchanged.

Exceptions before dispatch become `failed`. Exceptions after dispatch become
`uncertain` immediately in the running host. Completion commits the job,
effect status, progress, and review together. The draft itself is created in
the preceding interaction transaction, so there is a recoverable gap between
application reality and completion evidence.

`--crash-after-apply` kills the host immediately after the declared create interaction has
written an application draft but before the effect completion record. On the
next start, that effect is `uncertain`; the app does not rerun it. Use the
**Reconcile saved result** button to look up the existing source-keyed draft
and verify its exact title before recording completion. Absence becomes
`not-applied`; mismatched evidence remains uncertain. Reconciliation is blocked
while the current worker is still settling. A restart marks queued and unstarted
work `interrupted`, and never resumes it automatically.

Ctrl-C/SIGTERM stops acceptance, clears the queue timer, interrupts unstarted
jobs, and waits for the active worker before revoking its Boundary installation and
closing SQLite. SQLite uses WAL and FULL synchronous writes. A separate held
SQLite lock allows one host per canonical database path and releases on process
death. Use one database path, not hard-link aliases. This is local process-crash
evidence, not power-loss or distributed-worker acceptance.

## Local HTTP boundary

Open the printed `http://127.0.0.1:4319` address. Every request must carry that
exact Host and URL origin. Mutation requests also require the same Origin;
cross-site and same-site Fetch Metadata are rejected before form parsing or
delegation. Responses disable caching and frame embedding, and the native
server caps request bodies at 4096 bytes. Forms render saved text with HTML
escaping and carry a unique submission ID.

The explicit `--allow-originless-cli` option permits local native clients with
neither Origin nor Fetch Metadata. It still rejects a foreign Host, an explicit
foreign/null Origin, and cross-site browser metadata. It is a local fixture
option, not user authentication. Default browser mode requires Origin.

## Verification

Run the opt-in native Bun/HTTP and crash/restart proof:

```sh
node tests/process/persistent-bot.mjs
```

The native script uses disposable databases and bounded subprocess barriers to
prove a completed response and closed client connection before background
review, interruption on both sides of dispatch, exceptions, SIGKILL after an
effect, restart, exact reconciliation, deduplication, and HTTP rejection before
mutation. It terminates its own processes and removes its temporary data.
The workspace package's `smoke` script also runs this proof from its own directory.

The root Vitest suite runs `tests/typescript/persistent-bot.smoke.test.ts` in
process, using Node's real SQLite and the app's native database interface.
These tests require neither Bun nor sockets and do not launch the native script.
Native Bun/HTTP acceptance is opt-in through the script above.
The package's `typecheck` script checks this example's typed application, host,
server, and focused tests. The small Bun runtime integration is JavaScript and
is exercised by the native proof.

Deterministic mode uses real persisted app data. It does not send external
messages or claim any provider did.

## Optional local model loop (not yet enabled)

Workspace integration does not authorize the optional model loop. The planned
Ollama/AI SDK reuse requires **Fox's explicit approval** before adding
`ai@7.0.92` and `@ai-sdk/openai-compatible@3.0.43` as direct dependencies or
enabling the adapter. Coordinator approval is not a substitute. It must remain
loopback-only, use an already-installed local model, and expose only the two
declared interactions above plus any separately configured MCP tools. This
deterministic implementation intentionally contains no fallback cloud model.
