import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, it } from "vitest";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  type AnyInteractionDefinition,
  direct,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import {
  createHandoffInvocation,
  executeHandoff,
  validateProjectionBindingManifest,
} from "@foxworth/boundary/handoff";
import { portableSchema, validateSchemaValue } from "@foxworth/boundary/program";
import {
  CONTROL_RECORD_VERSION,
  listControl,
  proposalDigest,
  type ProposalRecord,
} from "@foxworth/boundary/control";
import { MemoryJournal } from "@foxworth/boundary/control/testing";
import { createCompositeHttpHandler } from "@foxworth/boundary/http/compose";
import { createHttpHandler, route } from "@foxworth/boundary/http";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { createProjectionClient } from "@foxworth/boundary/client";
import { useInteraction } from "@foxworth/boundary/react";
import { createAdapterFixture } from "../helpers/adapter";
import { measure, measureSync, recordCase } from "./measure";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const Echo = portableSchema<{ readonly n: number }>({
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
  additionalProperties: false,
});
const Title = portableSchema<{ readonly title: string }>({
  type: "object",
  properties: {
    title: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" },
  },
  required: ["title"],
  additionalProperties: false,
});

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as const;

async function hostFixture() {
  const interactions = {
    list: defineInteraction({
      id: "bench.list",
      output: portableSchema<readonly { readonly n: number }[]>({
        type: "array",
        items: Echo,
      }),
      reads: ["bench"],
      changes: [],
    }),
    echo: defineInteraction({
      id: "bench.echo",
      input: Echo,
      output: Echo,
      reads: ["bench"],
      changes: [],
    }),
  } as const;
  const compiled = await compileInteractions(interactions);
  const implementations = implementInteractions(interactions, {
    list: () => [{ n: 1 }],
    echo: (input) => input,
  });
  const { installation } = await installInteractions(compiled, {
    installationId: "installation:bench:1",
    implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
  const projection = await projectInteractions(compiled, {
    list: direct(compiled.handles.list),
    echo: direct(compiled.handles.echo),
  });
  const result = await bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }),
  });
  if (result.status !== "bound") {
    throw new Error("bench Binding could not be realized");
  }
  return { compiled, interactions, projection, binding: result.binding };
}

function catalog(count: number) {
  const interactions: Record<string, AnyInteractionDefinition> = {};
  for (let index = 0; index < count; index += 1) {
    interactions[`echo${index}`] = defineInteraction({
      id: `bench.echo-${index}`,
      input: Echo,
      output: Echo,
      reads: ["bench"],
      changes: [],
    });
  }
  return interactions;
}

async function seedProposals(count: number) {
  const journal = new MemoryJournal();
  const tenant = Object.freeze({ kind: "todo-list", id: "inbox" });
  for (let index = 0; index < count; index += 1) {
    const identity = {
      version: CONTROL_RECORD_VERSION,
      id: `proposal-${index}`,
      bindingDigest: digest("4"),
      projectionDigest: digest("5"),
      installationId: "installation:todos:1",
      installationDigest: digest("6"),
      expectedProgramDigest: digest("7"),
      actualProgramDigest: digest("7"),
      programDigest: digest("0"),
      controlDigest: digest("2"),
      interactionId: "todos.publish",
      expectedContractDigest: digest("8"),
      contractDigest: digest("3"),
      requestRealizationId: "realization:todos.publish:request:1",
      executionRealizationId: "realization:todos.publish:execute:1",
      controlRealizationDigest: digest("9"),
      requestedBy: "author",
      subject: tenant,
      baselineSummary: "unpublished",
      effects: [
        {
          kind: "network",
          action: "publish",
          resource: "todos/inbox",
          details: { index },
        },
      ],
      preview: { title: `Publish ${index}` },
      createdAt: 1_000 + index,
      input: { list: "inbox", index },
      baseline: { revision: index },
      state: { body: ["item"] },
    };
    const record = {
      ...identity,
      proposalDigest: await proposalDigest(identity),
    } as ProposalRecord;
    await journal.createProposal(record);
  }
  return {
    journal,
    scope: Object.freeze({
      interactionIds: Object.freeze(["todos.publish"]),
      tenant,
    }),
  };
}

