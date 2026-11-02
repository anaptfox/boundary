import { describe, expect, it } from "vitest";
import {
  acceptDraft,
  authorSurface,
  draftsInteractions,
  isDraftRejectReason,
  proposeDraft,
  proposerSurface,
  rejectDraft,
  runnerSurface,
  type DraftDecision,
  type DraftStore,
} from "../../packages/core/drafts/index";
import { compileInteractions } from "../../packages/core/host/pipeline";
import { DeclaredInteractionError, defineInteraction, InteractionFault } from "../../packages/core/host/index";
import {
  createDraft,
  digestInteractionContract,
  portableSchema,
  type Draft,
  type InteractionContract,
} from "../../packages/core/program/index";

const sampleContract: InteractionContract = Object.freeze({
  version: 1,
  id: "docs.render",
  inputSchema: Object.freeze({
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({ type: "string" }),
  reads: Object.freeze([]),
  changes: Object.freeze([]),
}) as InteractionContract;

async function sampleDraft(proposer = "bot-1"): Promise<Draft> {
  return createDraft({
    contract: sampleContract,
    gap: "no interaction renders a document today",
    proposer,
    createdAt: "2026-09-06T00:00:00Z",
  });
}

function createMemoryDraftStore(): DraftStore & {
  readonly puts: Draft[];
  readonly decisions: DraftDecision[];
} {
  const byDigest = new Map<string, Draft>();
  const puts: Draft[] = [];
  const decisions: DraftDecision[] = [];
  return {
    puts,
    decisions,
    put(draft) {
      puts.push(draft);
      byDigest.set(draft.draftDigest, draft);
    },
    get(draftDigest) {
      return byDigest.get(draftDigest);
    },
    list() {
      return Object.freeze([...byDigest.values()]);
    },
    recordDecision(decision) {
      decisions.push(decision);
    },
  };
}

describe("drafts.propose", () => {
  it("never changes what is declared: repeated proposals of the same draft do not grow list", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();

    const first = await proposeDraft(store, draft);
    expect(first.draftDigest).toBe(draft.draftDigest);
    expect((await store.list()).map((entry) => entry.draftDigest)).toEqual([
      draft.draftDigest,
    ]);

    const second = await proposeDraft(store, draft);
    expect(second.draftDigest).toBe(draft.draftDigest);
    expect((await store.list()).map((entry) => entry.draftDigest)).toEqual([
      draft.draftDigest,
    ]);
    expect(store.decisions).toEqual([]);
  });

  it("rejects a draft whose digest does not match its content", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();
    const tampered = { ...draft, gap: "a different gap entirely" };

    await expect(proposeDraft(store, tampered)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DeclaredInteractionError && error.code === "invalidDraft",
    );
    expect(store.puts).toEqual([]);
  });

  it("reports a draft store failure as a fault, never a silent success", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();
    const failing: DraftStore = {
      ...store,
      put() {
        throw new Error("disk unavailable");
      },
    };

    await expect(proposeDraft(failing, draft)).rejects.toBeInstanceOf(
      InteractionFault,
    );
  });
});

describe("drafts.accept", () => {
  it("returns the accepted contract and its digest without mutating a Program", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();
    await proposeDraft(store, draft);

    const unrelated = defineInteraction({
      id: "docs.list",
      output: portableSchema<readonly string[]>({
        type: "array",
        items: { type: "string" },
      }),
    });
    const compiled = await compileInteractions({ list: unrelated });
    const programBefore = compiled.program;

    const output = await acceptDraft(store, {
      draftDigest: draft.draftDigest,
      decidedBy: "author-1",
      decidedAt: "2026-09-06T01:00:00Z",
    });

    expect(output.contract).toEqual(draft.contract);
    expect(output.contractDigest).toBe(
      await digestInteractionContract(draft.contract),
    );
    expect(compiled.program).toBe(programBefore);
    expect(store.decisions).toEqual([
      {
        status: "accepted",
        draftDigest: draft.draftDigest,
        contractDigest: output.contractDigest,
        decidedBy: "author-1",
        decidedAt: "2026-09-06T01:00:00Z",
      },
    ]);
    // Accepting never touches the draft list itself.
    expect((await store.list()).map((entry) => entry.draftDigest)).toEqual([
      draft.draftDigest,
    ]);
  });

  it("faults instead of silently succeeding when the draft store cannot be read", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();
    await proposeDraft(store, draft);
    const failing: DraftStore = {
      ...store,
      get() {
        throw new Error("connection reset");
      },
    };

    await expect(
      acceptDraft(failing, {
        draftDigest: draft.draftDigest,
        decidedBy: "author-1",
        decidedAt: "2026-09-06T01:00:00Z",
      }),
    ).rejects.toBeInstanceOf(InteractionFault);
  });

  it("reports an unknown draft rather than inventing an acceptance", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();

    await expect(
      acceptDraft(store, {
        draftDigest: draft.draftDigest,
        decidedBy: "author-1",
        decidedAt: "2026-09-06T01:00:00Z",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DeclaredInteractionError && error.code === "draftNotFound",
    );
  });
});

