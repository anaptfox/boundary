import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type ControlHook, type ControlPolicy, createControlCapabilities, digestControlRealization } from "@foxworth/boundary/control";
import { hashJson, jsonEquals } from "@foxworth/boundary/program";
import { compileZodSchema } from "@foxworth/boundary/program/zod";
import type { InteractionHandle, InteractionInstallation } from "@foxworth/boundary";
import type { Document } from "./documents";
import type { DemoContext } from "./context";
import { SqliteJournal } from "./publish-journal";

export const PublishInput = z.strictObject({
  id: z.literal("doc-1"),
  expectedRevision: z.number().int().positive(),
});
export const Published = z.strictObject({
  revision: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  richText: z.string().optional(),
});
// Keep only the published fields of a saved document or a stored snapshot.
const publishedFields = (value: unknown) => Published.strip().parse(value);
const Snapshot = z.strictObject({
  ...Published.shape,
  previousPublication: z.number().int().nonnegative(),
});
export const PublicationStatus = z.strictObject({
  published: Published.nullable(),
  proposals: z.array(
    z.strictObject({
      ...Published.shape,
      id: z.string(),
      digest: z.string(),
      state: z.string(),
      requestedBy: z.string(),
    }),
  ),
});
export type PublicationView = z.infer<typeof PublicationStatus>;
type Actor = { id: string; human: boolean; workspace: string };
const scope = {
  tenant: { kind: "workspace", id: "folio" },
  interactionIds: ["documents.publish"],
};
export function publicationActor(context: DemoContext): Actor {
  return {
    id: context.delegation
      ? `${context.delegation.executor}:for:${context.delegation.delegator}`
      : context.assistantAgent
      ? `${context.assistantAgent}:for:${context.session}`
      : context.session,
    human: context.session === "alice" && context.canEdit &&
      !context.delegation && !context.assistantAgent,
    workspace: context.delegation?.workspace ?? "folio",
  };
}
export function assertPublicationScope(context: DemoContext): void {
  if (
    context.documentId !== "doc-1" ||
    (context.delegation && context.delegation.workspace !== "folio")
  ) throw new Error("Publication is outside the current workspace");
}

