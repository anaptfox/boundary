/// <reference types="../../../../packages/node_modules/@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import * as workers from "cloudflare:workers";
import { z } from "zod";
import { compileZodSchema } from "@foxworth/boundary/program/zod";
import { type Sha256Digest } from "@foxworth/boundary/program";
import { admitWhen, defineInteraction } from "@foxworth/boundary";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectInteractions, type Binding, createCaller, realizationIdsFor } from "@foxworth/boundary/pipeline";
import {
  createControlCapabilities,
  digestControlRealization,
  type AttemptRecord,
  type ControlCapabilities,
  type ControlHook,
} from "@foxworth/boundary/control";
import { contributeControlRequests } from "@foxworth/boundary/control/host";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { WorkspaceControlJournal } from "./controlJournal";

type Session = Readonly<{ actorId: string; role: "owner" }>;
type Context = Readonly<{ workspace: Workspace; session: Session }>;
type Installation = Readonly<{ workspaceId: string; deploymentId: string }>;
type Environment = Readonly<{
  WORKSPACE: DurableObjectNamespace<Workspace>;
  DEPLOYMENT_ID: string;
}>;
type Runtime = Readonly<{
  installation: Installation;
  binding: Binding<typeof projection.handles, Context>;
  control: ControlCapabilities<Session, Context>;
}>;

const sessions = new Map<string, Session>([
  ["fixture-owner", { actorId: "owner:fixture", role: "owner" }],
]);
declare const __WORKSPACE_CONTROL_ARTIFACT_DIGEST__: Sha256Digest;
const artifactDigest = __WORKSPACE_CONTROL_ARTIFACT_DIGEST__;
const countOutput = z.strictObject({ count: z.number().int().nonnegative() });
const incrementInput = z.strictObject({ amount: z.number().int().min(1).max(10) });
const controlState = z.strictObject({ before: z.number().int().nonnegative() });
const controlPreview = z.strictObject({
  amount: z.number().int().min(1),
  expectedCount: z.number().int().nonnegative(),
});

const interactions = {
  read: defineInteraction({
    id: "workspace.read",
    output: countOutput,
    reads: ["workspace"],
    changes: [],
  }),
  increment: defineInteraction({
    id: "workspace.increment",
    input: incrementInput,
    output: countOutput,
    reads: [],
    changes: ["workspace"],
  }),
} as const;
const compiled = await compileInteractions(interactions);
const projection = await projectInteractions(compiled, {
  read: { interaction: compiled.handles.read, modes: ["direct"] },
  increment: {
    interaction: compiled.handles.increment,
    modes: ["request"],
  },
});

function sessionFor(request: Request): Session | undefined {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "");
  return sessions.get(token ?? "");
}