describe("drafts.reject", () => {
  it("requires a reason from the closed set", async () => {
    const store = createMemoryDraftStore();
    const draft = await sampleDraft();
    await proposeDraft(store, draft);

    expect(isDraftRejectReason("ordinary-code")).toBe(true);
    expect(isDraftRejectReason("covered-by-existing")).toBe(true);
    expect(isDraftRejectReason("because-i-said-so")).toBe(false);

    await expect(
      rejectDraft(store, {
        draftDigest: draft.draftDigest,
        reason: "because-i-said-so",
        decidedBy: "author-1",
        decidedAt: "2026-09-06T01:00:00Z",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DeclaredInteractionError && error.code === "invalidReason",
    );
    expect(store.decisions).toEqual([]);

    const output = await rejectDraft(store, {
      draftDigest: draft.draftDigest,
      reason: "covered-by-existing",
      decidedBy: "author-1",
      decidedAt: "2026-09-06T01:00:00Z",
    });
    expect(output).toEqual({
      draftDigest: draft.draftDigest,
      reason: "covered-by-existing",
    });
    expect(store.decisions).toEqual([
      {
        status: "rejected",
        draftDigest: draft.draftDigest,
        reason: "covered-by-existing",
        decidedBy: "author-1",
        decidedAt: "2026-09-06T01:00:00Z",
      },
    ]);
  });
});

describe("Draft CompiledSurface presets", () => {
  it("expose exactly the authority they claim and nothing more", async () => {
    const compiled = await compileInteractions(draftsInteractions);

    const proposer = await proposerSurface(compiled);
    expect(Object.keys(proposer.handles)).toEqual(["propose"]);
    expect(proposer.handles.propose.modes).toEqual(["direct"]);

    const author = await authorSurface(compiled);
    expect(Object.keys(author.handles).sort()).toEqual(["accept", "reject"]);
    expect(author.handles.accept.modes).toEqual(["request"]);
    expect(author.handles.reject.modes).toEqual(["request"]);

    const runner = await runnerSurface(compiled);
    expect(Object.keys(runner.handles)).toEqual([]);
    expect(runner.interactions).toEqual([]);
  });
});

/**
 * A widened contract, self-consistent as its own Draft, filed under a digest
 * a person already approved. Verifying the stored Draft alone would pass,
 * because it really is a valid Draft — just not the one that was reviewed.
 *
 * Mirrors `accept_refuses_a_draft_substituted_under_an_approved_digest` in
 * `crates/boundary-core/tests/draft_workflow.rs`.
 */
const widenedContract: InteractionContract = Object.freeze({
  ...sampleContract,
  changes: Object.freeze(["documents", "secrets"]),
}) as InteractionContract;

describe("a decision names a digest, and the content behind it must be that digest", () => {
  async function storeWithSubstitution(): Promise<{
    store: DraftStore & { readonly decisions: DraftDecision[] };
    approvedDigest: string;
  }> {
    const approved = await sampleDraft();
    const substituted = await createDraft({
      contract: widenedContract,
      gap: "no interaction renders a document today",
      proposer: "bot-1",
      createdAt: "2026-09-06T00:00:00Z",
    });
    expect(substituted.draftDigest).not.toBe(approved.draftDigest);

    const store = createMemoryDraftStore();
    await proposeDraft(store, approved);
    // The store is host-supplied; this is any writer with access to it.
    const base = store.get.bind(store);
    const swapped: DraftStore & { readonly decisions: DraftDecision[] } = {
      ...store,
      get(draftDigest: `sha256:${string}`) {
        return draftDigest === approved.draftDigest
          ? substituted
          : base(draftDigest);
      },
    };
    return { store: swapped, approvedDigest: approved.draftDigest };
  }

  it("accept refuses a draft substituted under an approved digest", async () => {
    const { store, approvedDigest } = await storeWithSubstitution();
    await expect(
      acceptDraft(store, {
        draftDigest: approvedDigest,
        decidedBy: "person",
        decidedAt: "2026-09-06T01:00:00Z",
      }),
    ).rejects.toBeInstanceOf(InteractionFault);
    expect(store.decisions).toEqual([]);
  });

  it("reject refuses one too", async () => {
    const { store, approvedDigest } = await storeWithSubstitution();
    await expect(
      rejectDraft(store, {
        draftDigest: approvedDigest,
        reason: "ordinary-code",
        decidedBy: "person",
        decidedAt: "2026-09-06T01:00:00Z",
      }),
    ).rejects.toBeInstanceOf(InteractionFault);
    expect(store.decisions).toEqual([]);
  });
});