/** App-owned durability and effect fencing; no scheduler or model runtime in Boundary. */
export async function createPublicationControl(options: {
  interaction: InteractionHandle;
  installation: () => InteractionInstallation<DemoContext>;
  readDocument: () => Promise<Document>;
  database: string;
  sourceRoot: string;
  now?: () => number;
  afterEffect?: () => void;
}) {
  await mkdir(dirname(options.database), { recursive: true });
  const journal = new SqliteJournal(options.database);
  journal.db.exec(
    "CREATE TABLE IF NOT EXISTS publications (sequence INTEGER PRIMARY KEY AUTOINCREMENT, proposal_digest TEXT UNIQUE NOT NULL, snapshot TEXT NOT NULL)",
  );
  const now = options.now ?? Date.now;
  // Production reviews pin the Next build as well as this explicit app source
  // closure. Rebuilding changes identity; restarting the same build does not.
  const artifactSources = await Promise.all([
    readFile(join(options.sourceRoot, "lib/publication.ts"), "utf8"),
    readFile(join(options.sourceRoot, "lib/publish-journal.ts"), "utf8"),
    readFile(join(options.sourceRoot, "lib/boundary.ts"), "utf8"),
    readFile(join(options.sourceRoot, "lib/documents.ts"), "utf8"),
    readFile(join(options.sourceRoot, "lib/context.ts"), "utf8"),
    readFile(join(options.sourceRoot, "lib/rich-text.ts"), "utf8"),
    readFile(join(options.sourceRoot, "app/publication-actions.ts"), "utf8"),
    readFile(join(options.sourceRoot, "package.json"), "utf8"),
  ]);
  let buildId = "development-source-cut";
  try {
    buildId = await readFile(
      join(options.sourceRoot, ".next/BUILD_ID"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const latest = () =>
    journal.db.prepare(
      "SELECT sequence, snapshot FROM publications ORDER BY sequence DESC LIMIT 1",
    ).get() as { sequence: number; snapshot: string } | undefined;
  const effect = (digest: string) =>
    journal.db.prepare(
      "SELECT snapshot FROM publications WHERE proposal_digest=?",
    ).get(digest) as { snapshot: string } | undefined;
  const permitted = (actor: Actor, human = false) =>
    actor.workspace === "folio" && (!human || actor.human)
      ? { allow: true as const }
      : {
        allow: false as const,
        reason: "Alice must review this exact publication in its workspace",
      };
  const policy: ControlPolicy<Actor> = {
    identify: (actor) => actor.id,
    request: ({ actor }) => permitted(actor),
    approve: ({ actor }) => permitted(actor, true),
    grant: ({ actor, approvals }) =>
      approvals.some((a) => a.approvedBy === "alice")
        ? permitted(actor, true)
        : { allow: false, reason: "Exact human approval is required" },
    execute: ({ actor }) => permitted(actor, true),
    reconcile: ({ actor }) => permitted(actor, true),
    async preflight({ proposal }) {
      const current = publishedFields(await options.readDocument());
      if (!jsonEquals(current, Published.parse(proposal.preview))) {
        throw new Error(
          "The saved draft changed; request a fresh publication review",
        );
      }
    },
  };
  const hook: ControlHook<
    z.infer<typeof PublishInput>,
    z.infer<typeof Published>,
    z.infer<typeof Snapshot>,
    z.infer<typeof Published>,
    unknown,
    unknown,
    DemoContext
  > = {
    realizationDigest: await hashJson("folio.publication-artifact/v1", {
      buildId,
      sources: artifactSources,
    }),
    state: Snapshot,
    preview: Published,
    async plan({ input, context }) {
      assertPublicationScope(context);
      const document = await options.readDocument();
      if (document.revision !== input.expectedRevision) {
        throw new Error(
          "The draft changed; request a fresh publication review",
        );
      }
      const snapshot = publishedFields(document);
      const previousPublication = latest()?.sequence ?? 0;
      return {
        subject: scope.tenant,
        baseline: { snapshot, previousPublication },
        baselineSummary:
          `Publish saved revision ${snapshot.revision}; draft edits remain separate`,
        effects: [{
          kind: "sqlite",
          action: "publish",
          resource: "folio/doc-1",
        }],
        state: { ...snapshot, previousPublication },
        preview: snapshot,
      };
    },
    apply({ state, proposal, lease }) {
      const snapshot = publishedFields(state);
      journal.transaction(() => {
        const row = journal.db.prepare(
          "SELECT data FROM records WHERE kind='attempt' AND digest=?",
        ).get(proposal.proposalDigest) as { data: string } | undefined;
        const attempt = row ? JSON.parse(row.data) : undefined;
        if (
          !attempt || attempt.execution !== "started" ||
          attempt.lease.owner !== lease.owner ||
          attempt.lease.fence !== lease.fence ||
          attempt.lease.expiresAt <= now()
        ) throw new Error("Stale publication executor fence");
        if ((latest()?.sequence ?? 0) !== state.previousPublication) {
          throw new Error("Publication changed after review");
        }
        journal.db.prepare(
          "INSERT INTO publications(proposal_digest,snapshot) VALUES (?,?)",
        ).run(proposal.proposalDigest, JSON.stringify(snapshot));
      });
      options.afterEffect?.();
      return snapshot;
    },
    verify: ({ proposal, output }) =>
      Boolean(effect(proposal.proposalDigest)) &&
        jsonEquals(
          JSON.parse(effect(proposal.proposalDigest)!.snapshot),
          output,
        )
        ? { ok: true, evidence: { proposalDigest: proposal.proposalDigest } }
        : { ok: false, message: "Publication ledger differs" },
    reconcile: ({ proposal }) => {
      const row = effect(proposal.proposalDigest);
      return row
        ? {
          status: "completed",
          value: Published.parse(JSON.parse(row.snapshot)),
        }
        : {
          status: "not-applied",
          reason: "No atomic publication ledger entry for this attempt",
        };
    },
  };
  const control = await digestControlRealization({
    compileSchema: (schema, context) =>
      compileZodSchema(schema as z.ZodType, context.role, context.path),
  }, {
    interactionId: options.interaction.interactionId,
    contractDigest: options.interaction.contractDigest,
  }, hook);
  const capabilities = createControlCapabilities<Actor, DemoContext>({
    journal,
    policy,
    clock: { now },
    executor: { owner: randomUUID() },
    lease: { durationMs: 1_000 },
  }, {
    inspect: () => {
      const installation = options.installation();
      return {
        installationId: installation.installationId,
        installationDigest: installation.manifest.installationDigest,
        programDigest: installation.manifest.program.programDigest,
      };
    },
    resolve: (target) => {
      if (
        target.interactionId !== options.interaction.interactionId ||
        target.contractDigest !== options.interaction.contractDigest ||
        target.controlDigest !== control.controlDigest ||
        target.controlRealizationDigest !== hook.realizationDigest ||
        target.executionRealizationId !== "folio:publish:execute:1"
      ) throw new Error("Publication realization changed");
      return {
        target,
        hook: control.hook,
        parseInput: (value) => PublishInput.parse(value),
        parseState: (value) => Snapshot.parse(value),
        parsePreview: (value) => Published.parse(value),
        parseOutput: (value) => Published.parse(value),
      };
    },
  }, scope);
  async function view(context: DemoContext): Promise<PublicationView> {
    assertPublicationScope(context);
    const proposals = await journal.queryProposals({ scope, limit: 50 });
    const rows = await Promise.all(proposals.map(async (proposal) => {
      const attempt = await journal.findAttemptByProposalDigest(
        proposal.proposalDigest,
      );
      const receipt = await journal.findReceiptByProposalDigest(
        proposal.proposalDigest,
      );
      return {
        id: proposal.id,
        digest: proposal.proposalDigest,
        ...Published.parse(proposal.preview),
        state: receipt
          ? "completed"
          : attempt
          ? attempt.execution === "started" ? "uncertain" : attempt.execution
          : "needs-review",
        requestedBy: proposal.requestedBy,
      };
    }));
    const row = latest();
    return PublicationStatus.parse({
      published: row ? JSON.parse(row.snapshot) : null,
      proposals: rows,
    });
  }
  async function review(
    id: string,
    digest: string,
    context: DemoContext,
    reconcileOnly = false,
  ) {
    assertPublicationScope(context);
    const actor = publicationActor(context);
    if (!actor.human) {
      throw new Error("Only Alice can approve or reconcile a publication");
    }
    const proposal = await journal.getProposal(id);
    if (
      !proposal || proposal.subject.kind !== scope.tenant.kind ||
      proposal.subject.id !== scope.tenant.id ||
      proposal.proposalDigest !== digest
    ) throw new Error("Publication review no longer matches");
    const attempt = await journal.findAttemptByProposalDigest(
      proposal.proposalDigest,
    );
    if (attempt) await capabilities.admin.reconcile(attempt.id, actor, context);
    else if (reconcileOnly) {
      throw new Error("No publication attempt exists to reconcile");
    } else {
      await capabilities.admin.approve(id, actor);
      const grant = await capabilities.admin.grant(id, actor);
      await capabilities.admin.execute(grant, actor, context);
    }
    return view(context);
  }
  return {
    control,
    requester: capabilities.requester,
    view,
    review,
    close: () => journal.close(),
  };
}
