import { compositionTransport } from "./composition-transport";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bindProjection, compileInteractions, defineInteraction, implementInteractions,
  installInteractions, pickProjection, projectAllDirect, projectInteractions,
  directRealizationIds,
  presentProjection,
} from "../../packages/core/host/index";
import { portableSchema, validateInvocationObservation } from "../../packages/core/program/index";
import { createProjectionClient } from "../../packages/callers/client/client";
import { createProtocolHandler } from "../../packages/adapters/http/protocol";
import { pinProjectionReferences } from "../../packages/callers/client/client";
import { renderHostArtifacts } from "../../packages/core/host/build/index";
import { stripTypeScriptTypes } from "node:module";
import { createInteractionCacheScope, mountRead, invalidateReadsForObservation } from "../../packages/callers/client/cache";
import type { InvocationObservation } from "../../packages/core/program/index";
import { createCaller } from "@foxworth/boundary/pipeline";

const laws = JSON.parse(readFileSync(new URL("../conformance/v1/composition.json", import.meta.url), "utf8"));
const output = portableSchema<string>({ type: "string" });
const interactions = { inspect: defineInteraction({ id: "notebook.inspect", output }) };

describe("interaction composition through public callers", () => {
  it("validates shared observation evidence and rejects contradictory or payload-bearing records", () => {
    expect(validateInvocationObservation(laws.observation)).toEqual(laws.observation);
    expect(() => validateInvocationObservation({ ...laws.observation, certainty: "completed" })).toThrow();
    expect(() => validateInvocationObservation({ ...laws.observation, input: "secret" })).toThrow();
    expect(Object.isFrozen(validateInvocationObservation(laws.observation).changes)).toBe(true);
  });
  it("records exactly what an agent saw without changing the callable contract", async () => {
    const compiled = await compileInteractions(interactions);
    const projection = await projectAllDirect(compiled);
    const first = await presentProjection(projection, { inspect: { title: "Read notebook", description: "Read the current research." } });
    const changed = await presentProjection(projection, { inspect: { title: "Read notebook", description: "Read the current research before proposing changes." } });
    expect(first.projectionDigest).toBe(changed.projectionDigest);
    expect(first.presentationDigest).not.toBe(changed.presentationDigest);
    expect(first.interactions).toEqual([expect.objectContaining({
      alias: "inspect", interactionId: "notebook.inspect", modes: ["direct"],
      inputSchema: { type: "null" }, directOutputSchema: { type: "string" },
      title: "Read notebook", description: "Read the current research.",
    })]);
    await expect(presentProjection(projection, { erase: { description: "Delete notebook" } } as never)).rejects.toThrow();
    await expect(presentProjection(projection, { inspect: { inputSchema: { type: "number" } } } as never)).rejects.toThrow();
    expect((await presentProjection(await pickProjection(projection))).interactions).toEqual([]);
    const request = await projectInteractions(compiled, { inspect: { interaction: compiled.handles.inspect, modes: ["request"] } });
    expect((await presentProjection(request)).interactions[0]).not.toHaveProperty("directOutputSchema");
  });
  it("an agent outcome refreshes the human screen even when observation delivery fails afterward", async () => {
    let title = "before";
    const definitions = {
      read: defineInteraction({ id: "notebook.read", output, reads: ["notebook"] }),
      write: defineInteraction({ id: "notebook.write", input: output, output, changes: ["notebook"] }),
    };
    const compiled = await compileInteractions(definitions);
    const all = await projectAllDirect(compiled);
    const agent = await pickProjection(all, "write");
    const screen = await pickProjection(all, "read");
    const installed = await installInteractions(compiled, {
      installationId: "shared:notebook:1", realizationIds: directRealizationIds(compiled, "release-1"),
      implementations: implementInteractions<typeof definitions, { run: string; secret: string }>(definitions, {
        read: () => title,
        write: (input) => { title = input; if (input === "uncertain") throw new Error("connection lost after write"); return title; },
      }),
    });
    const scope = createInteractionCacheScope();
    const seen: InvocationObservation[] = [];
    const agentBound = await bindProjection(agent, installed.installation, {
      admit: () => ({ decision: "allow" }),
      observation: {
        correlate: (context) => ({ run: context.run }),
        publish: async (event) => {
          seen.push(event);
          await invalidateReadsForObservation(event, scope);
          throw new Error("activity publisher unavailable");
        },
      },
    });
    const screenBound = await bindProjection(screen, installed.installation, { admit: () => ({ decision: "allow" }) });
    if (agentBound.status !== "bound" || screenBound.status !== "bound") throw new Error("did not bind");
    const context = { run: "run-7", secret: "credential" };
    const clientFor = async (binding: typeof agentBound.binding | typeof screenBound.binding) => {
      const handler = createProtocolHandler({ caller: createCaller(binding), path: "/boundary", context: () => context });
      return createProjectionClient(await compositionTransport((request) => handler(request)));
    };
    const human = await clientFor(screenBound.binding);
    const robot = await clientFor(agentBound.binding);
    let displayed = await human.call(screen.handles.read);
    let refreshes = 0;
    const unmount = mountRead(human, "notebook.read", async () => { refreshes += 1; displayed = await human.call(screen.handles.read); }, scope);
    await expect(robot.call(agent.handles.write, "after")).resolves.toBe("after");
    expect(displayed).toBe("after");
    expect(seen[0]).toMatchObject({ version: 1, certainty: "completed", resultKind: "returned", correlation: { run: "run-7" }, changes: ["notebook"] });
    expect(JSON.stringify(seen)).not.toContain("credential");
    await expect(robot.call(agent.handles.write, "uncertain")).rejects.toMatchObject({ certainty: "unknown" });
    expect(displayed).toBe("uncertain");
    expect(seen[1]).toMatchObject({ certainty: "unknown", resultKind: "fault" });
    expect(refreshes).toBe(2);
    await invalidateReadsForObservation({ ...seen[0], installationId: "another:installation" }, scope);
    await invalidateReadsForObservation({ ...seen[0], installationDigest: `sha256:${"0".repeat(64)}` }, scope);
    await invalidateReadsForObservation({ ...seen[0], mode: "request", certainty: "not-started", resultKind: "proposed" }, scope);
    await invalidateReadsForObservation({ ...seen[0], certainty: "not-started", resultKind: "denied" }, scope);
    expect(refreshes).toBe(2);
    unmount();
  });
  it("a host revision changes realization pins even when contracts and deployment name stay the same", async () => {
    const compiled = await compileInteractions(interactions);
    const projection = await projectAllDirect(compiled);
    let executions = 0;
    async function deploy(revision: string) {
      const { installation } = await installInteractions(compiled, {
        installationId: "notebook:deployment",
        realizationIds: directRealizationIds(compiled, revision),
        implementations: implementInteractions(interactions, { inspect() { executions += 1; return revision; } }),
      });
      const result = await bindProjection(projection, installation, { admit: () => ({ decision: "allow" }) });
      if (result.status !== "bound") throw new Error("did not bind");
      return createProtocolHandler({ caller: createCaller(result.binding), path: "/boundary", context: () => undefined });
    }
    let handler = await deploy("release-1");
    const transport = await compositionTransport((request) => handler(request));
    const old = createProjectionClient(transport);
    await expect(old.call(projection.handles.inspect)).resolves.toBe("release-1");
    handler = await deploy("release-2");
    await expect(old.call(projection.handles.inspect)).rejects.toMatchObject({ code: "STALE_BINDING" });
    expect(executions).toBe(1);
    await expect(createProjectionClient(transport).call(projection.handles.inspect)).resolves.toBe("release-2");
    expect(() => directRealizationIds(compiled, "")).toThrow();
  });
  it("offline request references cannot invent a realized proposal type", async () => {
    const compiled = await compileInteractions(interactions);
    const projection = await projectInteractions(compiled, { inspect: { interaction: compiled.handles.inspect, modes: ["request"] } });
    const source = { compiled, module: "./notebook.boundary", export: "interactions" };
    const value = { projection, source, exportName: "refs", members: { inspect: { definition: "inspect" } } };
    const render = (candidate: typeof value) => renderHostArtifacts({ references: { request: { name: "request", value: candidate } } });
    const files = render(value).files;
    expect(new TextDecoder().decode(new Uint8Array(files[0]!.bytes))).toContain('import("@foxworth/boundary/program").JsonValue');
    expect(() => render({ ...value, members: { inspect: { definition: "inspect", requestOutput: { module: "./guessed", export: "Preview" } } } } as typeof value)).toThrow("requires a Binding");
    expect(() => render({ ...value, projection: {} } as typeof value)).toThrow();
  });
  it("ships references without an implementation and checks them when connecting later", async () => {
    const compiled = await compileInteractions(interactions);
    const projection = await projectAllDirect(compiled);
    const artifacts = renderHostArtifacts({ references: { notebook: { name: "notebook", value: {
      projection,
      source: { compiled, module: "./notebook.boundary", export: "interactions" },
      exportName: "references", members: { inspect: { definition: "inspect" } },
    } } } });
    const source = new TextDecoder().decode(new Uint8Array(artifacts.files[0]!.bytes));
    const js = stripTypeScriptTypes(source).replace("export const references", "const references");
    const generated: { references: typeof projection.handles } = { references: new Function(`${js}; return references;`)() };
    const { installation } = await installInteractions(compiled, {
      installationId: "offline:1", realizationIds: { inspect: { direct: "inspect:1" } },
      implementations: implementInteractions(interactions, { inspect: () => "connected later" }),
    });
    const bound = await bindProjection(projection, installation, { admit: () => ({ decision: "allow" }) });
    if (bound.status !== "bound") throw new Error("did not bind");
    const handler = createProtocolHandler({ caller: createCaller(bound.binding), path: "/boundary", context: () => undefined });
    const client = createProjectionClient(await compositionTransport((request) => handler(request)));
    const refs = await pinProjectionReferences(client, generated.references);
    await expect(client.call(refs.inspect)).resolves.toBe("connected later");
    await expect(pinProjectionReferences(client, { inspect: { ...refs.inspect, contractDigest: `sha256:${"0".repeat(64)}` as const } })).rejects.toMatchObject({ code: "STALE_REFERENCE" });
  });
  it("an observer with an empty surface binds and handshakes without acquiring any interaction", async () => {
    const compiled = await compileInteractions(interactions);
    const full = await projectAllDirect(compiled);
    const empty = await pickProjection(full);
    const declaredEmpty = await projectInteractions(compiled, {});
    expect(empty.projectionDigest).toBe(declaredEmpty.projectionDigest);
    expect(empty.projectionDigest).toBe(laws.emptySurface.projectionDigest);
    expect(empty.program.programDigest).toBe(laws.emptySurface.programDigest);
    expect(empty.manifest.interactions).toHaveLength(laws.emptySurface.selectedInteractions);
    let calls = 0;
    const { installation } = await installInteractions(compiled, {
      installationId: "notebook:observer:1",
      realizationIds: { inspect: { direct: "inspect:1" } },
      implementations: implementInteractions(interactions, { inspect() { calls += 1; return "notebook"; } }),
    });
    const bound = await bindProjection(empty, installation, { admit: () => ({ decision: "allow" }) });
    expect(bound.status).toBe(laws.emptySurface.bindStatus);
    if (bound.status !== "bound") throw new Error("observer did not bind");
    const handler = createProtocolHandler({ caller: createCaller(bound.binding), path: "/boundary", context: () => undefined });
    const client = createProjectionClient(await compositionTransport(handler));
    const manifest = await client.inspect();
    expect(manifest.interactions).toHaveLength(laws.emptySurface.bindingInteractions);
    await expect(client.callRaw("notebook.inspect", null))
      .rejects.toMatchObject({ code: laws.emptySurface.unselectedInvocation });
    // @ts-expect-error an empty caller has no callable handle
    await expect(bound.binding.connect().call(full.handles.inspect)).rejects.toMatchObject({ certainty: "not-started" });
    expect(calls).toBe(laws.emptySurface.callableInteractions);
    expect(bound.controller.revoke()).toBe(true);
  });
});
