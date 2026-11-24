import { Readable } from "node:stream";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createControlRequestContributions } from "../../packages/core/host/control";
import { AdapterError, isDomainErrorFor } from "@foxworth/boundary/client";
import { createCompositeHttpHandler, mountHandlers } from "@foxworth/boundary/http";
import { createHttpHandler, route } from "@foxworth/boundary/http";
import { createProtocolHandler, fetchTransport } from "@foxworth/boundary/http";
import type { ClientTransport } from "@foxworth/boundary/client";
import { openapi } from "@foxworth/boundary/http";
import { createProjectionClient, handlesFromBinding, pinProjectionReferences } from "@foxworth/boundary/client";
import {
  createTrpcHandler,
  createTrpcRouter,
  procedure,
} from "@foxworth/boundary/frameworks/trpc";
import { toFetchRequest } from "@foxworth/boundary/http/node";
import {
  portableSchema,
} from "@foxworth/boundary/program";

const Todo = portableSchema<Readonly<{ id: string; title: string }>>({
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string", minLength: 1 } },
  required: ["id", "title"],
  additionalProperties: false,
});
const Todos = portableSchema<readonly Readonly<{ id: string; title: string }>[]>({
  type: "array",
  items: Todo,
});
const Create = portableSchema<Readonly<{ title: string }>>({
  type: "object",
  properties: { title: { type: "string", minLength: 1 } },
  required: ["title"],
  additionalProperties: false,
});
const Find = portableSchema<Readonly<{ id: string }>>({
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
});
const Missing = portableSchema<Readonly<{ id: string }>>({
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
});
const Proposal = portableSchema<Readonly<{ proposalId: string; title: string }>>({
  type: "object",
  properties: { proposalId: { type: "string" }, title: { type: "string" } },
  required: ["proposalId", "title"],
  additionalProperties: false,
});
const Never = portableSchema<never>({ not: {} });

const interactions = {
  list: defineInteraction({
    id: "todos.list",
    output: Todos,
    reads: ["todos"],
    changes: [],
  }),
  create: defineInteraction({
    id: "todos.create",
    input: Create,
    output: Todo,
    reads: [],
    changes: ["todos"],
  }),
  find: defineInteraction({
    id: "todos.find",
    input: Find,
    output: Todo,
    errors: { missing: Missing },
    reads: ["todos"],
    changes: [],
  }),
  explode: defineInteraction({
    id: "todos.explode",
    output: Never,
    reads: [],
    changes: [],
  }),
} as const;

type Context = Readonly<{
  requestId: string;
  role: "owner" | "viewer";
  capability: Readonly<{ token: string }>;
}>;

async function fixture() {
  const rows: Array<{ id: string; title: string }> = [];
  const directContexts: Context[] = [];
  const requestContexts: Context[] = [];
  let directCreates = 0;
  const compiled = compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, Context>(interactions, {
    list(context) {
      directContexts.push(context);
      return [...rows];
    },
    create(input, context) {
      directContexts.push(context);
      directCreates += 1;
      const todo = { id: String(rows.length + 1), title: input.title };
      rows.push(todo);
      return todo;
    },
    find(input, context) {
      directContexts.push(context);
      const found = rows.find((row) => row.id === input.id);
      if (!found) {
        throw declaredInteractionError(interactions.find, "missing", { id: input.id });
      }
      return found;
    },
    explode(context) {
      directContexts.push(context);
      throw new Error("postgres://admin:private@internal.example");
    },
  });
  const requests = createControlRequestContributions<typeof interactions, Context>(
    compiled,
    {
      create: {
        interaction: compiled.handles.create,
        controlDigest: compiled.handles.create.contractDigest,
        previewSchema: Proposal,
        request(input, context) {
          requestContexts.push(context);
          return {
            proposalId: `proposal-${requestContexts.length}`,
            title: input.title,
          };
        },
      },
    },
  );
  const { installation } = installInteractions<typeof interactions, Context>(compiled, {
    installationId: "installation:projectors:2",
    implementations,
    requests,
    realizationIds: {
      list: { direct: "realization:list:2" },
      create: {
        direct: "realization:create:direct:2",
        request: "realization:create:request:2",
      },
      find: { direct: "realization:find:2" },
      explode: { direct: "realization:explode:2" },
    },
  });
  const projection = projectInteractions(compiled, {
    list: { interaction: compiled.handles.list, modes: ["direct"] },
    create: { interaction: compiled.handles.create, modes: ["direct", "request"] },
    find: { interaction: compiled.handles.find, modes: ["direct"] },
    explode: { interaction: compiled.handles.explode, modes: ["direct"] },
  });
  const result = bindProjection(projection, installation, {
    admit({ context, handle, mode }) {
      return context.role === "owner" || (handle.changes.length === 0 && mode === "direct")
        ? { decision: "allow" }
        : { decision: "deny", reason: "owner role required" };
    },
  });
  if (result.status !== "bound") throw new Error("fixture did not bind");
  return {
    binding: result.binding,
    compiled,
    projection,
    rows,
    directContexts,
    requestContexts,
    get directCreates() { return directCreates; },
  };
}

