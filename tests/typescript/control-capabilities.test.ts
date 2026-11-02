import { compositionTransport } from "./composition-transport";
import { describe, expect, it } from "vitest";
import { createProjectionClient } from "../../packages/callers/client/client";
import { createProtocolHandler } from "../../packages/adapters/http/protocol";
import {
  createControlCapabilities,
  createControlReader,
  digestControlRealization,
  normalizePublicProposal,
  type ControlHook,
  type ControlHost,
  type ControlJournal,
  type ControlPolicy,
  type ControlTarget,
} from "../../packages/core/control/index";
import {
  contributeControlRequests,
} from "../../packages/core/control/host";
import { MemoryJournal, TestClock } from "../../packages/core/control/testing";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
  type InteractionInstallation,
} from "../../packages/core/host/index";
import {
  portableSchema,
  type JsonObject,
  type Sha256Digest,
} from "../../packages/core/program/index";
import { createCaller } from "@foxworth/boundary/pipeline";

const digest = (character: string): Sha256Digest =>
  `sha256:${character.repeat(64)}`;

type Actor = { readonly id: string };
type Context = { readonly tenant: string };
type Input = { readonly body: string };
type Output = { readonly published: string };

const target: ControlTarget = Object.freeze({
  bindingDigest: digest("6"),
  projectionDigest: digest("7"),
  installationId: "installation:control:2",
  installationDigest: digest("1"),
  expectedProgramDigest: digest("8"),
  actualProgramDigest: digest("8"),
  programDigest: digest("2"),
  interactionId: "articles.publish",
  expectedContractDigest: digest("9"),
  contractDigest: digest("3"),
  requestRealizationId: "realization:publish:request:2",
  executionRealizationId: "realization:publish:execute:2",
  controlRealizationDigest: digest("4"),
  controlDigest: digest("5"),
});

const readerScope = Object.freeze({
  interactionIds: Object.freeze([target.interactionId]),
  tenant: Object.freeze({ kind: "article", id: "article-1" }),
});

const hook: ControlHook<Input, Output, { before: string }, { title: string }, JsonObject, JsonObject, Context> = {
  realizationDigest: target.controlRealizationDigest,
  state: { type: "object" },
  preview: { type: "object" },
  plan: ({ input, context }) => ({
    subject: { kind: "article", id: context.tenant },
    baseline: { published: false },
    baselineSummary: "not published",
    effects: [{ kind: "publish", action: "create", resource: input.body }],
    state: { before: input.body },
    preview: { title: input.body },
  }),
  apply: ({ input }) => ({ published: input.body }),
  verify: () => ({ ok: true }),
  reconcile: () => ({ status: "uncertain" }),
};

const allow: ControlPolicy<Actor> = {
  identify: (actor) => actor.id,
  request: () => ({ allow: true }),
  approve: () => ({ allow: true }),
  grant: () => ({ allow: true }),
  execute: () => ({ allow: true }),
  reconcile: () => ({ allow: true }),
  preflight: () => undefined,
};

function host(): ControlHost<Context> {
  return {
    inspect: () => ({
      installationId: target.installationId,
      installationDigest: target.installationDigest,
      programDigest: target.programDigest,
    }),
    resolve: (requested) => ({
      target: requested,
      hook,
      parseInput: (value) => value,
      parseState: (value) => value,
      parsePreview: (value) => value,
      parseOutput: (value) => value,
    }),
  };
}