/** One native Durable Object owns one workspace, including its Control evidence. */
export class Workspace extends DurableObject<Environment> {
  readonly #journal = new WorkspaceControlJournal(this.ctx);
  #runtime: Runtime | undefined;
  #loseAcknowledgement = false;

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), count INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO workspace_state VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS workspace_installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), workspace_id TEXT NOT NULL, deployment_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_increment_effects (
        proposal_digest TEXT PRIMARY KEY, amount INTEGER NOT NULL, count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_alarm_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, attempt_id TEXT, outcome TEXT NOT NULL
      );
    `);
    this.#journal.installSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const session = sessionFor(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const attach = /^\/attach\/([^/]+)$/u.exec(url.pathname);
    if (attach && request.method === "POST") {
      return Response.json(await this.#attach({
        workspaceId: decodeURIComponent(attach[1]!),
        deploymentId: this.env.DEPLOYMENT_ID,
      }));
    }
    if (url.pathname === "/observe") return this.#observe(request, session);
    if (url.pathname.startsWith("/control/")) return this.#controlRoute(request, session, url);
    // Tracing is optional in older installed workerd runtimes. The host owns
    // the read-only span and keeps mutations outside any retry policy.
    if (request.method === "GET" && typeof workers.tracing?.startActiveSpan === "function") {
      return workers.tracing.startActiveSpan("workspace.protocol.read", async (span) => {
        try {
          if (typeof span.updateName === "function") span.updateName("workspace.protocol.read");
          if (typeof span.setAttribute === "function") span.setAttribute("boundary.surface", "protocol");
          const response = await this.#protocol(request, session);
          if (typeof span.setStatus === "function") span.setStatus({ code: response.ok ? "ok" : "error" });
          if (typeof span.spanContext === "function") span.spanContext();
          return response;
        } finally { if (typeof span.end === "function") span.end(); }
      });
    }
    return this.#protocol(request, session);
  }

  /** Platform-delivered, at-least-once reconciliation; it never calls apply. */
  async alarm(): Promise<void> {
    const runtime = await this.#bound();
    if (!runtime) {
      this.#recordAlarm(undefined, "stale-installation");
      return;
    }
    const alarmSession = { actorId: "alarm:workspace", role: "owner" } as const;
    let nextAlarmAt: number | undefined;
    for (const attempt of this.#journal.attempts()) {
      if (attempt.installationId !== this.#installationId(runtime.installation)) {
        this.#recordAlarm(attempt.id, "stale-installation");
        continue;
      }
      const previousDeliveries = this.#alarmReceiptCount(attempt.id);
      let outcome;
      try {
        outcome = await runtime.control.admin.reconcile(attempt.id, alarmSession, {
          workspace: this,
          session: alarmSession,
        });
      } catch {
        this.#recordAlarm(attempt.id, "reconcile-fault");
        nextAlarmAt = Math.max(nextAlarmAt ?? 0, Date.now() + 1_000);
        continue;
      }
      this.#recordAlarm(attempt.id, outcome.status);
      this.#broadcast({ kind: "control.reconciled", attemptId: attempt.id, status: outcome.status });
      if (outcome.status === "uncertain") {
        nextAlarmAt = Math.max(nextAlarmAt ?? 0, attempt.lease.expiresAt + 1, Date.now() + 20);
      } else if (outcome.status === "completed" && previousDeliveries === 0) {
        // A second platform wake proves reconciliation is idempotent after receipt.
        nextAlarmAt = Math.max(nextAlarmAt ?? 0, Date.now() + 20);
      }
    }
    if (nextAlarmAt !== undefined) await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  read(): { count: number } {
    const row = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT count FROM workspace_state WHERE singleton = 1",
    ).toArray()[0];
    if (!row) throw new Error("workspace state is missing");
    return { count: row.count };
  }

  #storedInstallation(): Installation | undefined {
    const row = this.ctx.storage.sql.exec<{ workspace_id: string; deployment_id: string }>(
      "SELECT workspace_id, deployment_id FROM workspace_installation WHERE singleton = 1",
    ).toArray()[0];
    return row && { workspaceId: row.workspace_id, deploymentId: row.deployment_id };
  }

  #installationId(installation: Installation): string {
    return `installation:workspace:${installation.workspaceId}:${installation.deploymentId}`;
  }

  async #attach(next: Installation): Promise<"initialized" | "reconstructed" | "replaced"> {
    const current = this.#storedInstallation();
    const status = !current ? "initialized"
      : current.workspaceId === next.workspaceId && current.deploymentId === next.deploymentId
        ? "reconstructed" : "replaced";
    if (!current) {
      this.ctx.storage.sql.exec("INSERT INTO workspace_installation VALUES (1, ?, ?)", next.workspaceId, next.deploymentId);
    } else if (status === "replaced") {
      this.ctx.storage.sql.exec("UPDATE workspace_installation SET workspace_id=?, deployment_id=? WHERE singleton=1", next.workspaceId, next.deploymentId);
    }
    this.#runtime = await this.#createRuntime(next);
    if (status === "replaced") this.#revokeStaleSockets(next);
    return status;
  }

  async #bound(): Promise<Runtime | undefined> {
    const installation = this.#storedInstallation();
    if (!installation || installation.deploymentId !== this.env.DEPLOYMENT_ID) return undefined;
    return this.#runtime ??= await this.#createRuntime(installation);
  }

  async #protocol(request: Request, session: Session): Promise<Response> {
    const runtime = await this.#bound();
    if (!runtime) return new Response("Workspace installation is absent or stale", { status: 409 });
    return createProtocolHandler({
      caller: createCaller(runtime.binding),
      context: () => ({ workspace: this, session }),
      path: "/boundary",
    })(request);
  }

  async #controlRoute(request: Request, session: Session, url: URL): Promise<Response> {
    const runtime = await this.#bound();
    if (!runtime) return new Response("Workspace installation is absent or stale", { status: 409 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (url.pathname === "/control/alarm-receipts") return Response.json(this.#alarmReceipts());
    const id = url.pathname.split("/").at(-1);
    if (!id) return new Response("Not Found", { status: 404 });
    const context = { workspace: this, session };
    if (url.pathname.startsWith("/control/approve/")) return Response.json(await runtime.control.admin.approve(id, session));
    if (url.pathname.startsWith("/control/grant/")) return Response.json(await runtime.control.admin.grant(id, session));
    if (url.pathname.startsWith("/control/status/")) return Response.json(await runtime.control.reader.status(id));
    if (!url.pathname.startsWith("/control/execute/")) return new Response("Not Found", { status: 404 });
    this.#loseAcknowledgement = url.searchParams.get("lose-ack") === "1";
    const outcome = await runtime.control.admin.execute(id, session, context);
    if (outcome.status === "uncertain") await this.ctx.storage.setAlarm(Date.now() + 20);
    return Response.json(outcome);
  }

  #applyIncrement(amount: number, digest: Sha256Digest, lease: AttemptRecord["lease"]): { count: number } {
    const output = this.ctx.storage.transactionSync(() => {
      const attempt = this.#journal.findAttemptByProposalDigestSync(digest);
      if (!attempt || attempt.execution !== "started" || attempt.lease.owner !== lease.owner || attempt.lease.fence !== lease.fence || attempt.lease.expiresAt <= Date.now()) throw new Error("stale exact Control lease");
      if (this.ctx.storage.sql.exec("SELECT 1 FROM workspace_increment_effects WHERE proposal_digest=?", digest).toArray().length) throw new Error("exact effect already recorded");
      this.ctx.storage.sql.exec("UPDATE workspace_state SET count=count+? WHERE singleton=1", amount);
      const count = this.read().count;
      this.ctx.storage.sql.exec("INSERT INTO workspace_increment_effects VALUES(?,?,?)", digest, amount, count);
      return { count };
    });
    this.#broadcast({ kind: "workspace.incremented", count: output.count });
    if (this.#loseAcknowledgement) {
      this.#loseAcknowledgement = false;
      throw new Error("application lost acknowledgement after durable effect commit");
    }
    return output;
  }

  #directIncrement(amount: number): { count: number } {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE workspace_state SET count=count+? WHERE singleton=1", amount);
      return this.read();
    });
  }

  #recordAlarm(attemptId: string | undefined, outcome: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO workspace_alarm_receipts(observed_at,attempt_id,outcome) VALUES(?,?,?)",
      Date.now(),
      attemptId ?? null,
      outcome,
    );
  }

  #alarmReceipts(): readonly { observedAt: number; attemptId: string | null; outcome: string }[] {
    return this.ctx.storage.sql.exec<{ observed_at: number; attempt_id: string | null; outcome: string }>(
      "SELECT observed_at,attempt_id,outcome FROM workspace_alarm_receipts ORDER BY id",
    ).toArray().map((row) => ({ observedAt: row.observed_at, attemptId: row.attempt_id, outcome: row.outcome }));
  }

  #alarmReceiptCount(attemptId: string): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM workspace_alarm_receipts WHERE attempt_id=?",
      attemptId,
    ).toArray()[0]?.count ?? 0;
  }

  async #observe(request: Request, session: Session): Promise<Response> {
    const runtime = await this.#bound();
    if (!runtime) return new Response("Workspace installation is absent or stale", { status: 409 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ workspaceId: runtime.installation.workspaceId, deploymentId: runtime.installation.deploymentId, actorId: session.actorId });
    server.send(JSON.stringify({ kind: "workspace.connected", workspaceId: runtime.installation.workspaceId, actorId: session.actorId, count: this.read().count }));
    return new Response(null, { status: 101, webSocket: client });
  }

  #broadcast(value: unknown): void {
    const installation = this.#storedInstallation();
    if (!installation || installation.deploymentId !== this.env.DEPLOYMENT_ID) return;
    for (const socket of this.ctx.getWebSockets()) {
      const scope = socket.deserializeAttachment() as { workspaceId?: string; deploymentId?: string; actorId?: string } | null;
      if (scope?.workspaceId === installation.workspaceId && scope.deploymentId === installation.deploymentId && scope.actorId) socket.send(JSON.stringify(value));
    }
  }

  async webSocketMessage(socket: WebSocket, _message: ArrayBuffer | string): Promise<void> {
    const scope = socket.deserializeAttachment() as { workspaceId?: string; deploymentId?: string; actorId?: string } | null;
    const installation = this.#storedInstallation();
    if (!scope?.actorId || !installation || scope.workspaceId !== installation.workspaceId || scope.deploymentId !== installation.deploymentId || installation.deploymentId !== this.env.DEPLOYMENT_ID) return socket.close(1008, "workspace generation changed");
    socket.send(JSON.stringify({ kind: "workspace.snapshot", count: this.read().count }));
  }
  webSocketClose(socket: WebSocket, code: number, reason: string): void { socket.close(code, reason); }

  #revokeStaleSockets(installation: Installation): void {
    for (const socket of this.ctx.getWebSockets()) {
      const scope = socket.deserializeAttachment() as { workspaceId?: string; deploymentId?: string } | null;
      if (scope?.workspaceId !== installation.workspaceId || scope.deploymentId !== installation.deploymentId) socket.close(1008, "workspace generation replaced");
    }
  }

  async #createRuntime(installation: Installation): Promise<Runtime> {
    const hook: ControlHook<{ amount: number }, { count: number }, { before: number }, { amount: number; expectedCount: number }, typeof controlState, typeof controlPreview, Context> = {
      realizationDigest: artifactDigest,
      state: controlState,
      preview: controlPreview,
      plan: ({ input }) => { const before = this.read().count; return { subject: { kind: "workspace", id: installation.workspaceId }, baseline: { count: before }, baselineSummary: `workspace count ${before}`, effects: [{ kind: "sqlite", action: "increment", resource: `workspace/${installation.workspaceId}` }], state: { before }, preview: { amount: input.amount, expectedCount: before + input.amount } }; },
      apply: ({ input, proposal, lease }) => this.#applyIncrement(input.amount, proposal.proposalDigest, lease),
      verify: ({ output, proposal }) => this.#journal.effectMatches(proposal.proposalDigest, output.count) ? { ok: true, evidence: { proposalDigest: proposal.proposalDigest, count: output.count } } : { ok: false, message: "exact durable effect ledger entry is absent or differs" },
      reconcile: ({ proposal }) => { const count = this.#journal.effectCount(proposal.proposalDigest); return count === undefined ? { status: "not-applied", reason: "no exact durable effect ledger entry exists" } : { status: "completed", value: { count } }; },
    };
    const controlled = await digestControlRealization({ compileSchema(schema, context) { return compileZodSchema(schema as z.ZodType, context.role, context.path); } }, { interactionId: compiled.handles.increment.interactionId, contractDigest: compiled.handles.increment.contractDigest }, hook);
    let installed: Awaited<ReturnType<typeof installInteractions<typeof interactions, Context>>>["installation"] | undefined;
    const requestRealizationId = `workspace:${installation.workspaceId}:${installation.deploymentId}:increment:request`;
    const executionRealizationId = `workspace:${installation.workspaceId}:${installation.deploymentId}:increment:execute`;
    const control = createControlCapabilities<Session, Context>({
      journal: this.#journal,
      clock: { now: () => Date.now() },
      executor: { owner: `workspace:${installation.workspaceId}:alarm` },
      lease: { durationMs: 60_000 },
      policy: { identify: (actor) => actor.actorId, request: () => ({ allow: true }), approve: () => ({ allow: true }), grant: () => ({ allow: true }), execute: () => ({ allow: true }), reconcile: () => ({ allow: true }), preflight: () => undefined },
    }, {
      inspect: () => {
        if (!installed) throw new Error("Control inspected before installation");
        return { installationId: installed.installationId, installationDigest: installed.manifest.installationDigest, programDigest: installed.manifest.program.programDigest };
      },
      resolve: (target) => {
        if (!installed || target.interactionId !== interactions.increment.id || target.contractDigest !== compiled.handles.increment.contractDigest || target.controlDigest !== controlled.controlDigest || target.controlRealizationDigest !== artifactDigest || target.executionRealizationId !== executionRealizationId || target.requestRealizationId !== requestRealizationId || target.installationId !== installed.installationId || target.installationDigest !== installed.manifest.installationDigest || target.programDigest !== installed.manifest.program.programDigest) throw new Error("stale or substituted Control target");
        return { target, hook: controlled.hook, parseInput: (value) => incrementInput.parse(value), parseState: (value) => z.parse(controlState, value), parsePreview: (value) => z.parse(controlPreview, value), parseOutput: (value) => countOutput.parse(value) };
      },
    }, { interactionIds: [interactions.increment.id], tenant: { kind: "workspace", id: installation.workspaceId } });
    const implementations = implementInteractions<typeof interactions, Context>(interactions, {
      read: () => this.read(),
      increment: (input) => this.#directIncrement(input.amount),
    });
    const result = await installInteractions<typeof interactions, Context>(compiled, { installationId: `installation:workspace:${installation.workspaceId}:${installation.deploymentId}`, implementations, requests: contributeControlRequests(compiled, control.requester, { increment: { interaction: compiled.handles.increment, control: controlled, executionRealizationId, actor: (context) => context.session } }), realizationIds: { ...realizationIdsFor(compiled, `workspace:${installation.workspaceId}:${installation.deploymentId}`), increment: { direct: `workspace:${installation.workspaceId}:${installation.deploymentId}:increment:direct`, request: requestRealizationId } } });
    installed = result.installation;
    const bound = await bindSurface(projection, installed, { admit: admitWhen((context: Context) => context.session.role === "owner", "owner session required") });
    if (bound.status !== "bound") throw new Error("workspace projection did not bind");
    return { installation, binding: bound.binding, control };
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/workspaces\/([^/]+)(\/.*)$/u.exec(url.pathname);
    if (!match) return new Response("Not Found", { status: 404 });
    if (!sessionFor(request)) return new Response("Unauthorized", { status: 401 });
    const workspaceId = decodeURIComponent(match[1]!);
    const suffix = match[2]!;
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    const target = suffix === "/attach" && request.method === "POST"
      ? `/attach/${encodeURIComponent(workspaceId)}`
      : `${suffix}${url.search}`;
    return stub.fetch(new Request(new URL(target, request.url), request));
  },
};