describe("boundary performance baseline", () => {
  it("records TypeScript hot-path timings", async () => {
    const small = {
      list: defineInteraction({
        id: "bench.small.list",
        output: Echo,
        reads: ["bench"],
        changes: [],
      }),
    } as const;
    recordCase({
      id: "ts.compile.small",
      lang: "ts",
      class: "startup",
      ...(await measure(() => compileInteractions(small), {
        warmup: 3,
        iters: 20,
      })),
    });

    const large = catalog(50);
    recordCase({
      id: "ts.compile.50",
      lang: "ts",
      class: "startup",
      ...(await measure(() => compileInteractions(large), {
        warmup: 2,
        iters: 12,
      })),
    });

    const compiledSmall = await compileInteractions(small);
    const implementations = implementInteractions(small, {
      list: () => ({ n: 1 }),
    });
    const installed = await installInteractions(compiledSmall, {
      installationId: "installation:bench-small:1",
      implementations,
      realizationIds: directRealizationIds(compiledSmall, "v1"),
    });
    const projection = await projectInteractions(compiledSmall, {
      list: direct(compiledSmall.handles.list),
    });
    recordCase({
      id: "ts.bind.small",
      lang: "ts",
      class: "startup",
      ...(await measure(
        () =>
          bindProjection(projection, installed.installation, {
            admit: () => ({ decision: "allow" }),
          }),
        { warmup: 3, iters: 20 },
      )),
    });

    const host = await hostFixture();
    const caller = host.binding.connect();
    recordCase({
      id: "ts.host.call",
      lang: "ts",
      class: "per-call",
      ...(await measure(() => caller.call(host.projection.handles.echo, { n: 1 }), {
        warmup: 50,
        iters: 400,
      })),
    });

    recordCase({
      id: "ts.schema.pattern",
      lang: "ts",
      class: "per-call",
      ...measureSync(
        () => validateSchemaValue(Title, { title: "Ship-Boundary" }, "title"),
        { warmup: 50, iters: 800, batchSize: 32 },
      ),
    });

    recordCase({
      id: "ts.handoff.validateManifest",
      lang: "ts",
      class: "per-call",
      ...(await measure(
        () => validateProjectionBindingManifest(host.binding.manifest),
        { warmup: 5, iters: 40 },
      )),
    });

    recordCase({
      id: "ts.handoff.invoke",
      lang: "ts",
      class: "per-call",
      ...(await measure(async () => {
        const invocation = await createHandoffInvocation(
          host.binding.manifest,
          "bench.echo",
          "direct",
          { n: 1 },
        );
        await executeHandoff(host.binding, invocation, undefined);
      }, { warmup: 8, iters: 60 })),
    });

    const transport = {
      inspect: async () => host.binding.manifest,
      invoke: async (invocation: Awaited<ReturnType<typeof createHandoffInvocation>>) =>
        executeHandoff(host.binding, invocation, undefined),
    };
    const client = createProjectionClient(transport);
    await client.inspect();
    recordCase({
      id: "ts.client.call",
      lang: "ts",
      class: "per-call",
      ...(await measure(
        () => client.call(host.projection.handles.echo, { n: 1 }),
        { warmup: 20, iters: 120 },
      )),
    });

    const protocol = createProtocolHandler({
      binding: host.binding,
      context: () => undefined,
      path: "/boundary",
    });
    const protocolInvoke = new Request("http://bench.local/boundary/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        await createHandoffInvocation(
          host.binding.manifest,
          "bench.echo",
          "direct",
          { n: 1 },
        ),
      ),
    });
    recordCase({
      id: "ts.http.protocolInvoke",
      lang: "ts",
      class: "http",
      ...(await measure(async () => {
        const response = await protocol(
          protocolInvoke.clone() as typeof protocolInvoke,
        );
        if (!response.ok) throw new Error(`protocol ${response.status}`);
        await response.arrayBuffer();
      }, { warmup: 10, iters: 80 })),
    });

    const rest = createHttpHandler({
      binding: host.binding,
      context: () => undefined,
      routes: [
        route(host.projection.handles.echo, {
          method: "POST",
          path: "/echo",
        }),
      ],
    });
    const restRequest = new Request("http://bench.local/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    recordCase({
      id: "ts.http.rest",
      lang: "ts",
      class: "http",
      ...(await measure(async () => {
        const response = await rest(restRequest.clone() as typeof restRequest);
        if (!response.ok) throw new Error(`rest ${response.status}`);
        await response.arrayBuffer();
      }, { warmup: 8, iters: 60 })),
    });

    const composite = createCompositeHttpHandler({
      binding: host.binding,
      context: () => undefined,
      routes: [
        route(host.projection.handles.list, { method: "GET", path: "/list" }),
      ],
      title: "Bench",
      version: "0.0.0",
      protocolPath: "/boundary",
    });
    recordCase({
      id: "ts.http.openapi",
      lang: "ts",
      class: "http",
      ...(await measure(async () => {
        const response = await composite(
          new Request("http://bench.local/openapi.json"),
        );
        if (!response.ok) throw new Error(`openapi ${response.status}`);
        await response.arrayBuffer();
      }, { warmup: 3, iters: 30 })),
    });

    const adapter = await createAdapterFixture();
    const adapterProjection = await projectInteractions(adapter.compiled, {
      list: direct(adapter.compiled.handles.list),
      create: direct(adapter.compiled.handles.create),
    });
    const adapterBinding = await adapter.bind(adapterProjection);
    const adapterClient = createProjectionClient({
      inspect: async () => adapterBinding.manifest,
      invoke: (invocation) =>
        executeHandoff(adapterBinding, invocation, { role: "owner" }),
    });
    let mountRenders = 0;
    const resetAdapter = () => {
      adapter.rows.length = 0;
      adapter.contexts.length = 0;
    };
    const mount = await measure(async () => {
      mountRenders = 0;
      const hook = renderHook(() => {
        mountRenders += 1;
        return useInteraction(adapterClient, adapterProjection.handles.list);
      });
      await waitFor(() => expectReady(hook.result.current));
      hook.unmount();
    }, { warmup: 2, iters: 12, beforeEach: resetAdapter });
    recordCase({
      id: "ts.react.mountRead",
      lang: "ts",
      class: "react",
      extra: { renders: mountRenders },
      ...mount,
    });

    let mutationRenders = 0;
    const mutation = await measure(async () => {
      mutationRenders = 0;
      const list = renderHook(() => {
        mutationRenders += 1;
        return useInteraction(adapterClient, adapterProjection.handles.list);
      });
      await waitFor(() => expectReady(list.result.current));
      const create = renderHook(() => {
        mutationRenders += 1;
        return useInteraction(adapterClient, adapterProjection.handles.create);
      });
      await act(async () => {
        await create.result.current.call({ title: "bench-created" });
      });
      await waitFor(() => {
        expectReady(list.result.current);
        if (!list.result.current.data?.some((row) => row.id === 1 && row.title === "bench-created")) {
          throw new Error("created row has not reached the refreshed list");
        }
      });
      list.unmount();
      create.unmount();
    }, { warmup: 2, iters: 10, beforeEach: resetAdapter });
    recordCase({
      id: "ts.react.mutation",
      lang: "ts",
      class: "react",
      extra: { renders: mutationRenders },
      ...mutation,
    });

    const fifty = await seedProposals(50);
    recordCase({
      id: "ts.control.list.50",
      lang: "ts",
      class: "list",
      ...(await measure(
        () => listControl(fifty.journal, undefined, fifty.scope),
        { warmup: 2, iters: 12 },
      )),
    });
    const twoHundred = await seedProposals(200);
    recordCase({
      id: "ts.control.list.200",
      lang: "ts",
      class: "list",
      ...(await measure(
        () => listControl(twoHundred.journal, undefined, twoHundred.scope),
        { warmup: 1, iters: 6 },
      )),
    });
  });
});

function expectReady(result: { isPending: boolean; error?: unknown }): void {
  if (result.error) throw result.error;
  if (result.isPending) throw new Error("pending");
}
