import { describe, expect, it } from "vitest";
import {
  portableSchema,
  type JsonSchema,
  type JsonValue,
  type SchemaCompilationContext,
} from "@foxworth/boundary/program";
import { zodSchemaAdapter } from "@foxworth/boundary/program/zod";
import { z } from "zod";
import { admitWhen, declaredInteractionError, defineInteraction, isDeclaredInteractionError, type AdmissionRequest, type Admission, type SchemaAdapter, surface } from "../../packages/core/host/index";
import { bindSurface, compileInteractions, composeCompiledInteractions, diffCompiledInteractions, implementInteractions, installInteractions, projectInteractions, type RequestInvocationPolicy, type NativeDispatchRequest, projectSurface, realizationIdsFor } from "../../packages/core/host/pipeline";
import { createControlRequestContributions } from "../../packages/core/host/control";

const CreateInput = portableSchema<{ readonly title: string }>({
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
});
const Todo = portableSchema<{
  readonly id: string;
  readonly title: string;
}>({
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string" } },
  required: ["id", "title"],
  additionalProperties: false,
});
const TodoList = portableSchema<
  readonly { readonly id: string; readonly title: string }[]
>({ type: "array", items: Todo });
const DuplicateTitle = portableSchema<{ readonly title: string }>({
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
});

const interactions = {
  create: defineInteraction({
    id: "todos.create",
    input: CreateInput,
    output: Todo,
    errors: { duplicateTitle: DuplicateTitle },
    reads: ["todos"],
    changes: ["todos"],
  }),
  list: defineInteraction({
    id: "todos.list",
    output: TodoList,
    reads: ["todos"],
    changes: [],
  }),
} as const;