function context(requestId: string, role: Context["role"] = "owner"): Context {
  return Object.freeze({
    requestId,
    role,
    capability: Object.freeze({ token: `cap:${requestId}` }),
  });
}

describe("version 1 projectors", () => {
  it("preserves HTTP routing, path mapping, custom mapping, statuses, headers, and declared errors", async () => {
    const app = await fixture();
    const requestContext = context("http:1");
    const handler = createHttpHandler({
      binding: app.binding,
      context: () => requestContext,
      routes: [
        route(app.projection.handles.list, {
          method: "GET",
          path: "/todos",
          headers: { "x-adapter": "boundary" },
        }),
        route(app.projection.handles.create, {
          method: "POST",
          path: "/todos",
          mode: "direct",
          successStatus: 201,
        }),
        route(app.projection.handles.find, {
          method: "GET",
          path: "/todos/{id}",
        }),
        route(app.projection.handles.create, {
          method: "POST",
          path: "/mapped",
          mode: "direct",
          input: async ({ request }) => ({ title: request.headers.get("x-title") ?? "" }),
        }),
        route(app.projection.handles.explode, {
          method: "POST",
          path: "/explode",
        }),
      ],
    });

    const created = await handler(new Request("https://example.test/todos", {
      method: "POST",
      body: JSON.stringify({ title: "First" }),
    }));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      version: 1,
      interactionId: "todos.create",
      mode: "direct",
      certainty: "completed",
      result: { kind: "returned", value: { id: "1", title: "First" } },
    });

    const found = await handler(new Request("https://example.test/todos/1"));
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({
      interactionId: "todos.find",
      result: { kind: "returned", value: { title: "First" } },
    });

    const missing = await handler(new Request("https://example.test/todos/99"));
    expect(missing.status).toBe(422);
    await expect(missing.json()).resolves.toMatchObject({
      result: { kind: "declared-error", code: "missing", details: { id: "99" } },
    });

    const mapped = await handler(new Request("https://example.test/mapped", {
      method: "POST",
      headers: { "x-title": "Mapped" },
      body: "{}",
    }));
    expect(mapped.status).toBe(200);
    await expect(mapped.json()).resolves.toMatchObject({
      result: { kind: "returned", value: { title: "Mapped" } },
    });

    const listed = await handler(new Request("https://example.test/todos"));
    expect(listed.headers.get("x-adapter")).toBe("boundary");
    expect(app.directContexts.every((received) => received === requestContext)).toBe(true);

    const exploded = await handler(new Request("https://example.test/explode", {
      method: "POST",
      body: "{}",
    }));
    const explodedText = await exploded.text();
    expect(exploded.status).toBe(500);
    expect(explodedText).toContain('"certainty":"unknown"');
    expect(explodedText).not.toContain("private");
    expect(explodedText).not.toContain("postgres");

    const hidden = await handler(new Request("https://example.test/hidden"));
    expect(hidden.status).toBe(404);
  });

  it("keeps request mode proposal-only and passes the exact context", async () => {
    const app = await fixture();
    const requestContext = context("request:1");
    const handler = createHttpHandler({
      binding: app.binding,
      context: () => requestContext,
      routes: [route(app.projection.handles.create, {
        method: "POST",
        path: "/proposals",
        mode: "request",
      })],
    });
    const response = await handler(new Request("https://example.test/proposals", {
      method: "POST",
      body: JSON.stringify({ title: "Review" }),
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      mode: "request",
      realizationId: "realization:create:request:2",
      certainty: "not-started",
      result: {
        kind: "proposed",
        proposal: { proposalId: "proposal-1", title: "Review" },
      },
    });
    expect(app.requestContexts).toEqual([requestContext]);
    expect(app.directCreates).toBe(0);
  });

  it("preserves nested invalid-input issues through HTTP, protocol, client, and tRPC without dispatch", async () => {
    const app = await fixture();
    const requestContext = context("invalid-input");
    const http = createHttpHandler({
      binding: app.binding,
      context: () => requestContext,
      routes: [route(app.projection.handles.create, {
        method: "POST",
        path: "/todos",
        mode: "direct",
      })],
    });
    const httpResponse = await http(new Request("https://example.test/todos", {
      method: "POST",
      body: JSON.stringify({ title: "" }),
    }));
    expect(httpResponse.status).toBe(400);
    await expect(httpResponse.json()).resolves.toMatchObject({
      certainty: "not-started",
      result: {
        kind: "fault",
        cause: "invalid-input",
        issues: [expect.objectContaining({ path: "invocation.input.title" })],
      },
    });
    const contextFailure = createHttpHandler({
      binding: app.binding,
      context: () => {
        throw new Error("private credential lookup failed");
      },
      routes: [route(app.projection.handles.create, {
        method: "POST",
        path: "/todos",
        mode: "direct",
      })],
    });
    const beforeContextFailure = app.directCreates;
    const contextFailureResponse = await contextFailure(new Request(
      "https://example.test/todos",
      { method: "POST", body: JSON.stringify({ title: "Never dispatched" }) },
    ));
    await expect(contextFailureResponse.json()).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(app.directCreates).toBe(beforeContextFailure);

    const protocol = createProtocolHandler({
      binding: app.binding,
      context: () => requestContext,
      path: "/_boundary",
    });
    const interaction = app.binding.manifest.interactions.find(
      (entry) => entry.interactionId === "todos.create" && entry.mode === "direct",
    )!;
    const protocolResponse = await protocol(new Request(
      "https://example.test/_boundary/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          bindingDigest: app.binding.manifest.bindingDigest,
          installationId: app.binding.manifest.installationId,
          interactionId: interaction.interactionId,
          expectedContractDigest: interaction.expectedContractDigest,
          actualContractDigest: interaction.actualContractDigest,
          mode: interaction.mode,
          realizationId: interaction.realizationId,
          input: { title: "" },
        }),
      },
    ));
    expect(protocolResponse.status).toBe(400);
    await expect(protocolResponse.json()).resolves.toMatchObject({
      certainty: "not-started",
      result: {
        kind: "fault",
        cause: "invalid-input",
        issues: [expect.objectContaining({ path: "invocation.input.title" })],
      },
    });

    const client = createProjectionClient(fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: (input, init) => protocol(new Request(input, init)),
    }));
    await expect(client.callRaw("todos.create", { title: "" })).rejects.toMatchObject({
      code: "REMOTE_EXECUTION_FAILED",
      certainty: "not-started",
      cause: "invalid-input",
      issues: [expect.objectContaining({ path: "invocation.input.title" })],
    });

    const router = await createTrpcRouter({
      binding: app.binding,
      context: (received: { actor: Context }) => received.actor,
      procedures: [procedure(app.projection.handles.create, {
        name: "todos.create",
        kind: "mutation",
        mode: "direct",
      })],
    });
    await expect(
      (router.createCaller({ actor: requestContext }) as any).todos.create({
        title: "",
      }),
    ).resolves.toMatchObject({
      certainty: "not-started",
      result: {
        kind: "fault",
        cause: "invalid-input",
        issues: [expect.objectContaining({ path: "invocation.input.title" })],
      },
    });

    const hostileContextProtocol = createProtocolHandler({
      binding: app.binding,
      context: () => {
        throw {
          code: "PRIVATE_CONTEXT_CODE",
          path: "private.context.path",
          issues: [{ path: "private.secret", message: "do not cross" }],
        };
      },
      path: "/_hostile",
    });
    const hostileResponse = await hostileContextProtocol(new Request(
      "https://example.test/_hostile/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          bindingDigest: app.binding.manifest.bindingDigest,
          installationId: app.binding.manifest.installationId,
          interactionId: interaction.interactionId,
          expectedContractDigest: interaction.expectedContractDigest,
          actualContractDigest: interaction.actualContractDigest,
          mode: interaction.mode,
          realizationId: interaction.realizationId,
          input: { title: "valid" },
        }),
      },
    ));
    const hostileText = await hostileResponse.text();
    expect(hostileResponse.status).toBe(500);
    expect(hostileText).not.toContain("PRIVATE_CONTEXT_CODE");
    expect(hostileText).not.toContain("private.secret");
    expect(hostileText).not.toContain("do not cross");
    expect(app.directCreates).toBe(0);
  });

  it("describes only explicit routes from either a durable Projection or a live Binding", async () => {
    const app = await fixture();
    const routes = [
      route(app.projection.handles.list, { method: "GET", path: "/todos" }),
      route(app.projection.handles.find, { method: "GET", path: "/todos/{id}" }),
      route(app.projection.handles.create, {
        method: "POST",
        path: "/proposals",
        mode: "request",
      }),
    ] as const;
    const unrealized = await openapi({
      projection: app.projection,
      title: "Todos",
      version: "1",
      routes,
    });
    expect(unrealized["x-boundary-program-digest"]).toBe(
      app.projection.program.programDigest,
    );
    expect(Object.keys(unrealized.paths as object)).toEqual(["/todos", "/todos/{id}", "/proposals"]);
    expect(JSON.stringify(unrealized)).not.toContain("todos.explode");
    expect((unrealized.paths as any)["/todos/{id}"].get.parameters[0]).toMatchObject({
      name: "id",
      in: "path",
    });

    const live = await openapi({
      binding: app.binding,
      title: "Todos",
      version: "1",
      routes,
    });
    expect(live["x-boundary-program-digest"]).toBe(
      app.binding.manifest.expectedProgramDigest,
    );
    expect(live["x-boundary-projection-digest"]).toBe(
      app.binding.manifest.projectionDigest,
    );
    expect(live["x-boundary-binding-digest"]).toBe(app.binding.manifest.bindingDigest);
    const proposalSchema = (live.paths as any)["/proposals"].post.responses["202"]
      .content["application/json"].schema;
    expect(JSON.stringify(proposalSchema)).toContain("proposalId");
    expect(proposalSchema.oneOf).toHaveLength(1);
    expect(proposalSchema.oneOf[0].properties.version).toEqual({ const: 1 });
    expect(proposalSchema.oneOf[0].properties.certainty).toEqual({
      const: "not-started",
    });
    expect(proposalSchema.oneOf[0].properties.result.properties.kind).toEqual({
      const: "proposed",
    });
    expect(proposalSchema.oneOf[0].properties.installationId).toEqual({
      const: app.binding.manifest.installationId,
    });

    const findResponses = (live.paths as any)["/todos/{id}"].get.responses;
    const returnedSchema = findResponses["200"].content["application/json"].schema;
    expect(returnedSchema.oneOf).toHaveLength(1);
    expect(returnedSchema.oneOf[0].properties.certainty).toEqual({
      const: "completed",
    });
    expect(returnedSchema.oneOf[0].properties.result.properties.kind).toEqual({
      const: "returned",
    });
    const faultSchema = findResponses["500"].content["application/json"].schema;
    expect(faultSchema.oneOf.map((branch: any) => [
      branch.properties.certainty.const,
      branch.properties.result.properties.cause.const,
    ])).toEqual([
      ["not-started", "admission-failed"],
      ["unknown", "invalid-realization-outcome"],
      ["not-started", "realization-failed"],
      ["not-completed", "realization-failed"],
      ["unknown", "realization-failed"],
    ]);
    expect(faultSchema.oneOf.every(
      (branch: any) => branch.properties.result.properties.kind.const === "fault",
    )).toBe(true);
    const requestFaultSchema = (live.paths as any)["/proposals"].post.responses["500"]
      .content["application/json"].schema;
    expect(requestFaultSchema.oneOf.map((branch: any) => [
      branch.properties.certainty.const,
      branch.properties.result.properties.cause.const,
    ])).toEqual([
      ["not-started", "admission-failed"],
      ["not-started", "request-failed"],
    ]);
    const revokedSchema = findResponses["409"].content["application/json"].schema;
    expect(revokedSchema.oneOf.map((branch: any) => [
      branch.properties.certainty.const,
      branch.properties.result.properties.cause.const,
    ])).toEqual([["not-started", "revoked"]]);
    const invalidSchema = findResponses["400"].content["application/json"].schema;
    expect(invalidSchema.oneOf).toHaveLength(2);
    expect(invalidSchema.oneOf[0]).toMatchObject({
      properties: {
        certainty: { const: "not-started" },
        result: {
          required: ["kind", "cause", "issues"],
          properties: {
            cause: { const: "invalid-input" },
            issues: {
              minItems: 1,
              items: {
                additionalProperties: false,
                required: ["path", "message"],
              },
            },
          },
        },
      },
    });
    const declaredSchema = findResponses["422"].content["application/json"].schema;
    expect(declaredSchema.oneOf[0].properties.certainty).toEqual({
      const: "completed",
    });

    await expect(openapi({
      projection: app.projection,
      title: "Opaque",
      version: "1",
      routes: [route(app.projection.handles.create, {
        method: "POST",
        path: "/opaque",
        mode: "direct",
        input: () => ({ title: "opaque" }),
      })],
    })).rejects.toMatchObject({ code: "INVALID_DECLARATION" });
  });

  it("pins one exact v1 handshake for typed and dynamic browser calls", async () => {
    const app = await fixture();
    const requestContext = context("protocol:1");
    const protocol = createProtocolHandler({
      binding: app.binding,
      context: () => requestContext,
      path: "/_boundary",
    });
    const base = fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: (input, init) => protocol(new Request(input, init)),
    });
    const invocations: unknown[] = [];
    const transport: ClientTransport = {
      inspect: () => base.inspect(),
      invoke(invocation) {
        invocations.push(invocation);
        return base.invoke(invocation);
      },
    };
    const client = createProjectionClient(transport);
    const manifest = await client.inspect();
    expect(manifest.version).toBe(1);
    expect(manifest.bindingDigest).toBe(app.binding.manifest.bindingDigest);

    const typed = client.call(app.projection.handles.create, { title: "Typed" });
    expectTypeOf(typed).toEqualTypeOf<Promise<Readonly<{ id: string; title: string }>>>();
    await expect(typed).resolves.toEqual({ id: "1", title: "Typed" });
    await expect(client.callRaw("todos.list")).resolves.toEqual([
      { id: "1", title: "Typed" },
    ]);
    await expect(client.request(app.projection.handles.create, { title: "Review" }))
      .resolves.toEqual({ proposalId: "proposal-1", title: "Review" });
    expect(invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 1, mode: "direct" }),
      expect.objectContaining({ version: 1, mode: "request" }),
    ]));
    expect(app.directContexts.every((received) => received === requestContext)).toBe(true);
    expect(app.requestContexts).toEqual([requestContext]);

    const stale = createProjectionClient({
      inspect: () => base.inspect(),
      async invoke(invocation) {
        const result = await base.invoke(invocation);
        return { ...result, realizationId: "realization:substituted" };
      },
    });
    await expect(stale.call(app.projection.handles.list)).rejects.toMatchObject({
      code: "REMOTE_INVOCATION_FAILED",
      certainty: "unknown",
      phase: "response",
    });
    const dropped = createProjectionClient({
      inspect: () => base.inspect(),
      async invoke(invocation) {
        await base.invoke(invocation);
        throw new Error("connection dropped after dispatch");
      },
    });
    await expect(dropped.call(app.projection.handles.create, { title: "Once" }))
      .rejects.toMatchObject({
        code: "REMOTE_INVOCATION_FAILED",
        certainty: "unknown",
        phase: "transport",
      });
  });

  it("preserves only server-proven pre-dispatch protocol rejection", async () => {
    const app = await fixture();
    const protocol = createProtocolHandler({
      binding: app.binding,
      context: () => context("server-rejection"),
      path: "/_boundary",
    });
    const client = createProjectionClient(fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: async (input, init) => {
        if (String(input).endsWith("/invoke")) {
          return Response.json({
            error: {
              kind: "protocol",
              code: "STALE_BINDING",
              path: "invocation.bindingDigest",
              message: "The version 1 Handoff invocation was rejected.",
            },
          }, { status: 409 });
        }
        return protocol(new Request(input, init));
      },
    }));
    await expect(client.call(app.projection.handles.list)).rejects.toMatchObject({
      name: "RemoteProtocolRejection",
      code: "STALE_BINDING",
      remoteCode: "STALE_BINDING",
      certainty: "not-started",
      status: 409,
    });

    const rejected400 = createProjectionClient(fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: async (input, init) => String(input).endsWith("/invoke")
        ? Response.json({
            error: {
              kind: "protocol",
              code: "INVALID_REQUEST",
              path: "invocation.input",
              message: "The version 1 Handoff invocation was rejected.",
            },
          }, { status: 400 })
        : protocol(new Request(input, init)),
    }));
    await expect(rejected400.call(app.projection.handles.list)).rejects
      .toMatchObject({
        name: "RemoteProtocolRejection",
        code: "INVALID_REQUEST",
        remoteCode: "INVALID_REQUEST",
        certainty: "not-started",
        status: 400,
      });

    const unproven = createProjectionClient({
      inspect: () => Promise.resolve(app.binding.manifest),
      invoke: async () => {
        throw new AdapterError(
          "STALE_BINDING",
          "transport.invoke",
          "caller asserted this without server evidence",
        );
      },
    });
    await expect(unproven.call(app.projection.handles.list)).rejects.toMatchObject({
      code: "REMOTE_INVOCATION_FAILED",
      certainty: "unknown",
      phase: "transport",
    });
  });

  it("rejects stale protocol pins before dispatch and never rehandshakes or retries", async () => {
    const app = await fixture();
    let contextCalls = 0;
    const protocol = createProtocolHandler({
      binding: app.binding,
      context: () => {
        contextCalls += 1;
        return context("stale");
      },
      path: "/_boundary",
    });
    const interaction = app.binding.manifest.interactions.find(
      (entry) => entry.interactionId === "todos.create" && entry.mode === "direct",
    )!;
    const response = await protocol(new Request("https://example.test/_boundary/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        bindingDigest: app.binding.manifest.bindingDigest,
        installationId: app.binding.manifest.installationId,
        interactionId: interaction.interactionId,
        expectedContractDigest: interaction.expectedContractDigest,
        actualContractDigest: interaction.actualContractDigest,
        mode: interaction.mode,
        realizationId: "realization:stale",
        input: { title: "must not run" },
      }),
    }));
    expect(response.status).toBe(409);
    expect(app.directCreates).toBe(0);
    expect(contextCalls).toBe(1);
  });

  it("builds tRPC only from explicit procedures and keeps context invocation-scoped", async () => {
    const app = await fixture();
    const requestContext = context("trpc:1");
    const router = await createTrpcRouter({
      binding: app.binding,
      context: (received: { actor: Context }) => received.actor,
      procedures: [
        procedure(app.projection.handles.list, { name: "todos.list", kind: "query" }),
        procedure(app.projection.handles.create, {
          name: "todos.propose",
          kind: "mutation",
          mode: "request",
        }),
      ],
    });
    const caller = router.createCaller({ actor: requestContext });
    await expect((caller as any).todos.list()).resolves.toMatchObject({
      version: 1,
      result: { kind: "returned", value: [] },
    });
    await expect((caller as any).todos.propose({ title: "tRPC" })).resolves.toMatchObject({
      mode: "request",
      result: { kind: "proposed", proposal: { title: "tRPC" } },
    });
    expect(app.directContexts).toEqual([requestContext]);
    expect(app.requestContexts).toEqual([requestContext]);

    const contextFailure = await createTrpcRouter({
      binding: app.binding,
      context: (_received: { actor: Context }) => {
        throw new Error("private context failure");
      },
      procedures: [
        procedure(app.projection.handles.create, {
          name: "todos.create",
          kind: "mutation",
          mode: "direct",
        }),
      ],
    });
    const beforeContextFailure = app.directCreates;
    await expect(
      (contextFailure.createCaller({ actor: requestContext }) as any).todos.create({
        title: "Never dispatched",
      }),
    ).resolves.toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(app.directCreates).toBe(beforeContextFailure);
  });

  it("contains rejected HTTP and tRPC exposure initialization before dispatch", async () => {
    const app = await fixture();
    const staleList = Object.freeze({
      ...app.projection.handles.list,
      contractDigest: `sha256:${"f".repeat(64)}`,
    });
    const staleRoute = route(staleList, { method: "GET", path: "/stale" });
    const http = createHttpHandler({
      binding: app.binding,
      context: () => context("never"),
      routes: [staleRoute],
    });
    const response = await http(new Request("https://example.test/stale"));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({
      certainty: "not-started",
      error: { code: "ADAPTER_INITIALIZATION_FAILED" },
    });
    expect(text).not.toContain(staleList.contractDigest);
    expect(app.directContexts).toHaveLength(0);

    const staleProcedure = procedure(staleList, {
      name: "todos.stale",
      kind: "query",
    });
    await expect(createTrpcRouter({
      binding: app.binding,
      context: () => context("never"),
      procedures: [staleProcedure],
    })).rejects.toMatchObject({
      code: "INVALID_DECLARATION",
      path: "createTrpcRouter.procedures",
    });

    const trpc = createTrpcHandler({
      binding: app.binding,
      context: () => context("never"),
      procedures: [staleProcedure],
    });
    const trpcResponse = await trpc(new Request(
      "https://example.test/trpc/todos.stale",
      { method: "POST" },
    ));
    const trpcText = await trpcResponse.text();
    expect(trpcResponse.status).toBe(500);
    expect(JSON.parse(trpcText)).toMatchObject({
      certainty: "not-started",
      error: { code: "ADAPTER_INITIALIZATION_FAILED" },
    });
    expect(trpcText).not.toContain(staleList.contractDigest);
    expect(app.directContexts).toHaveLength(0);
  });

  it("composes REST, OpenAPI, and the exact v1 protocol without claiming the root", async () => {
    const app = await fixture();
    const handler = createCompositeHttpHandler({
      binding: app.binding,
      context: () => context("composite"),
      routes: [route(app.projection.handles.list, { method: "GET", path: "/todos" })],
      title: "Composite",
      version: "1",
      protocolPath: "/_boundary///",
    });
    expect((await handler(new Request("https://example.test/todos"))).status).toBe(200);
    const manifest = await handler(new Request("https://example.test/_boundary/manifest"));
    expect(manifest.status).toBe(200);
    await expect(manifest.json()).resolves.toMatchObject({ version: 1 });
    const specification = await handler(new Request("https://example.test/openapi.json"));
    await expect(specification.json()).resolves.toMatchObject({ openapi: "3.1.0" });
    const etag = specification.headers.get("etag");
    expect(etag).toBe(`"${app.binding.manifest.bindingDigest}"`);
    const cached = await handler(
      new Request("https://example.test/openapi.json", {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);

    expect(() => createCompositeHttpHandler({
      binding: app.binding,
      context: () => context("collision"),
      routes: [],
      title: "Collision",
      version: "1",
      protocolPath: "/openapi.json/",
    })).toThrow(/collides with \/openapi\.json/);
    expect(() => createCompositeHttpHandler({
      binding: app.binding,
      context: () => context("collision"),
      routes: [route(app.projection.handles.find, {
        method: "GET",
        path: "/_boundary/{document}",
      })],
      title: "Collision",
      version: "1",
      protocolPath: "/_boundary/",
    })).toThrow(/REST route collides/);
  });

  it("keeps the Node bridge's path and body semantics intact", async () => {
    const source = Readable.from([Buffer.from('{"title":"Node"}')]) as Readable & {
      method?: string;
      url?: string;
      originalUrl?: string;
      headers: Record<string, string>;
      socket: { encrypted?: boolean };
      complete: boolean;
    };
    source.method = "POST";
    source.url = "/mount/todos?trace=1";
    source.originalUrl = source.url;
    source.headers = { host: "example.test", "content-type": "application/json" };
    source.socket = {};
    source.complete = true;
    const request = toFetchRequest(source as never, { base: "/mount" });
    expect(request.url).toBe("http://example.test/todos?trace=1");
    await expect(request.json()).resolves.toEqual({ title: "Node" });
  });

  it("narrows typed declared errors from a browser client", async () => {
    const app = await fixture();
    const protocol = createProtocolHandler({
      binding: app.binding,
      context: () => context("domain"),
      path: "/_boundary",
    });
    const client = createProjectionClient(fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: (input, init) => protocol(new Request(input, init)),
    }));
    try {
      await client.call(app.projection.handles.find, { id: "missing" });
      throw new Error("expected declared error");
    } catch (error) {
      expect(isDomainErrorFor(app.projection.handles.find, error)).toBe(true);
      if (isDomainErrorFor(app.projection.handles.find, error)) {
        expectTypeOf(error.value.code).toEqualTypeOf<"missing">();
        expect(error.value.details).toEqual({ id: "missing" });
      }
      expect(isDomainErrorFor({
        ...app.projection.handles.find,
        contractDigest: `sha256:${"f".repeat(64)}`,
      }, error)).toBe(false);
    }
  });

  it("hydrates projected handles from the Binding handshake", async () => {
    const app = await fixture();
    const protocol = createProtocolHandler({
      binding: app.binding,
      context: () => context("owner"),
      path: "/_boundary",
    });
    const { handler, paths } = mountHandlers([
      { path: "/_boundary", fetch: protocol },
    ]);
    expect(paths).toEqual(["/_boundary"]);
    const client = createProjectionClient(fetchTransport({
      baseUrl: "https://example.test/_boundary",
      fetch: (input, init) => handler(new Request(input, init)),
    }));
    const handles = await handlesFromBinding(client);
    expect(handles.list.interactionId).toBe(app.projection.handles.list.interactionId);
    expect(handles.list.contractDigest).toBe(
      app.projection.handles.list.contractDigest,
    );
    expect(handles.create.modes).toEqual(["direct", "request"]);
    await expect(pinProjectionReferences(client, app.projection.handles)).resolves
      .toBe(app.projection.handles);
    await expect(pinProjectionReferences(client, {
      ...app.projection.handles,
      list: Object.freeze({
        ...app.projection.handles.list,
        contractDigest: `sha256:${"f".repeat(64)}`,
      }),
    })).rejects.toMatchObject({ code: "STALE_REFERENCE", path: "list" });
    expect(() => mountHandlers([
      { path: "/api", fetch: protocol },
      { path: "/api/admin", fetch: protocol },
    ])).toThrow(/must not overlap/);
  });
});
