---
title: "Persistent Bun bot"
description: "A Bun host that records a delegated draft, survives interruption, and keeps uncertain work visible."
---

# Persistent Bun bot

Planner is a focused, application-owned Bun example: a named bot receives one
bounded delegation, writes one saved application task draft through selected
Boundary interactions, records progress and a human review, and survives a local host
restart. It is not a reusable scheduler, generic agent runtime, shell/browser
automation service, routine engine, or multi-bot topology.

The coordinator has integrated `@foxworth/boundary/example-persistent-bot` into the
pnpm workspace with its existing Boundary/Zod dependencies and package scripts.

The host owns the SQLite database, bot identity, conversation, delegation,
review policy, UI, lifecycle, and process. Boundary supplies the declared interaction
contract and checked host dispatch. The bot surface narrows to
`persistent-bot.tasks.list` and `persistent-bot.tasks.create`; an HTML form,
model prompt, MCP description, or browser session cannot add authority.

Run `bun examples/apps/typescript/persistent-bot/src/main.ts --db /tmp/planner.sqlite`, open
the localhost URL, delegate a job, and inspect its actual saved draft before
adopting it. Closing the browser does not stop the Bun host. Stopping the host
or powering off its computer does; this local proof makes no background-work
promise while the machine is off or asleep.

Submission persists a job and conversation entry, returns a redirect, and hands
work to one host-owned worker. The worker calls the declared list interaction and
then creates the exact delegated task draft. A 500ms queue window permits
interruption before work starts. The page's refresh link reads saved progress;
closing or reconnecting the client never controls the worker. Each form carries
a saved request ID, so duplicate delivery cannot replay a job. Limits are 16
pending jobs and 1000 saved delegations in one local database.

## Recovery truth

The example writes `started` effect evidence before dispatching its one create
interaction and `completed` evidence only afterward. Its crash fixture exits in
the interval after application data changed but before completion evidence.
Restart changes that record to `uncertain`; it never automatically reruns the
interaction. Human-selected reconciliation inspects the source-keyed application
row and records either `completed` or `not-applied`. The inspection path does
not call `apply`/create again. An interrupted task with no started effect is
marked `interrupted` and is not automatically resumed.

Interruption during a started interaction reports that it is settling. It does
not claim rollback, and reconciliation is unavailable until the worker settles.
Interrupting a terminal job changes neither status nor progress. A thrown error
before dispatch records `failed`; after dispatch it records `uncertain`
immediately without requiring restart. Completion commits effect status, job
status, progress, and review atomically. Reconciliation checks the original
source key and title; absence becomes `not-applied`, mismatched data remains
uncertain, and repeated reconciliation never dispatches a new interaction.

Host shutdown stops acceptance, clears the timer, interrupts unstarted jobs,
and waits for the active worker before releasing SQLite and its Boundary installation.
A held SQLite lock permits one host per canonical database path. Process death
releases it; startup restores evidence without resuming old jobs. Use a single
database path without hard-link aliases. This proves process recovery on local
SQLite, not distributed execution or power-loss durability.

## Local human access

The host binds to `127.0.0.1`. Every request requires the exact configured Host
and URL origin, and every mutation requires the same Origin. Cross-site and
same-site Fetch Metadata are rejected before form parsing or job acceptance.
The HTML UI escapes saved content, disables caching and framing, and serves
forms with unique submission IDs; request bodies are capped at 4096 bytes.

`--allow-originless-cli` is an explicit fixture option for native loopback
clients carrying neither Origin nor Fetch Metadata. Foreign Host/Origin and
cross-site metadata remain denied. These protections prevent browser-origin
confusion; the local fixture is not production user authentication.

This is the same essential truth boundary as Control: a possibly-started effect
is unknown until reality is observed, and unknown is not retry permission. The
example does not present its small SQLite evidence table as a reusable Control
journal or a replacement for Control’s exact approval/grant/attempt semantics.

## Optional local model and MCP boundary

The deterministic proof uses real SQLite state and no secrets. Optional
Ollama/AI SDK reuse requires **Fox's explicit approval** before adding its
dependencies or enabling the adapter; workspace integration and coordinator
approval do not authorize it. The planned adapter may use the AI SDK versions
already locked for the Next example, only with a loopback URL and an
already-installed model. It has no cloud fallback or model download. Any MCP tool must be named
in app configuration; there is no discovery-based tool expansion. Neither
model prose nor saved conversation becomes an Boundary grant.

`node tests/process/persistent-bot.mjs` is the opt-in process test. It verifies
that a response finishes and its socket closes while the worker remains active,
then observes the later persisted review. It covers interruption before/after
dispatch, immediate failure classification, duplicate submissions, SIGKILL
after an application write, restart, reconciliation without replay, and
Host/Origin rejection before mutation. The script uses disposable SQLite data
and cleans up its subprocesses. This establishes the exercised local paths.

The root Vitest suite runs the bot tests in process on Node SQLite, with no
Bun or sockets. It does not launch the native script. Bun/HTTP acceptance is
confined to the explicit opt-in native script.
See the [example README](../../examples/apps/typescript/persistent-bot/README.md) for runtime
and verification commands. Optional Ollama and MCP integration remain pending.