describe("@foxworth/boundary lifecycle", () => {
  it("realizationIdsFor mints host-owned IDs from the version", async () => {
    const compiled = await compileInteractions(interactions);
    expect(realizationIdsFor(compiled, "v1")).toEqual({
      create: { direct: "todos.create:direct:v1" },
      list: { direct: "todos.list:direct:v1" },
    });

    const implementations = implementInteractions(interactions, {
      create: (input) => ({ id: "todo-1", title: input.title }),
      list: () => [{ id: "todo-1", title: "Ship Boundary" }],
    });
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:direct-helpers:1",
      implementations,
      realizationIds: realizationIdsFor(compiled, "v1"),
    });
    const projection = await projectInteractions(compiled, {
      list: { interaction: compiled.handles.list, modes: ["direct"] },
      create: { interaction: compiled.handles.create, modes: ["direct"] },
    });
    const result = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    const listed = await result.binding.connect().call(projection.handles.list);
    expect(listed).toEqual([{ id: "todo-1", title: "Ship Boundary" }]);
  });

  it("projectSurface, surface.all, and admitWhen compose a closed surface", async () => {
    const compiled = await compileInteractions(interactions);
    const all = await projectSurface(compiled, surface.all(interactions));
    expect(Object.keys(all.handles).sort()).toEqual(["create", "list"]);
    const listOnly = await projectSurface(compiled, surface(interactions, { call: ["list"] }));
    expect(Object.keys(listOnly.handles)).toEqual(["list"]);
    expect(listOnly.projectionDigest).not.toBe(all.projectionDigest);
    const explicit = await projectInteractions(compiled, { list: { interaction: compiled.handles.list, modes: ["direct"] } });
    expect(explicit.projectionDigest).toBe(listOnly.projectionDigest);
    expect(() => surface(interactions, { call: ["list", "list"] })).toThrow(expect.objectContaining({ code: "INVALID_SURFACE" }));
    const foreign = {
      list: interactions.list,
      create: defineInteraction({ id: "todos.create", input: interactions.create.input, output: interactions.create.output }),
    };
    await expect(projectSurface(compiled, surface(foreign, { call: ["create"] }))).rejects.toMatchObject({ code: "FOREIGN_HANDLE" });

    const implementations = implementInteractions(interactions, {
      create: (input) => ({ id: "todo-1", title: input.title }),
      list: () => [{ id: "todo-1", title: "Ship Boundary" }],
    });
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:project-all:1",
      implementations,
      realizationIds: realizationIdsFor(compiled, "v1"),
    });
    const result = await bindSurface(listOnly, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    const listed = await result.binding.connect().call(listOnly.handles.list);
    expect(listed).toEqual([{ id: "todo-1", title: "Ship Boundary" }]);

    const admit = admitWhen(
      (ctx: { kind: string }) => ctx.kind === "screen",
      "screen only",
    );
    expect(await admit({ context: { kind: "screen" } } as AdmissionRequest<{
      kind: string;
    }>)).toEqual({ decision: "allow" });
    expect(await admit({ context: { kind: "agent" } } as AdmissionRequest<{
      kind: string;
    }>)).toEqual({ decision: "deny", reason: "screen only" });
  });

  it("authors portable and Zod contracts without putting annotations in identity", async () => {
    const zodInteraction = defineInteraction({
      id: "todos.annotated-create",
      input: z.strictObject({
        title: z.string().min(1).describe("Human-readable title"),
      }),
      output: z.strictObject({ id: z.string() }).describe("Created todo"),
      errors: {
        duplicate: z.strictObject({ title: z.string() }).describe("Duplicate title"),
      },
      summary: "Create a todo",
      description: "Creates one durable todo.",
      annotations: { audience: "application" },
      reads: ["todos"],
      changes: ["todos"],
    });
    const differentlyDescribed = defineInteraction({
      id: "todos.annotated-create",
      input: z.strictObject({
        title: z.string().min(1).describe("Different presentation"),
      }),
      output: z.strictObject({ id: z.string() }).describe("Different output docs"),
      errors: {
        duplicate: z.strictObject({ title: z.string() }).describe("Different error docs"),
      },
      reads: ["todos"],
      changes: ["todos"],
    });

    const compiled = await compileInteractions(
      { create: zodInteraction },
      { schemas: [zodSchemaAdapter] },
    );
    const other = await compileInteractions({ create: differentlyDescribed });
    const descriptor = compiled.program.interactions[0]!;
    expect(descriptor.docs).toEqual({
      summary: "Create a todo",
      description: "Creates one durable todo.",
    });
    expect(descriptor.annotations).toMatchObject({
      audience: "application",
      schemas: {
        input: { properties: { title: { description: "Human-readable title" } } },
        output: { description: "Created todo" },
        errors: { duplicate: { description: "Duplicate title" } },
      },
    });
    expect(other.handles.create.contractDigest).toBe(
      compiled.handles.create.contractDigest,
    );
    expect(other.program.programDigest).toBe(compiled.program.programDigest);

    const transform = defineInteraction({
        id: "todos.transform",
        input: z.string().transform((value) => value.length),
        output: z.number(),
      });
    await expect(
      compileInteractions({ transform }),
    ).rejects.toMatchObject({
      code: "SCHEMA_RUNTIME_TRANSFORM",
      path: "todos.transform.input",
    });
    expect(() =>
      defineInteraction({
        id: "todos.reserved-annotation",
        output: z.string(),
        annotations: { schemas: {} },
      }),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_DECLARATION",
      path: "defineInteraction.annotations.schemas",
    }));
  });

  it("compiles Standard Schema authoring through an explicit Host adapter", async () => {
    type TestSchema<Value extends JsonValue> = Readonly<{
      family: "test-schema";
      contract: JsonSchema;
      "~standard": Readonly<{
        types?: Readonly<{ output: Value }>;
      }>;
    }>;
    const testSchema = <Value extends JsonValue>(
      contract: JsonSchema,
    ): TestSchema<Value> => Object.freeze({
      family: "test-schema",
      contract,
      "~standard": Object.freeze({}),
    }) as TestSchema<Value>;
    const adapter: SchemaAdapter<TestSchema<JsonValue>> = Object.freeze({
      supports(value: unknown): value is TestSchema<JsonValue> {
        return (
          value !== null &&
          typeof value === "object" &&
          "family" in value &&
          value.family === "test-schema"
        );
      },
      compile(
        schema: TestSchema<JsonValue>,
        context: SchemaCompilationContext,
      ) {
        return {
          contract: schema.contract,
          annotations: { adapter: "test-schema", role: context.role },
        };
      },
    });
    const custom = defineInteraction({
      id: "todos.custom-schema",
      input: testSchema<{ readonly title: string }>(CreateInput),
      output: testSchema<{ readonly id: string; readonly title: string }>(Todo),
    });

    await expect(compileInteractions({ custom })).rejects.toMatchObject({
      code: "INVALID_DECLARATION",
      path: "todos.custom-schema.input",
    });
    const compiled = await compileInteractions(
      { custom },
      { schemas: [adapter] },
    );
    expect(compiled.program.interactions[0]).toMatchObject({
      contract: {
        id: "todos.custom-schema",
        inputSchema: CreateInput,
        outputSchema: Todo,
      },
      annotations: {
        schemas: {
          input: { adapter: "test-schema", role: "input" },
          output: { adapter: "test-schema", role: "output" },
        },
      },
    });
  });

  it("composes compiled records with typed handles and diffs contract identity", async () => {
    const createOnly = await compileInteractions({ create: interactions.create });
    const listOnly = await compileInteractions({ list: interactions.list });
    const composed = await composeCompiledInteractions(createOnly, listOnly);

    expect(Object.keys(composed.handles)).toEqual(["create", "list"]);
    expect(composed.program.interactions.map((entry) => entry.contract.id)).toEqual([
      "todos.create",
      "todos.list",
    ]);
    expect(diffCompiledInteractions(createOnly, composed)).toEqual({
      added: ["todos.list"],
      removed: [],
      changed: [],
      unchanged: ["todos.create"],
    });

    const changedCreate = await compileInteractions({
      create: defineInteraction({
        id: "todos.create",
        input: CreateInput,
        output: Todo,
        reads: ["todos", "accounts"],
        changes: ["todos"],
      }),
    });
    expect(diffCompiledInteractions(createOnly, changedCreate)).toEqual({
      added: [],
      removed: [],
      changed: ["todos.create"],
      unchanged: [],
    });

    await expect(
      composeCompiledInteractions(createOnly, createOnly),
    ).rejects.toMatchObject({
      code: "DUPLICATE_INTERACTION_ALIAS",
      path: "interactions.create",
    });
    await expect(
      composeCompiledInteractions(
        createOnly,
        await compileInteractions({ duplicate: interactions.create }),
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_INTERACTION_ID" });
  });

  it("compiles, installs, atomically binds, and calls with exact context", async () => {
    type Context = { readonly actor: string };
    const context: Context = { actor: "fox" };
    const seen: Context[] = [];
    const compiled = await compileInteractions(interactions);
    const implementations = implementInteractions<typeof interactions, Context>(
      interactions,
      {
        async create(input, received) {
          seen.push(received);
          if (input.title === "taken") {
            throw declaredInteractionError(
              interactions.create,
              "duplicateTitle",
              { title: input.title },
            );
          }
          return { id: "todo-1", title: input.title };
        },
        async list(received) {
          seen.push(received);
          return [{ id: "todo-1", title: received.actor }];
        },
      },
    );
    const { installation } = await installInteractions<
      typeof interactions,
      Context
    >(compiled, {
      installationId: "deploy:todos:1",
      implementations,
      realizationIds: {
        create: { direct: "realization:create:1" },
        list: { direct: "realization:list:1" },
      },
    });
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct"] },
      list: { interaction: compiled.handles.list, modes: ["direct"] },
    });
    const admissions: AdmissionRequest<Context>[] = [];
    const result = await bindSurface(projection, installation, {
      admit(request) {
        admissions.push(request);
        return { decision: "allow" };
      },
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;

    const caller = result.binding.connect();
    await expect(
      caller.call(projection.handles.create, { title: "write" }, context),
    ).resolves.toEqual({ id: "todo-1", title: "write" });
    await expect(caller.call(projection.handles.list, context)).resolves.toEqual([
      { id: "todo-1", title: "fox" },
    ]);
    expect(seen).toEqual([context, context]);
    expect(admissions.map((request) => request.context)).toEqual([
      context,
      context,
    ]);

    try {
      await caller.call(
        projection.handles.create,
        { title: "taken" },
        context,
      );
      throw new Error("expected declared error");
    } catch (error) {
      expect(
        isDeclaredInteractionError(
          error,
          projection.handles.create,
          "duplicateTitle",
        ),
      ).toBe(true);
    }

    const resolved = result.binding.resolve("todos.create");
    expect(resolved?.modes[0]).toMatchObject({
      mode: "direct",
      realizationId: "realization:create:1",
    });
    expect(result.controller.revoke()).toBe(true);
    expect(result.controller.revoke()).toBe(false);
    await expect(caller.callRaw(resolved!, { title: "later" }, context)).resolves
      .toMatchObject({
        certainty: "not-started",
        result: { kind: "fault", cause: "revoked" },
      });
  });

  it("keeps request proposal creation structural and separate from direct calls", async () => {
    type Context = { readonly actor: string };
    const compiled = await compileInteractions({ create: interactions.create });
    const implementations = implementInteractions<
      { readonly create: typeof interactions.create },
      Context
    >(
      { create: interactions.create },
      {
        create(input) {
          return { id: "todo-direct", title: input.title };
        },
      },
    );
    const context: Context = { actor: "fox" };
    let requestContext: Context | undefined;
    let requestPolicy: RequestInvocationPolicy | undefined;
    const requestSource = {
      interaction: compiled.handles.create,
      controlDigest: compiled.handles.create.contractDigest,
      previewSchema: Todo,
      request(input: { readonly title: string }, received: Context, policy: RequestInvocationPolicy) {
        requestContext = received;
        requestPolicy = policy;
        return { id: "proposal-1", title: input.title };
      },
    };
    const requests = createControlRequestContributions<
      { readonly create: typeof interactions.create },
      Context
    >(compiled, {
      create: requestSource,
    });
    Object.assign(requestSource, {
      controlDigest: `sha256:${"0".repeat(64)}`,
      previewSchema: portableSchema({ type: "null" }),
      request() {
        throw new Error("mutated request capability must not run");
      },
    });
    await expect(
      installInteractions<
        { readonly create: typeof interactions.create },
        Context
      >(compiled, {
        installationId: "deploy:forged-request:1",
        implementations,
        requests: {} as never,
        realizationIds: {
          create: {
            direct: "realization:create:direct:forged",
            request: "realization:create:request:forged",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST_BINDING",
      path: "requests",
    });
    await expect(
      installInteractions<
        { readonly create: typeof interactions.create },
        Context
      >(compiled, {
        installationId: "deploy:reused-realization:1",
        implementations,
        requests,
        realizationIds: {
          create: {
            direct: "realization:create:shared:1",
            request: "realization:create:shared:1",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "CATALOG_DUPLICATE_REALIZATION",
      path: "catalog.interactions[0].request.realizationId",
    });
    const { installation } = await installInteractions<
      { readonly create: typeof interactions.create },
      Context
    >(compiled, {
      installationId: "deploy:request:1",
      implementations,
      requests,
      realizationIds: {
        create: {
          direct: "realization:create:direct:1",
          request: "realization:create:request:1",
        },
      },
    });
    const projection = await projectInteractions(compiled, {
      create: {
        interaction: compiled.handles.create,
        modes: ["direct", "request"],
      },
    });
    const result = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    const caller = result.binding.connect();
    await expect(
      caller.request(projection.handles.create, { title: "review" }, context),
    ).resolves.toEqual({ id: "proposal-1", title: "review" });
    expect(requestContext).toBe(context);
    expect(Object.isFrozen(requestPolicy)).toBe(true);
    expect(requestPolicy).toEqual({
      mode: "request",
      bindingDigest: result.binding.manifest.bindingDigest,
      projectionDigest: result.binding.manifest.projectionDigest,
      installationId: installation.installationId,
      installationDigest: installation.manifest.installationDigest,
      expectedProgramDigest: result.binding.manifest.expectedProgramDigest,
      actualProgramDigest: result.binding.manifest.actualProgramDigest,
      installationProgramDigest: installation.manifest.program.programDigest,
      interactionId: interactions.create.id,
      expectedContractDigest:
        result.binding.manifest.interactions.find((entry) => entry.mode === "request")!
          .expectedContractDigest,
      actualContractDigest:
        result.binding.manifest.interactions.find((entry) => entry.mode === "request")!
          .actualContractDigest,
      realizationId: "realization:create:request:1",
    });
    expect(result.binding.manifest.interactions.map((entry) => entry.mode)).toEqual([
      "direct",
      "request",
    ]);
    expect(
      installation.manifest.catalog.interactions.find(
        (entry) => entry.interactionId === interactions.create.id,
      ),
    ).toEqual({
      interactionId: interactions.create.id,
      direct: { realizationId: "realization:create:direct:1" },
      request: {
        realizationId: "realization:create:request:1",
        controlDigest: compiled.handles.create.contractDigest,
        previewSchema: Todo,
      },
    });
  });

  it("pins changed request identities in separate Bindings instead of inventing a CompiledSurface constraint", async () => {
    const compiled = await compileInteractions({ create: interactions.create });
    const implementations = implementInteractions(
      { create: interactions.create },
      {
        create(input) {
          return { id: "todo-direct", title: input.title };
        },
      },
    );
    const projection = await projectInteractions(compiled, {
      create: {
        interaction: compiled.handles.create,
        modes: ["request"],
      },
    });
    expect(projection.manifest.interactions[0]).not.toHaveProperty("request");

    async function bindRequestIdentity(
      suffix: string,
      controlDigest: `sha256:${string}`,
    ) {
      const requests = createControlRequestContributions(compiled, {
        create: {
          interaction: compiled.handles.create,
          controlDigest,
          previewSchema: Todo,
          request(input) {
            return { id: `proposal-${suffix}`, title: input.title };
          },
        },
      });
      const { installation } = await installInteractions(compiled, {
        installationId: `deploy:request-identity:${suffix}`,
        implementations,
        requests,
        realizationIds: {
          create: {
            direct: `realization:request-identity:${suffix}:direct`,
            request: `realization:request-identity:${suffix}:request`,
          },
        },
      });
      return bindSurface(projection, installation, {
        admit: () => ({ decision: "allow" }),
      });
    }

    const firstControlDigest = `sha256:${"1".repeat(64)}` as `sha256:${string}`;
    const secondControlDigest = `sha256:${"2".repeat(64)}` as `sha256:${string}`;
    const first = await bindRequestIdentity("first", firstControlDigest);
    expect(first.status).toBe("bound");
    if (first.status !== "bound") return;
    expect(first.binding.manifest.interactions[0]?.request?.controlDigest).toBe(
      firstControlDigest,
    );

    const second = await bindRequestIdentity("second", secondControlDigest);
    expect(second.status).toBe("bound");
    if (second.status !== "bound") return;
    expect(second.binding.manifest.interactions[0]?.request?.controlDigest).toBe(
      secondControlDigest,
    );
    expect(first.binding.manifest.bindingDigest).not.toBe(
      second.binding.manifest.bindingDigest,
    );
    expect(first.binding.manifest.interactions[0]?.request?.controlDigest).toBe(
      firstControlDigest,
    );
  });

  it("narrows declared errors only against the exact expected contract", async () => {
    const compiled = await compileInteractions({ create: interactions.create });
    const implementations = implementInteractions(
      { create: interactions.create },
      {
        create(input) {
          throw declaredInteractionError(
            interactions.create,
            "duplicateTitle",
            { title: input.title },
          );
        },
      },
    );
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:declared-error-identity:1",
      implementations,
      realizationIds: {
        create: { direct: "realization:declared-error-identity:create:1" },
      },
    });
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct"] },
    });
    const bound = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (bound.status !== "bound") throw new Error("expected bound");

    const incompatibleDefinition = defineInteraction({
      id: interactions.create.id,
      input: CreateInput,
      output: Todo,
      errors: {
        duplicateTitle: portableSchema<{ readonly id: number }>({
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false,
        }),
      },
      reads: ["todos"],
      changes: ["todos"],
    });
    const incompatibleCompiled = await compileInteractions({
      create: incompatibleDefinition,
    });
    const incompatibleProjection = await projectInteractions(
      incompatibleCompiled,
      {
        create: {
          interaction: incompatibleCompiled.handles.create,
          modes: ["direct"],
        },
      },
    );
    expect(incompatibleProjection.handles.create.interactionId).toBe(
      projection.handles.create.interactionId,
    );
    expect(incompatibleProjection.handles.create.contractDigest).not.toBe(
      projection.handles.create.contractDigest,
    );

    let caught: unknown;
    try {
      await bound.binding.connect().call(
        projection.handles.create,
        { title: "taken" },
      );
    } catch (error) {
      caught = error;
    }
    expect(
      isDeclaredInteractionError(
        caught,
        projection.handles.create,
        "duplicateTitle",
      ),
    ).toBe(true);
    expect(
      isDeclaredInteractionError(
        caught,
        incompatibleProjection.handles.create,
        "duplicateTitle",
      ),
    ).toBe(false);
  });

  it("captures admission authority before asynchronous binding work", async () => {
    const compiled = await compileInteractions({ list: interactions.list });
    const implementations = implementInteractions(
      { list: interactions.list },
      {
        async list() {
          return [];
        },
      },
    );
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:admission-capture:1",
      implementations,
      realizationIds: {
        list: { direct: "realization:admission-capture:list:1" },
      },
    });
    const projection = await projectInteractions(compiled, {
      list: { interaction: compiled.handles.list, modes: ["direct"] },
    });
    let originalCalls = 0;
    let replacementCalls = 0;
    const options: { admit: Admission<void> } = {
      admit() {
        originalCalls += 1;
        return { decision: "allow" as const };
      },
    };

    const pending = bindSurface(projection, installation, options);
    options.admit = () => {
      replacementCalls += 1;
      return { decision: "deny" as const, reason: "mutated admission" };
    };
    const result = await pending;
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;

    await expect(result.binding.connect().call(projection.handles.list)).resolves
      .toEqual([]);
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);

    const failedAdmission = await bindSurface(projection, installation, {
      admit() {
        throw new Error("private policy failure");
      },
    });
    expect(failedAdmission.status).toBe("bound");
    if (failedAdmission.status !== "bound") return;
    await expect(failedAdmission.binding.connect().call(projection.handles.list))
      .rejects.toMatchObject({
        certainty: "not-started",
        cause: "admission-failed",
      });
  });

  it("lets the host revoke one Installation across existing and future Bindings", async () => {
    const compiled = await compileInteractions({ list: interactions.list });
    let dispatches = 0;
    const implementations = implementInteractions(
      { list: interactions.list },
      {
        list() {
          dispatches += 1;
          return [];
        },
      },
    );
    const { installation, controller } = await installInteractions(compiled, {
      installationId: "deploy:revocable:1",
      implementations,
      realizationIds: { list: { direct: "realization:list:revocable:1" } },
    });
    const projection = await projectInteractions(compiled, {
      list: { interaction: compiled.handles.list, modes: ["direct"] },
    });
    const result = await bindSurface(projection, installation, {
      admit() {
        controller.revoke();
        return { decision: "allow" };
      },
    });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    expect(installation).not.toHaveProperty("revoke");
    expect(result.binding).not.toHaveProperty("revoke");

    await expect(result.binding.connect().call(projection.handles.list)).rejects
      .toMatchObject({ certainty: "not-started", cause: "revoked" });
    expect(dispatches).toBe(0);
    expect(controller.revoked).toBe(true);
    expect(controller.revoke()).toBe(false);

    const afterRevocation = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(afterRevocation).toMatchObject({
      status: "unrealized",
      report: {
        installationId: "deploy:revocable:1",
        issues: [{ reason: "installation-revoked" }],
      },
    });
  });

  it("keeps declared zero-mode interactions known but unavailable", async () => {
    const compiled = await compileInteractions({ list: interactions.list });
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:known-unavailable:1",
      bindings: [],
      realizationIds: {},
    });
    const projection = await projectInteractions(compiled, {
      list: { interaction: compiled.handles.list, modes: ["direct"] },
    });
    const result = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result).toMatchObject({
      status: "unrealized",
      report: {
        issues: [{
          interactionId: "todos.list",
          mode: "direct",
          reason: "missing-direct",
        }],
      },
    });
  });

  it("lowers native interactions and keeps native targets behind dispatch", async () => {
    type Context = { readonly trace: string };
    const route = Object.freeze({ method: "POST", path: "/todos" });
    const native = { create: route } as const;
    const definitions = { create: interactions.create } as const;
    const compiled = await compileInteractions<typeof native, typeof definitions>(
      native,
      { lower: () => interactions.create },
    );
    const context: Context = { trace: "trace-1" };
    const nativeBinding = {
      interaction: compiled.handles.create,
      target: route,
      dispatch(
        request: NativeDispatchRequest<typeof interactions.create, typeof route, Context>,
      ) {
        expect(request.target).toBe(route);
        expect(request.context).toBe(context);
        return request.outcomes.returned({
          id: "native-1",
          title: request.input.title,
        });
      },
    };
    const { installation } = await installInteractions<
      typeof definitions,
      Context
    >(compiled, {
      installationId: "deploy:native:1",
      bindings: [nativeBinding],
      realizationIds: { create: { direct: "realization:native:1" } },
    });
    Object.assign(nativeBinding, {
      interaction: Object.freeze({}),
      target: Object.freeze({ method: "DELETE", path: "/everything" }),
      dispatch() {
        throw new Error("mutated native dispatcher must not run");
      },
    });
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["direct"] },
    });
    const result = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (result.status !== "bound") throw new Error("expected bound");
    await expect(
      result.binding
        .connect()
        .call(projection.handles.create, { title: "native" }, context),
    ).resolves.toEqual({ id: "native-1", title: "native" });
  });

  it("reports the whole unrealized projection without exposing a partial caller", async () => {
    const compiled = await compileInteractions(interactions);
    await expect(projectInteractions(compiled, {})).resolves.toMatchObject({ handles: {} });
    const implementations = implementInteractions(interactions, {
      create: (input) => ({ id: "1", title: input.title }),
      list: () => [],
    });
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:direct-only:1",
      implementations,
      realizationIds: {
        create: { direct: "realization:create:1" },
        list: { direct: "realization:list:1" },
      },
    });
    const projection = await projectInteractions(compiled, {
      create: { interaction: compiled.handles.create, modes: ["request"] },
      list: { interaction: compiled.handles.list, modes: ["request"] },
    });
    const result = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(result).toMatchObject({
      status: "unrealized",
      report: {
        issues: [
          { interactionId: "todos.create", reason: "missing-request" },
          { interactionId: "todos.list", reason: "missing-request" },
        ],
      },
    });
    expect(result).not.toHaveProperty("binding");
  });
});
