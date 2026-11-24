import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  bindNativeInteractions, bindProjection, compileInteractions, defineInteraction,
  installInteractions, projectInteractions,
} from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
import { createHandoffInvocation, executeHandoff } from "@foxworth/boundary/handoff";
import { createProtocolHandler } from "@foxworth/boundary/http";

// Host-owned single-writer durable fixture. It is not a production journal or crash-safe transaction.
const [phase, journalPath] = process.argv.slice(2);
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : { effects: 0, records: {} };
const persist = () => writeFileSync(journalPath, JSON.stringify(journal));
const StringSchema = portableSchema({ type: "string" });
const definitions = {
  change: defineInteraction({ id: "boundary.change", input: StringSchema, output: StringSchema, changes: ["documents"] }),
  inspect: defineInteraction({ id: "boundary.inspect", output: StringSchema, reads: ["documents"] }),
};
const compiled = compileInteractions(definitions);
const bindings = bindNativeInteractions(compiled, { change: "native-change", inspect: "native-inspect" }, {
  change({ input, target, outcomes }) {
    assert.equal(target, "native-change");
    journal.effects++;
    persist();
    return input === "unknown" ? outcomes.unknown() : outcomes.returned(input);
  },
  inspect({ outcomes }) { return outcomes.returned(String(journal.effects)); },
});
const installed = installInteractions(compiled, {
  installationId: "boundary:e2e:installation", bindings,
  realizationIds: { change: { direct: "boundary:change:direct" }, inspect: { direct: "boundary:inspect:direct" } },
});
const projection = projectInteractions(compiled, {
  change: "direct", inspect: "direct",
});
const explicit = projectInteractions(compiled, { inspect: { interaction: compiled.handles.inspect, modes: ["direct"] } });
assert.equal((projectInteractions(compiled, { inspect: "direct" })).projectionDigest, explicit.projectionDigest);
let hooks = 0;
const observations = [];
const bound = bindProjection(projection, installed.installation, {
  admit: ({ context }) => context.authorized ? { decision: "allow" } : { decision: "deny", reason: "owner required" },
  async coordinate(request, proceed) {
    hooks++;
    const fingerprint = JSON.stringify({ policy: request.policy, input: request.input });
    const retained = journal.records[request.context.requestId];
    if (retained) {
      if (retained.fingerprint !== fingerprint) throw new Error("changed request identity");
      return retained.outcome;
    }
    const outcome = await proceed();
    journal.records[request.context.requestId] = { fingerprint, outcome };
    persist();
    return outcome;
  },
  observation: { publish(event) { observations.push(event); } },
});
assert.equal(bound.status, "bound");
const caller = bound.binding.connect();
const context = requestId => ({ requestId, authorized: true });
const protocol = createProtocolHandler({ binding: bound.binding, path: "/boundary", context: request => ({ requestId: request.headers.get("request-id"), authorized: request.headers.get("principal") === "owner" }) });
async function httpCall(mode, input, requestId, principal = "owner") {
  const invocation = await createHandoffInvocation(bound.binding.manifest, "boundary.change", mode, input);
  const response = await protocol(new Request("https://fixture.invalid/boundary/invoke", {
    method: "POST", headers: { "content-type": "application/json", "request-id": requestId, principal }, body: JSON.stringify(invocation),
  }));
  const outcome = await response.json();
  assert.equal(response.status, outcome.result.kind === "fault" ? 500 : outcome.result.kind === "denied" ? 403 : outcome.result.kind === "proposed" ? 202 : 200);
  return outcome;
}

if (phase === "lost-ack") {
  const outcome = await httpCall("direct", "once", "same-request");
  assert.equal(outcome.certainty, "completed");
  assert.equal(journal.effects, 1);
  // Drop the response after durable retention, then end the process. The next process recovers it.
} else if (phase === "recover") {
  assert.equal(await caller.call(projection.handles.change, "once", context("same-request")), "once");
  assert.equal((await httpCall("direct", "once", "same-request")).certainty, "completed");
  assert.equal(journal.effects, 1);
  assert.equal(observations.length, 2);
  assert.equal((await httpCall("direct", "changed", "same-request")).certainty, "unknown");
  const beforeDenied = hooks;
  assert.equal((await httpCall("direct", "once", "same-request", "other")).result.kind, "denied");
  assert.equal(hooks, beforeDenied);
  const stale = await createHandoffInvocation(bound.binding.manifest, "boundary.change", "direct", "once");
  await assert.rejects(executeHandoff(bound.binding, { ...stale, realizationId: "stale" }, context("same-request")), error => error.code === "STALE_REALIZATION");
  assert.equal(journal.effects, 1);
} else if (phase === "unknown") {
  assert.equal((await httpCall("direct", "unknown", "uncertain-request")).certainty, "unknown");
  assert.equal(journal.effects, 2);
} else if (phase === "recover-unknown") {
  await assert.rejects(caller.call(projection.handles.change, "unknown", context("uncertain-request")), error => error.certainty === "unknown");
  assert.equal((await httpCall("direct", "unknown", "uncertain-request")).certainty, "unknown");
  assert.equal(journal.effects, 2);
} else {
  throw new Error("unknown proof phase");
}
console.log(`Packed Boundary integration phase ${phase} passed; effects=${journal.effects}.`);
