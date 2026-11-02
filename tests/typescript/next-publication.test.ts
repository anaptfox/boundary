import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alice,
  createPublicationFixture,
  editor,
  foreignWorkspace,
  publishedPreview,
} from "./helpers/nextPublicationFixture";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");

describe("Folio publication Control", () => {
  it("creates a request-only proposal without publishing", async () => {
    const fixture = await createPublicationFixture();
    try {
      const proposal = await fixture.request(alice);
      const view = await fixture.publication.view(alice);
      expect(view.published).toBeNull();
      expect(view.proposals).toEqual([
        expect.objectContaining({
          id: proposal.id,
          digest: proposal.proposalDigest,
          state: "needs-review",
          revision: 7,
        }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it("does not let an agent approve its requested publication", async () => {
    const fixture = await createPublicationFixture();
    try {
      const proposal = await fixture.request(editor);
      await expect(
        fixture.publication.review(
          proposal.id,
          proposal.proposalDigest,
          editor,
        ),
      ).rejects.toThrow("Only Alice");
      expect((await fixture.publication.view(alice)).published).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("blocks review when Alice loses current edit authority after requesting", async () => {
    const fixture = await createPublicationFixture();
    try {
      const proposal = await fixture.request(alice);
      const revokedAlice = { ...alice, canEdit: false } as const;
      await expect(
        fixture.publication.review(
          proposal.id,
          proposal.proposalDigest,
          revokedAlice,
        ),
      ).rejects.toThrow("Only Alice");
      expect((await fixture.publication.view(alice)).proposals).toEqual([
        expect.objectContaining({ state: "needs-review" }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it("denies a foreign delegated workspace before proposal creation", async () => {
    const fixture = await createPublicationFixture();
    try {
      await expect(fixture.request(foreignWorkspace)).rejects.toMatchObject({
        cause: "denied",
        certainty: "not-started",
      });
      expect((await fixture.publication.view(alice)).proposals).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("rejects a stale expected revision without publishing", async () => {
    const fixture = await createPublicationFixture();
    try {
      await expect(fixture.request(alice, 6)).rejects.toMatchObject({
        certainty: "not-started",
      });
      expect((await fixture.publication.view(alice)).published).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("publishes only Alice's exact reviewed digest and does not replay duplicate review", async () => {
    let effects = 0;
    const fixture = await createPublicationFixture({
      afterEffect: () => {
        effects += 1;
      },
    });
    try {
      const proposal = await fixture.request(alice);
      const first = await fixture.publication.review(
        proposal.id,
        proposal.proposalDigest,
        alice,
      );
      expect(first.published).toEqual(publishedPreview);
      expect(first.proposals).toEqual([
        expect.objectContaining({ ...publishedPreview, state: "completed" }),
      ]);
      expect(effects).toBe(1);
      await fixture.publication.review(
        proposal.id,
        proposal.proposalDigest,
        alice,
      );
      expect(effects).toBe(1);
      expect((await fixture.publication.view(alice)).published).toEqual(
        first.published,
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects a substituted digest before any approval or effect", async () => {
    const fixture = await createPublicationFixture();
    try {
      const proposal = await fixture.request(alice);
      await expect(
        fixture.publication.review(
          proposal.id,
          `sha256:${"0".repeat(64)}`,
          alice,
        ),
      ).rejects.toThrow("no longer matches");
      const view = await fixture.publication.view(alice);
      expect(view.published).toBeNull();
      expect(view.proposals[0]?.state).toBe("needs-review");
    } finally {
      fixture.close();
    }
  });

  it("does not publish an old request after the saved document changes", async () => {
    let effects = 0;
    const fixture = await createPublicationFixture({
      afterEffect() {
        effects += 1;
      },
    });
    try {
      const proposal = await fixture.request(alice);
      fixture.replaceDocument({
        ...fixture.document(),
        revision: 8,
        body: "A newly saved draft.",
      });
      await expect(
        fixture.publication.review(proposal.id, proposal.proposalDigest, alice),
      ).rejects.toThrow();
      expect((await fixture.publication.view(alice)).published).toBeNull();
      expect(effects).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("survives process death after effect, restores exact identities, and reconciles once", async () => {
    let clock = 100;
    const before = await createPublicationFixture({ now: () => clock });
    try {
      const proposal = await before.request(alice);
      const child = spawnSync(process.execPath, [
        "--import",
        tsxLoader,
        resolve("tests/typescript/helpers/nextPublicationCrashChild.ts"),
        before.database,
        proposal.id,
        proposal.proposalDigest,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(child.signal, child.stderr).toBe("SIGKILL");
      before.release();
      clock = 2_000;
      const recovered = await createPublicationFixture({
        database: before.database,
        now: () => clock,
      });
      try {
        const uncertain = await recovered.publication.view(alice);
        expect(uncertain.proposals).toEqual([
          expect.objectContaining({
            id: proposal.id,
            digest: proposal.proposalDigest,
            state: "uncertain",
          }),
        ]);
        const complete = await recovered.publication.review(
          proposal.id,
          proposal.proposalDigest,
          alice,
          true,
        );
        expect(complete.published).toEqual(publishedPreview);
        expect(complete.proposals).toEqual([
          expect.objectContaining({ state: "completed" }),
        ]);
        await recovered.publication.review(
          proposal.id,
          proposal.proposalDigest,
          alice,
          true,
        );
        expect((await recovered.publication.view(alice)).proposals).toEqual([
          expect.objectContaining({ state: "completed" }),
        ]);
      } finally {
        recovered.publication.close();
      }
    } finally {
      before.close();
    }
  });

  it("reconciles the original durable effect after the working document changes", async () => {
    const before = await createPublicationFixture({ now: () => 100 });
    try {
      const proposal = await before.request(alice);
      const child = spawnSync(process.execPath, [
        "--import",
        tsxLoader,
        resolve("tests/typescript/helpers/nextPublicationCrashChild.ts"),
        before.database,
        proposal.id,
        proposal.proposalDigest,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(child.signal, child.stderr).toBe("SIGKILL");
      before.release();
      let replayed = 0;
      const recovered = await createPublicationFixture({
        database: before.database,
        now: () => 2_000,
        document: {
          id: "doc-1",
          revision: 8,
          title: "Changed after lost reply",
          body: "Current working draft.",
          richText: '{"type":"doc","content":[]}',
        },
        afterEffect() {
          replayed += 1;
        },
      });
      try {
        const result = await recovered.publication.review(
          proposal.id,
          proposal.proposalDigest,
          alice,
          true,
        );
        expect(result.published).toEqual(publishedPreview);
        expect(result.proposals).toEqual([
          expect.objectContaining({ ...publishedPreview, state: "completed" }),
        ]);
        expect(replayed).toBe(0);
      } finally {
        recovered.publication.close();
      }
    } finally {
      before.close();
    }
  });
});
