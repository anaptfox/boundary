// Runs against installed public artifacts, without a framework or source aliases.
// The memory journal and host below are test fixtures, not durable storage.
import { createControlCapabilities } from "@foxworth/boundary/control";
import { MemoryJournal, TestClock } from "@foxworth/boundary/control/testing";

function assert(value, message) {
  if (!value) throw new Error(message);
}

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const target = Object.freeze({
  bindingDigest: digest("6"),
  projectionDigest: digest("7"),
  installationId: "installation:portable:1",
  installationDigest: digest("1"),
  expectedProgramDigest: digest("8"),
  actualProgramDigest: digest("8"),
  programDigest: digest("2"),
  interactionId: "portable.publish",
  expectedContractDigest: digest("9"),
  contractDigest: digest("3"),
  requestRealizationId: "realization:portable:request:1",
  executionRealizationId: "realization:portable:execute:1",
  controlRealizationDigest: digest("4"),
  controlDigest: digest("5"),
});

async function proveControl(loseResponse) {
  let effects = 0;
  const hook = {
    realizationDigest: target.controlRealizationDigest,
    state: { type: "object" },
    preview: { type: "object" },
    plan: ({ input, context }) => ({
      subject: { kind: "document", id: context.document },
      baseline: { published: false },
      baselineSummary: "not published",
      effects: [{ kind: "publish", action: "create", resource: input.body }],
      state: { privateBody: input.body },
      preview: { title: input.body },
    }),
    apply: ({ input }) => {
      effects += 1;
      if (loseResponse) throw new Error("simulated response loss after effect");
      return { published: input.body };
    },
    verify: () => ({ ok: true }),
    reconcile: () => ({ status: "uncertain" }),
  };
  const allow = () => ({ allow: true });
  const capabilities = createControlCapabilities({
    journal: new MemoryJournal(),
    clock: new TestClock(100),
    executor: { owner: "portable-test-executor" },
    policy: {
      identify: (actor) => actor.id,
      request: allow,
      approve: allow,
      grant: allow,
      execute: allow,
      reconcile: allow,
      preflight: () => undefined,
    },
  }, {
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
  }, {
    interactionIds: [target.interactionId],
    tenant: { kind: "document", id: "document-a" },
  });
  const context = { document: "document-a" };
  const proposal = await capabilities.requester.request({
    actor: { id: "agent" }, context, target, input: { body: "Review this" },
  });
  assert(effects === 0, "request applied an effect");
  const publicProposal = await capabilities.reader.get({ kind: "proposal", id: proposal.id });
  assert(publicProposal && !("input" in publicProposal) && !("state" in publicProposal),
    "public proposal exposed private records");
  assert(!("approve" in capabilities.requester) && !("execute" in capabilities.reader),
    "public capabilities contain administration");
  await capabilities.admin.approve(proposal, { id: "reviewer" });
  assert(effects === 0, "approval applied an effect");
  const grant = await capabilities.admin.grant(proposal, { id: "owner" });
  assert(effects === 0, "grant applied an effect");
  const result = await capabilities.admin.execute(grant, { id: "agent" }, context);
  assert(result.status === (loseResponse ? "uncertain" : "completed"),
    "Control changed outcome certainty");
  const repeated = await capabilities.admin.execute(grant, { id: "agent" }, context);
  assert(repeated.status === result.status, "repeated execution changed known evidence");
  assert(effects === 1, "repeated execution reran a possibly-started effect");
}

await proveControl(false);
await proveControl(true);
console.log("portable Control: private/public separation, exact lifecycle, replay and uncertainty passed");
