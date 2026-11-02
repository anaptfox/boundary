import { describe, expect, it } from "vitest";
import { portableSchema } from "../../packages/core/program/index";
import { assessSurface, bindSurface, compileInteractions, implementInteractions, installInteractions, projectSurface, realizationIdsFor } from "../../packages/core/host/pipeline";
import { defineInteraction, surface } from "../../packages/core/host/index";

async function fixture(type: "string" | "number" = "string") {
  const definitions = { read: defineInteraction({
    id: "items.read", input: portableSchema({ type }), output: portableSchema({ type }),
    reads: ["items"], changes: [],
  }) };
  const compiled = await compileInteractions(definitions);
  const projection = await projectSurface(compiled, surface.all(definitions));
  const installed = await installInteractions(compiled, {
    installationId: "candidate:1",
    implementations: implementInteractions(definitions, { read: (value) => value }),
    realizationIds: realizationIdsFor(compiled, "v1"),
  });
  return { projection, ...installed };
}

describe("candidate CompiledSurface assessment", () => {
  it("reports fit without implying a live Binding or admission", async () => {
    const { projection, installation } = await fixture();
    const report = assessSurface(projection.manifest, installation.manifest);
    expect(report).toEqual({ status: "fit", issues: [], missingEvidence: [
      "artifact-authenticity", "actual-input-arity", "live-revocation", "admission",
    ] });
    expect(Object.isFrozen(report.issues)).toBe(true);
    expect("binding" in report).toBe(false);
    expect((await bindSurface(projection, installation, { admit: () => ({ decision: "deny", reason: "offline-is-not-admission" }) })).status).toBe("bound");
  });

  it("shares incompatibility diagnostics with live binding", async () => {
    const expected = await fixture();
    const actual = await fixture("number");
    const offline = assessSurface(expected.projection.manifest, actual.installation.manifest);
    const live = await bindSurface(expected.projection, actual.installation, { admit: () => ({ decision: "allow" }) });
    expect(offline.status).toBe("mismatch");
    expect(live.status).toBe("unrealized");
    if (live.status === "unrealized") expect(offline.issues).toEqual(live.report.issues);
  });

  it("reports absent interactions and unavailable modes separately", async () => {
    const { projection, installation } = await fixture();
    expect(assessSurface(projection.manifest, {
      ...installation.manifest,
      program: { ...installation.manifest.program, interactions: [] },
      catalog: { ...installation.manifest.catalog, interactions: [] },
    }).issues[0]?.reason).toBe("missing-interaction");
    expect(assessSurface(projection.manifest, {
      ...installation.manifest,
      catalog: { ...installation.manifest.catalog, interactions: [{ interactionId: "items.read" }] },
    }).issues[0]?.reason).toBe("missing-direct");
    const requested = { ...projection.manifest, interactions: projection.manifest.interactions.map((interaction) => ({ ...interaction, modes: ["request" as const] })) };
    expect(assessSurface(requested, installation.manifest).issues[0]?.reason).toBe("missing-request");
  });

  it("keeps live revocation unknown offline, and checks it when binding", async () => {
    const { projection, installation, controller } = await fixture();
    controller.revoke();
    expect(assessSurface(projection.manifest, installation.manifest).status).toBe("fit");
    const live = await bindSurface(projection, installation, { admit: () => ({ decision: "allow" }) });
    expect(live.status).toBe("unrealized");
    if (live.status === "unrealized") expect(live.report.issues[0]?.reason).toBe("installation-revoked");
  });

  it("rejects malformed and duplicate candidate evidence before assessment", async () => {
    const { projection, installation } = await fixture();
    const selection = projection.manifest.interactions[0]!;
    expect(() => assessSurface({ ...projection.manifest, interactions: [selection, selection] }, installation.manifest)).toThrow();
    expect(() => assessSurface({ ...projection.manifest, interactions: [selection, { ...selection, alias: "other" }] }, installation.manifest)).toThrow();
    expect(() => assessSurface({ ...projection.manifest, interactions: [{ ...selection, modes: ["bogus"] }] } as never, installation.manifest)).toThrow();
    const descriptor = installation.manifest.program.interactions[0]!;
    expect(() => assessSurface(projection.manifest, { ...installation.manifest,
      program: { ...installation.manifest.program, interactions: [descriptor, descriptor] },
    })).toThrow();
    const entry = installation.manifest.catalog.interactions[0]!;
    expect(() => assessSurface(projection.manifest, { ...installation.manifest,
      catalog: { ...installation.manifest.catalog, interactions: [entry, entry] },
    })).toThrow();
    expect(() => assessSurface(projection.manifest, { ...installation.manifest,
      program: { ...installation.manifest.program, interactions: [{ ...descriptor,
        contract: { ...descriptor.contract, inputSchema: { format: "unsupported" } },
      }] },
    })).toThrow();
  });

});
