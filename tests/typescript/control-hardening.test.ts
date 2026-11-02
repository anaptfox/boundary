import { describe, expect, it } from "vitest";
import {
  validateSchemaValue,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from "../../packages/core/program/index";
import {
  CONTROL_REALIZATION_DOMAIN,
  PUBLIC_PROPOSAL_SCHEMA,
  digestControlRealization,
  normalizePublicProposal,
  validateControlHook,
  type ControlHook,
  type PublicProposal,
} from "../../packages/core/control/index";

const digest = (value: string): Sha256Digest =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

const targetIdentity = Object.freeze({
  bindingDigest: digest("5"),
  projectionDigest: digest("6"),
  installationId: "installation:documents:1",
  installationDigest: digest("7"),
  expectedProgramDigest: digest("8"),
  actualProgramDigest: digest("8"),
  programDigest: digest("2"),
  controlDigest: digest("3"),
  interactionId: "documents.replace",
  expectedContractDigest: digest("9"),
  contractDigest: digest("4"),
  requestRealizationId: "realization:documents.replace:request:1",
  executionRealizationId: "realization:documents.replace:execute:1",
  controlRealizationDigest: digest("a"),
});

function hook(realizationDigest = digest("a")): ControlHook {
  return {
    realizationDigest,
    state: {},
    preview: {},
    plan: () => ({
      subject: { kind: "document", id: "doc-1" },
      baseline: { revision: 1 },
      baselineSummary: "document revision 1",
      effects: [
        { kind: "filesystem", action: "write", resource: "docs/doc-1" },
      ],
      state: { revision: 1 },
      preview: { title: "Replace doc-1" },
    }),
    apply: () => ({ ok: true }),
    verify: () => ({ ok: true }),
    reconcile: () => ({ status: "uncertain" }),
  };
}

const compiler = {
  compileSchema(schema: unknown) {
    return { contract: schema as JsonObject };
  },
};

function publicProposal(): PublicProposal {
  return {
    version: 1,
    id: "proposal-1",
    proposalDigest: digest("1"),
    ...targetIdentity,
    requestedBy: "author-1",
    subject: { kind: "document", id: "doc-1" },
    baselineSummary: "document revision 1",
    effects: [
      {
        kind: "filesystem",
        action: "write",
        resource: "docs/doc-1",
        description: "Replace document",
        details: { expectedRevision: 1 },
      },
    ],
    preview: { title: "Replace doc-1" },
    createdAt: 1_000,
  };
}

describe("control realization identity", () => {
  it("binds the artifact-supplied realization digest into control identity", async () => {
    const identity = {
      interactionId: "documents.replace",
      contractDigest: digest("c"),
    };
    const first = await digestControlRealization(
      compiler,
      identity,
      hook(digest("a")),
    );
    const second = await digestControlRealization(
      compiler,
      identity,
      hook(digest("b")),
    );

    expect(CONTROL_REALIZATION_DOMAIN).toBe("boundary.control-realization/v1");
    expect(first.controlDigest).not.toBe(second.controlDigest);
    expect(first.hook.realizationDigest).toBe(digest("a"));
    expect(second.hook.realizationDigest).toBe(digest("b"));
  });

  it.each([
    ["missing", undefined],
    ["malformed", "sha256:not-a-digest"],
  ])("rejects a %s realization digest", (_label, realizationDigest) => {
    const candidate = hook() as unknown as Record<string, unknown>;
    if (realizationDigest === undefined) {
      delete candidate["realizationDigest"];
    } else {
      candidate["realizationDigest"] = realizationDigest;
    }

    expect(() => validateControlHook(candidate, "documents.replace.control"))
      .toThrowError(expect.objectContaining({
        code: "CONTROL_INVALID_REALIZATION",
      }));
  });

  it("requires realizationDigest to be an enumerable data property", () => {
    const candidate = hook() as unknown as Record<string, unknown>;
    Object.defineProperty(candidate, "realizationDigest", {
      value: digest("a"),
      enumerable: false,
    });

    expect(() => validateControlHook(candidate, "documents.replace.control"))
      .toThrowError(expect.objectContaining({
        code: "CONTROL_INVALID_REALIZATION",
        path: "documents.replace.control.realizationDigest",
      }));
  });

  it("snapshots compiled schemas before a hash await can observe mutations", async () => {
    const stateContract = {
      type: "object",
      properties: { revision: { type: "number" } },
    };
    const previewContract = {
      type: "object",
      properties: { title: { type: "string" } },
    };
    let compilation = 0;
    const mutatingCompiler = {
      compileSchema() {
        compilation += 1;
        const contract = compilation === 1 ? stateContract : previewContract;
        queueMicrotask(() => {
          contract.properties = { forged: { type: "boolean" } } as never;
        });
        return { contract };
      },
    };

    const resolved = await digestControlRealization(
      mutatingCompiler,
      {
        interactionId: "documents.replace",
        contractDigest: digest("c"),
      },
      hook(),
    );

    expect(resolved.stateSchema).toEqual({
      type: "object",
      properties: { revision: { type: "number" } },
    });
    expect(resolved.previewSchema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
    });
    expect(Object.isFrozen(resolved.stateSchema)).toBe(true);
    expect(Object.isFrozen(resolved.stateSchema.properties)).toBe(true);
    expect(Object.isFrozen(resolved.previewSchema)).toBe(true);
    expect(Object.isFrozen(resolved.previewSchema.properties)).toBe(true);
  });

  it.each([
    ["interaction id", { interactionId: "documents replace", contractDigest: digest("c") }],
    [
      "contract digest",
      { interactionId: "documents.replace", contractDigest: "sha256:invalid" },
    ],
  ])("rejects a malformed control %s", async (_label, identity) => {
    await expect(
      digestControlRealization(compiler, identity as never, hook()),
    ).rejects.toMatchObject({
      code: "CONTROL_INVALID_REALIZATION",
    });
  });
});

describe("control public proposal contract", () => {
  it("normalizes one exact portable public proposal using the exported schema", () => {
    const source = publicProposal();
    const normalized = normalizePublicProposal(source, "handoff.proposal");

    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.effects)).toBe(true);
    expect(
      validateSchemaValue(
        PUBLIC_PROPOSAL_SCHEMA,
        normalized as unknown as JsonValue,
        "handoff.proposal",
      ),
    ).toEqual([]);
  });

  it.each([
    ["unknown-version record", { version: 99 }],
    ["blank id", { id: " " }],
    ["invalid interaction id", { interactionId: "documents replace" }],
    ["blank actor", { requestedBy: "\t" }],
    ["blank subject", { subject: { kind: "document", id: " " } }],
    ["blank summary", { baselineSummary: " " }],
    ["zero effects", { effects: [] }],
    ["extra field", { authority: "forged" }],
  ])("rejects a %s", (_label, replacement) => {
    expect(() =>
      normalizePublicProposal(
        { ...publicProposal(), ...replacement },
        "handoff.proposal",
      ),
    ).toThrowError(expect.objectContaining({
      code: "CONTROL_INVALID_RECORD",
    }));
  });
});