describe("Control capabilities", () => {
  it("separates request, observation, and administration while preserving lifecycle", async () => {
    const journal = new MemoryJournal();
    const capabilities = createControlCapabilities(
      {
        journal,
        policy: allow,
        clock: new TestClock(100),
        executor: { owner: "executor-1" },
      },
      host(),
      readerScope,
    );
    expect(Object.keys(capabilities.requester)).toEqual(["request"]);
    expect(Object.keys(capabilities.reader).sort()).toEqual(["get", "list", "page", "status"]);
    expect(Object.keys(capabilities.admin).sort()).toEqual([
      "approve",
      "execute",
      "grant",
      "reconcile",
    ]);

    const proposal = await capabilities.requester.request({
      actor: { id: "requester" },
      context: { tenant: "article-1" },
      target,
      input: { body: "Ship it" },
    });
    expect(proposal).toMatchObject({
      version: 1,
      installationId: target.installationId,
      installationDigest: target.installationDigest,
      requestRealizationId: target.requestRealizationId,
      executionRealizationId: target.executionRealizationId,
      controlRealizationDigest: target.controlRealizationDigest,
    });
    expect(() =>
      normalizePublicProposal({ ...proposal, version: 99 }, "proposal"),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_INVALID_RECORD" }));
    const observed = await capabilities.reader.get({
      kind: "proposal",
      id: proposal.id,
    });
    expect(observed).toEqual(proposal);
    expect(observed).not.toHaveProperty("input");
    expect(observed).not.toHaveProperty("state");

    const approval = await capabilities.admin.approve(proposal, { id: "reviewer" });
    const grant = await capabilities.admin.grant(proposal, { id: "owner" });
    await expect(
      capabilities.admin.execute(
        grant,
        { id: "executor" },
        { tenant: "article-1" },
      ),
    ).resolves.toMatchObject({
      status: "completed",
      value: { published: "Ship it" },
      receipt: { version: 1, installationId: target.installationId },
    });

    const hostileJournal = new Proxy(journal, {
      get(source, property) {
        if (property === "getApproval") {
          return async () => ({ ...approval, version: 99 });
        }
        const value = Reflect.get(source, property, source) as unknown;
        return typeof value === "function" ? value.bind(source) : value;
      },
    }) as ControlJournal;
    const hostileReader = createControlReader(
      { journal: hostileJournal },
      readerScope,
    );
    await expect(
      hostileReader.get({ kind: "approval", id: approval.id }),
    ).rejects.toMatchObject({ code: "CONTROL_INVALID_RECORD" });
  });

  it("snapshots interaction and tenant scope and hides every cross-scope lookup as absence", async () => {
    const journal = new MemoryJournal();
    const interactionIds = [target.interactionId];
    const tenant = { kind: "article", id: "tenant-a" };
    const capabilities = createControlCapabilities(
      {
        journal,
        policy: allow,
        clock: new TestClock(100),
        executor: { owner: "executor-scope" },
      },
      host(),
      { interactionIds, tenant },
    );
    const inScope = await capabilities.requester.request({
      actor: { id: "requester" },
      context: { tenant: "tenant-a" },
      target,
      input: { body: "In scope" },
    });
    const otherTenant = await capabilities.requester.request({
      actor: { id: "requester" },
      context: { tenant: "tenant-b" },
      target,
      input: { body: "Other tenant" },
    });
    const otherInteractionTarget = Object.freeze({
      ...target,
      interactionId: "articles.archive",
      requestRealizationId: "realization:archive:request:2",
      executionRealizationId: "realization:archive:execute:2",
    });
    const otherInteraction = await capabilities.requester.request({
      actor: { id: "requester" },
      context: { tenant: "tenant-a" },
      target: otherInteractionTarget,
      input: { body: "Other interaction" },
    });
    const approval = await capabilities.admin.approve(otherTenant, {
      id: "reviewer",
    });
    const grant = await capabilities.admin.grant(otherTenant, { id: "owner" });
    const execution = await capabilities.admin.execute(
      grant,
      { id: "executor" },
      { tenant: "tenant-b" },
    );
    if (execution.status !== "completed") {
      throw new Error("expected cross-scope administrative completion");
    }

    interactionIds.push(otherInteractionTarget.interactionId);
    tenant.id = "tenant-b";

    await expect(
      capabilities.reader.get({ kind: "proposal", id: inScope.id }),
    ).resolves.toEqual(inScope);
    for (const reference of [
      { kind: "proposal", id: otherTenant.id },
      { kind: "proposal", id: otherInteraction.id },
      { kind: "approval", id: approval.id },
      { kind: "grant", id: grant.id },
      { kind: "attempt", id: execution.receipt.attemptId },
      { kind: "receipt", id: execution.receipt.id },
    ] as const) {
      await expect(capabilities.reader.get(reference)).resolves.toBeUndefined();
    }

    const statusDiagnostic = async (proposalId: string) => {
      try {
        await capabilities.reader.status(proposalId);
        throw new Error("expected proposal absence");
      } catch (error) {
        const diagnostic = error as Error & { code?: string; path?: string };
        return {
          code: diagnostic.code,
          path: diagnostic.path,
          message: diagnostic.message,
        };
      }
    };
    await expect(statusDiagnostic(otherTenant.id)).resolves.toEqual(
      await statusDiagnostic("proposal-does-not-exist"),
    );
    await expect(capabilities.reader.list()).resolves.toEqual([
      expect.objectContaining({ proposal: inScope }),
    ]);
    await expect(capabilities.reader.list({
      interactionId: otherInteractionTarget.interactionId,
    })).resolves.toEqual([]);
  });

  it("a narrow remote caller creates and executes a proposal against the full installation", async () => {
    const InputSchema = portableSchema<Input>({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    });
    const OutputSchema = portableSchema<Output>({
      type: "object",
      properties: { published: { type: "string" } },
      required: ["published"],
      additionalProperties: false,
    });
    let applied = 0;
    const definitions = {
      inspect: defineInteraction({ id: "articles.inspect", output: OutputSchema }),
      publish: defineInteraction({
        id: target.interactionId,
        input: InputSchema,
        output: OutputSchema,
      }),
    } as const;
    const compiled = await compileInteractions(definitions);
    const exactControl = await digestControlRealization(
      {
        compileSchema(schema) {
          return { contract: schema as JsonObject };
        },
      },
      {
        interactionId: target.interactionId,
        contractDigest: compiled.handles.publish.contractDigest,
      },
      { ...hook, realizationDigest: target.controlRealizationDigest, apply: ({ input }: { input: Input }) => { applied += 1; return { published: input.body }; } },
    );
    const journal = new MemoryJournal();
    let currentInstallation: InteractionInstallation<Context> | undefined;
    const capabilities = createControlCapabilities<Actor, Context>(
      {
        journal,
        policy: allow,
        clock: new TestClock(100),
        executor: { owner: "executor-1" },
      },
      {
        inspect: () => {
          if (!currentInstallation) {
            throw new Error("control request ran before Host installation");
          }
          return {
            installationId: currentInstallation.installationId,
            installationDigest:
              currentInstallation.manifest.installationDigest,
            programDigest: currentInstallation.manifest.program.programDigest,
          };
        },
        resolve: (requestedTarget) => ({
          target: requestedTarget,
          hook: exactControl.hook,
          parseInput: (value) => value,
          parseState: (value) => value,
          parsePreview: (value) => value,
          parseOutput: (value) => value,
        }),
      },
      readerScope,
    );
    const requester = capabilities.requester;
    let actorReads = 0;
    const requests = contributeControlRequests(compiled, requester, {
      publish: {
        interaction: compiled.handles.publish,
        control: exactControl,
        executionRealizationId: target.executionRealizationId,
        get actor() {
          actorReads += 1;
          return () => ({ id: "requester" });
        },
      },
    });
    const context = { tenant: "article-1" };
    const implementations = implementInteractions<typeof definitions, Context>(
      definitions,
      { publish: (input) => ({ published: input.body }), inspect: () => ({ published: "none" }) },
    );
    const { installation } = await installInteractions<typeof definitions, Context>(
      compiled,
      {
        installationId: target.installationId,
        implementations,
        requests,
        realizationIds: {
          inspect: { direct: "realization:inspect:1" },
          publish: {
            direct: "realization:publish:direct:2",
            request: target.requestRealizationId,
          },
        },
      },
    );
    currentInstallation = installation;
    const projection = await projectInteractions(compiled, {
      publish: {
        interaction: compiled.handles.publish,
        modes: ["request"],
      },
    });
    const bound = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (bound.status !== "bound") throw new Error("control fixture did not bind");
    const handler = createProtocolHandler({ caller: createCaller(bound.binding), path: "/boundary", context: () => context });
    const client = createProjectionClient(await compositionTransport(handler));
    expect((await client.inspect()).interactions.map((op) => op.interactionId)).toEqual(["articles.publish"]);
    const proposal = await client.request(
      projection.handles.publish,
      { body: "Ship it" },
    );
    expect(proposal).toMatchObject({ id: "test-proposal-1", version: 1 });
    const proposalRecord = proposal as unknown as Record<string, unknown>;
    if (
      proposal === null ||
      Array.isArray(proposal) ||
      typeof proposal !== "object" ||
      typeof proposalRecord.id !== "string"
    ) {
      throw new Error("Host request did not return a public proposal");
    }
    expect(actorReads).toBe(1);
    const stored = await journal.getProposal(proposalRecord.id);
    expect(stored).toMatchObject({
      input: { body: "Ship it" },
      subject: { kind: "article", id: context.tenant },
      requestedBy: "requester",
      ...{
        bindingDigest: bound.binding.manifest.bindingDigest,
        projectionDigest: bound.binding.manifest.projectionDigest,
        installationId: installation.installationId,
        installationDigest: installation.manifest.installationDigest,
        expectedProgramDigest: bound.binding.manifest.expectedProgramDigest,
        programDigest: installation.manifest.program.programDigest,
        actualProgramDigest: bound.binding.manifest.actualProgramDigest,
        interactionId: target.interactionId,
        expectedContractDigest:
          bound.binding.manifest.interactions[0]!.expectedContractDigest,
        contractDigest: bound.binding.manifest.interactions[0]!.actualContractDigest,
        requestRealizationId: target.requestRealizationId,
        executionRealizationId: target.executionRealizationId,
      },
    });
    expect(applied).toBe(0);
    await capabilities.admin.approve(proposal as never, { id: "reviewer" });
    const grant = await capabilities.admin.grant(proposal as never, { id: "owner" });
    await expect(capabilities.admin.execute(grant, { id: "executor" }, context)).resolves.toMatchObject({
      status: "completed",
      receipt: { programDigest: compiled.program.programDigest, actualProgramDigest: bound.binding.manifest.actualProgramDigest },
    });
    expect(applied).toBe(1);
    expect(Object.keys(requests)).toEqual([]);
    expect(() =>
      contributeControlRequests(
        compiled,
        { request: requester.request } as never,
        {
          publish: {
            interaction: compiled.handles.publish,
            control: exactControl,
            executionRealizationId: target.executionRealizationId,
            actor: () => ({ id: "requester" }),
          },
        },
      ),
    ).toThrow(/authentic ControlRequester/u);
  });
});
