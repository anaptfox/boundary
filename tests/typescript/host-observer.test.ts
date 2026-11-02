import { expect, it } from "vitest";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectSurface, realizationIdsFor } from "../../packages/core/host/pipeline";
import { defineInteraction, surface } from "../../packages/core/host/index";
import { portableSchema, type InvocationObservation } from "../../packages/core/program/index";

it("pins observer methods to their original receiver and isolates publication failure", async () => {
  const calls: InvocationObservation[] = [];
  class Observer {
    #sink = calls;
    #label = "host-session";
    correlate(context: { run: number }) { return { label: this.#label, run: context.run }; }
    publish(event: InvocationObservation) { this.#sink.push(event); throw new Error("delivery failed after record"); }
  }
  const observer = new Observer();
  const interactions = { read: defineInteraction({ id: "observer.read", output: portableSchema<string>({ type: "string" }) }) };
  const compiled = await compileInteractions(interactions);
  const projection = await projectSurface(compiled, surface.all(interactions));
  const installed = await installInteractions(compiled, {
    installationId: "observer:test", realizationIds: realizationIdsFor(compiled, "v1"),
    implementations: implementInteractions<typeof interactions, { run: number }>(interactions, { read: () => "returned" }),
  });
  const bound = await bindSurface(projection, installed.installation, { admit: () => ({ decision: "allow" }), observation: observer });
  if (bound.status !== "bound") throw new Error("missing binding");
  observer.publish = () => { throw new Error("replacement must not be used"); };
  await expect(bound.binding.connect().call(projection.handles.read, { run: 7 })).resolves.toBe("returned");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.correlation).toEqual({ label: "host-session", run: 7 });
});
