// Execute only through a separately installed public SDK graph.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { z } from "zod";
import {
  admitWhen, bindProjection, compileInteractions, defineInteraction,
  directRealizationIds, implementInteractions, installInteractions,
  projectAllDirect, publishExecutionEvidence,
} from "@foxworth/boundary";
import { createHandoffInvocation, validateHandoffResponse, validateProjectionBindingManifest } from "@foxworth/boundary/handoff";
import { createProtocolHandler, fetchTransport } from "@foxworth/boundary/http";
import { toFetchRequest, sendFetchResponse } from "@foxworth/boundary/http/node";
import {
  contractChanges, contractCompatibility, digestInteractionContract,
  validateExecutionEvidence, validateSchemaValue,
} from "@foxworth/boundary/program";
import { compileZodSchema } from "@foxworth/boundary/program/zod";

const before = { version: 1, id: "labels.write", inputSchema: compileZodSchema(z.string(), "input", "before").contract, outputSchema: {}, reads: [], changes: ["labels"] };
const after = { ...before, inputSchema: compileZodSchema(z.string().nullable(), "input", "after").contract };
assert.equal(await digestInteractionContract(before), "sha256:15600a2afed8b7e38c639ad9037bd364773e122abf94129b25af34a5624affdd");
assert.equal(await digestInteractionContract(after), "sha256:aee2fd0d822ad26dc62e07bd795d75a6631460fd6ca2cbb767c33a772ca74fa4");
assert.equal(contractChanges(before, after).existingCallers.compatible, true);
assert.equal(contractCompatibility(after, before).compatible, false);
assert.equal(validateSchemaValue(after.inputSchema, null).length, 0);
const bounded = compileZodSchema(z.array(z.string().min(2)).min(1).max(2).nullable(), "input", "bounded").contract;
assert.equal(validateSchemaValue(bounded, null).length, 0);
assert.ok(validateSchemaValue(bounded, ["a"]).length > 0);
assert.ok(validateSchemaValue(bounded, ["aa", "bb", "cc"]).length > 0);

let started = 0, statusReads = 0;
const observations = [];
// Native retained subject/attempt/receipt identities remain host-owned.
const retained = { subjectId: "run-1", attemptId: "attempt-1", receiptId: "receipt-1", state: "pending" };
const interactions = {
  start: defineInteraction({ id: "runs.start", input: z.strictObject({}), output: z.strictObject({ runId: z.string() }), changes: ["runs"] }),
  status: defineInteraction({ id: "runs.status", input: z.strictObject({}), output: z.strictObject({ runId: z.string(), state: z.literal("uncertain") }), reads: ["runs"] }),
};
const compiled = compileInteractions(interactions);
const installed = installInteractions(compiled, {
  installationId: "evidence-fixture-owner",
  realizationIds: directRealizationIds(compiled, "evidence-fixture-v1"),
  implementations: implementInteractions(interactions, {
    start() { started += 1; retained.state = "uncertain"; throw new Error("host fixture: external work may have started; response unavailable"); },
    status() { statusReads += 1; return { runId: retained.subjectId, state: retained.state }; },
  }),
});
const projection = projectAllDirect(compiled);
const bound = bindProjection(projection, installed.installation, {
  admit: admitWhen(context => context.principal === "owner", "fixture owner"),
  observation: { publish(observation) { observations.push(observation); } },
});
assert.equal(bound.status, "bound");
const handler = createProtocolHandler({ binding: bound.binding, path: "/handoff", context: () => ({ principal: "owner" }) });
const server = createServer((request, response) => {
  Promise.resolve(handler(toFetchRequest(request))).then(result => sendFetchResponse(response, result, request.method)).catch(error => {
    response.statusCode = 500;
    response.end(String(error));
  });
});
try {
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(new Error(["EPERM", "EACCES"].includes(error.code) ? "BLOCKED packed evidence proof: loopback socket unavailable" : error.message)));
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const transport = fetchTransport({ baseUrl: `http://127.0.0.1:${address.port}/handoff` });
  const manifest = validateProjectionBindingManifest(await transport.inspect());
  const invoke = async id => {
    const invocation = await createHandoffInvocation(manifest, id, "direct", {});
    return validateHandoffResponse(manifest, invocation, await transport.invoke(invocation));
  };
  const start = await invoke("runs.start");
  assert.equal(start.certainty, "unknown");
  const status = await invoke("runs.status");
  assert.equal(status.certainty, "completed");
  assert.equal(status.result.kind, "returned");
  assert.equal(observations.length, 2);
  const startEvidence = validateExecutionEvidence({
    version: 1,
    reference: { kind: "evidence", namespace: "fixture-owner", id: "event-start-1" },
    invocation: { reference: { kind: "invocation", namespace: "fixture-owner", id: "start-1" }, observation: observations[0] },
    subject: { reference: { kind: "subject", namespace: "fixture-owner", id: retained.subjectId }, state: retained.state },
    attempt: { kind: "attempt", namespace: "fixture-owner", id: retained.attemptId },
  });
  const evidence = validateExecutionEvidence({
    version: 1,
    reference: { kind: "evidence", namespace: "fixture-owner", id: "event-status-1" },
    invocation: { reference: { kind: "invocation", namespace: "fixture-owner", id: "status-1" }, observation: observations[1] },
    subject: { reference: { kind: "subject", namespace: "fixture-owner", id: status.result.value.runId }, state: status.result.value.state },
    parents: [startEvidence.reference],
    attempt: startEvidence.attempt,
    receipt: { kind: "receipt", namespace: "fixture-owner", id: retained.receiptId },
  });
  let deliveries = 0;
  const result = await publishExecutionEvidence({ publish(delivered) { deliveries += 1; assert.equal(delivered.subject.state, "uncertain"); throw new Error("delivery unavailable"); } }, evidence);
  assert.equal(result.status, "delivery-failed");
  assert.equal(result.evidence.invocation.observation.certainty, "completed");
  assert.equal(result.evidence.subject.state, "uncertain");
  assert.equal(result.evidence.parents[0].id, startEvidence.reference.id);
  assert.equal(Object.isFrozen(result.evidence.invocation.observation), true);
  assert.equal(deliveries, 1);
  assert.equal(started, 1);
  assert.equal(statusReads, 1);
  assert.throws(() => validateExecutionEvidence({ ...evidence, children: evidence.parents }));
  assert.throws(() => validateExecutionEvidence({ ...evidence, readScope: { token: "private" } }));
  console.log("packed causal evidence: real localhost Handoff, unknown start/completed read/uncertain subject, exact nullable migration, no replay");
} finally {
  bound.controller.revoke();
  installed.controller.revoke();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
