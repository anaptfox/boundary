import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const isolatedData = await mkdtemp(path.join(tmpdir(), "boundary-next-domains-"));
const previousDataRoot = process.env.BOUNDARY_FOLIO_DATA_DIR;
process.env.BOUNDARY_FOLIO_DATA_DIR = isolatedData;

const { triageCaller } = await import(
  "../../examples/apps/typescript/document-workspace/lib/triage-boundary"
);
const { studioCaller } = await import(
  "../../examples/apps/typescript/document-workspace/lib/studio-boundary"
);

afterAll(async () => {
  if (previousDataRoot === undefined) {
    delete process.env.BOUNDARY_FOLIO_DATA_DIR;
  } else {
    process.env.BOUNDARY_FOLIO_DATA_DIR = previousDataRoot;
  }
  await rm(isolatedData, { recursive: true, force: true });
});

describe("next interactional domain examples", () => {
  it("keeps tenant tickets in separate isolated stores", async () => {
    const acme = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "human" as const,
    }));
    const harbor = triageCaller(() => ({
      tenant: "harbor" as const,
      actor: "human" as const,
    }));
    const created = await acme.action.create({
      title: "Acme-only temporary ticket",
      customer: "Isolated tenant account",
    });
    const harborTickets = await harbor.read.list({},
    );
    expect(harborTickets.map((ticket) => ticket.id)).not.toContain(created.id);
  });

  it("keeps each domain interaction inside its host-derived role", async () => {
    const human = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "human" as const,
    }));
    const delegator = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "delegator" as const,
    }));
    const maker = studioCaller(() => ({ role: "maker" as const }));
    const reviewer = studioCaller(() => ({ role: "reviewer" as const }));
    const inspectInput = {
      id: "acme-401",
      expectedRevision: 1,
      investigator: "signal-lens" as const,
    };
    await expect(
      human.read.inspect(inspectInput),
    ).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    await expect(
      delegator.read.inspect(inspectInput),
    ).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    await expect(
      maker.action.choose({
        id: "candidate-current",
        expectedProjectRevision: 1,
        review: "designated-consequence-reviewed" as const,
      }),
    ).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    await expect(
      reviewer.action.edit({
        id: "candidate-current",
        expectedRevision: 1,
        direction: "A reviewer cannot edit a stored studio candidate.",
      }),
    ).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
  });

  it("persists an exact reviewed triage resolution without live fixture writes", async () => {
    const human = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "human" as const,
    }));
    const created = await human.action.create({
      title: "Temporary billing export failure",
      customer: "Isolated test account",
    });
    const executor = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "executor" as const,
    }));
    const finding = await executor.read.inspect({
      id: created.id,
      expectedRevision: created.revision,
      investigator: "signal-lens",
    });
    const delegator = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "delegator" as const,
    }));
    const investigated = await delegator.action.investigate(finding,
    );
    const reviewer = triageCaller(() => ({
      tenant: "acme" as const,
      actor: "reviewer" as const,
      reviewer: "isolated reviewer fixture",
    }));
    const resolution =
      "Tell the customer that the bounded investigation found the recorded ticket only.";
    const review = await reviewer.action.review({
      id: investigated.id,
      expectedRevision: investigated.revision,
      resolution,
    });
    const replayedReview = await reviewer.action.review({
        id: investigated.id,
        expectedRevision: investigated.revision,
        resolution,
      },
    );
    expect(replayedReview).toEqual(review);
    await expect(reviewer.action.review({
      id: investigated.id,
      expectedRevision: investigated.revision,
      resolution:
        "A conflicting duplicate review must not replace the stored review.",
    })).rejects.toMatchObject({ code: "reviewConflict" });
    await expect(reviewer.action.review({
      id: investigated.id,
      expectedRevision: created.revision,
      resolution: review.resolution,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(reviewer.action.resolve({
      id: investigated.id,
      reviewId: "review-substitution",
    })).rejects.toMatchObject({ code: "reviewMissing" });
    const resolved = await reviewer.action.resolve({
        id: investigated.id,
        reviewId: review.id,
      },
    );
    expect(resolved.resolution).toBe(review.resolution);
    expect(resolved.status).toBe("resolved");
  });

  it("persists studio edit, comparison, choice, and stale choice denial", async () => {
    const maker = studioCaller(() => ({ role: "maker" as const }));
    const created = await maker.action.create({
      name: "Isolated candidate",
      direction:
        "A stored direction created in the isolated temporary test root.",
    });
    const beforeEdit = await maker.read.view({});
    const edited = await maker.action.edit({
      id: created.id,
      expectedRevision: created.revision,
      direction:
        "An edited stored direction used for a real candidate comparison.",
    });
    const comparison = await maker.read.compare({
      leftId: edited.id,
      rightId: "candidate-aurora",
    });
    expect(comparison.left.direction).toBe(edited.direction);
    expect(comparison.contrast).toContain("Isolated candidate");
    const reviewer = studioCaller(() => ({ role: "reviewer" as const }));
    await expect(reviewer.action.choose({
      id: edited.id,
      expectedProjectRevision: beforeEdit.projectRevision,
      review: "designated-consequence-reviewed",
    })).rejects.toMatchObject({ code: "conflict" });
    const current = await maker.read.view({});
    const chosen = await reviewer.action.choose({
      id: edited.id,
      expectedProjectRevision: current.projectRevision,
      review: "designated-consequence-reviewed",
    });
    expect(chosen.chosenCandidateId).toBe(edited.id);
  });
});
