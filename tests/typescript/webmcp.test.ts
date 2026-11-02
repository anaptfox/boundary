import { afterEach, describe, expect, it } from "vitest";
import { projectInteractions } from "@foxworth/boundary";
import {
  createProtocolHandler,
  fetchTransport,
} from "@foxworth/boundary/http/protocol";
import {
  isWebMcpAvailable,
  registerWebMcpBinding,
  registerWebMcpTransport,
  webMcpTool,
  WebMcpError,
  type ModelContextPort,
  type ModelContextTool,
  type WebMcpContextRequest,
} from "@foxworth/boundary/webmcp";
import { createAdapterFixture } from "./helpers/adapter";

type FakeHost = ModelContextPort & {
  readonly registered: Map<string, ModelContextTool>;
  readonly registerOptions: Map<string, { exposedTo?: readonly string[] }>;
  readonly added: string[];
  readonly removed: string[];
  keepAfterAbort?: boolean;
};

function createFakeHost(options: { keepAfterAbort?: boolean } = {}): FakeHost {
  const registered = new Map<string, ModelContextTool>();
  const registerOptions = new Map<string, { exposedTo?: readonly string[] }>();
  const added: string[] = [];
  const removed: string[] = [];
  const host: FakeHost = {
    registered,
    registerOptions,
    added,
    removed,
    keepAfterAbort: options.keepAfterAbort,
    async registerTool(tool, options) {
      if (registered.has(tool.name)) {
        const error = new Error(`tool ${tool.name} already exists`);
        error.name = "InvalidStateError";
        throw error;
      }
      registered.set(tool.name, tool);
      registerOptions.set(
        tool.name,
        Object.freeze({
          ...(options?.exposedTo === undefined ? {} : { exposedTo: options.exposedTo }),
        }),
      );
      added.push(tool.name);
      options?.signal?.addEventListener("abort", () => {
        if (!host.keepAfterAbort) {
          registered.delete(tool.name);
          registerOptions.delete(tool.name);
          removed.push(tool.name);
        }
      });
    },
  };
  return host;
}

async function invoke(
  host: FakeHost,
  name: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
  claims?: { label?: string; run?: string },
) {
  const registered = host.registered.get(name);
  if (!registered) throw new Error(`missing tool ${name}`);
  return registered.execute(input, {
    ...(signal === undefined ? {} : { signal }),
    ...(claims === undefined ? {} : { claims }),
  });
}

describe("WebMCP Binding adapter", () => {
  const registrations: Array<Readonly<{ dispose(): void }>> = [];

  afterEach(() => {
    for (const registration of registrations) registration.dispose();
    registrations.length = 0;
  });

  it("reports activity only for live registered tools and removes listeners on disposal", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, { list: { interaction: fixture.compiled.handles.list, modes: ["direct"] } });
    const host = createFakeHost();
    const events = new EventTarget();
    host.addEventListener = (type, listener) => events.addEventListener(type, listener as EventListener);
    host.removeEventListener = (type, listener) => events.removeEventListener(type, listener as EventListener);
    const activity: Array<{ toolName: string; state: string }> = [];
    const registration = await registerWebMcpBinding({ binding: await fixture.bind(projection), context: () => ({ role: "owner" as const }), modelContext: host, tools: [webMcpTool(projection.handles.list, { name: "list" })], onActivity: (entry) => activity.push(entry) });
    const emit = (type: string, toolName: string) => events.dispatchEvent(Object.assign(new Event(type), { toolName }));
    emit("toolactivated", "unrelated"); emit("toolactivated", "list"); emit("toolcancel", "list");
    expect(activity).toEqual([{ toolName: "list", state: "started" }, { toolName: "list", state: "cancelled" }]);
    expect(fixture.contexts).toEqual([]);
    registration.dispose(); emit("toolactivated", "list"); expect(activity).toHaveLength(2);
  });

  it("detects document.modelContext and does not follow the retired navigator surface", () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { modelContext: { async registerTool() { return undefined; } } },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { modelContext: { async registerTool() { return undefined; } } },
    });
    try {
      expect(isWebMcpAvailable()).toBe(true);
      Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
      expect(isWebMcpAvailable()).toBe(false);
    } finally {
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
      else delete (globalThis as { document?: unknown }).document;
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("stays import-safe and rejects an unsupported host before compiling a Binding", async () => {
    expect(isWebMcpAvailable()).toBe(false);
    await expect(
      registerWebMcpBinding({
        binding: {} as never,
        tools: [],
        context: () => ({ role: "owner" as const }),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
    await expect(
      registerWebMcpTransport({
        transport: {
          inspect: async () => {
            throw new Error("unreachable");
          },
          invoke: async () => {
            throw new Error("unreachable");
          },
        },
        tools: [],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
  });

  it("registers explicit handles with names, schema/docs annotations, and v1 outcomes", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();
    const context = Object.freeze({ role: "owner" as const, marker: {} });
    const contextRequests: WebMcpContextRequest[] = [];
    const registration = await registerWebMcpBinding({
      binding,
      context: (request) => {
        contextRequests.push(request);
        return context;
      },
      tools: [
        webMcpTool(projection.handles.list, { untrustedContentHint: true }),
        webMcpTool(projection.handles.create, {
          name: "todo_create",
          title: "Add a todo",
        }),
      ],
      modelContext: host,
    });
    registrations.push(registration);

    expect([...host.registered.keys()].sort()).toEqual([
      "todo_create",
      "todos.list",
    ]);
    expect(JSON.stringify(registration.tools)).not.toContain("todos.hidden");
    expect(registration.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        interactionId: "todos.list",
        description: "Read the current todo collection.",
        readOnlyHint: true,
        untrustedContentHint: true,
      }),
      expect.objectContaining({
        interactionId: "todos.create",
        name: "todo_create",
        readOnlyHint: false,
      }),
    ]));
    const createTool = host.registered.get("todo_create")!;
    const input = createTool.inputSchema as {
      properties: { title: Record<string, unknown> };
    };
    expect(input.properties.title).toMatchObject({
      title: "What needs doing?",
      description: "A short next action.",
    });
    expect(input.properties.title).not.toHaveProperty("role");
    expect(input.properties.title).not.toHaveProperty("control");
    expect(createTool.annotations).toEqual({
      readOnlyHint: false,
      consequentialHint: true,
    });

    await expect(
      invoke(host, "todo_create", { title: "From WebMCP" }),
    ).resolves.toMatchObject({
      version: 1,
      interactionId: "todos.create",
      mode: "direct",
      certainty: "completed",
      result: {
        kind: "returned",
        value: { id: 1, title: "From WebMCP" },
      },
    });
    expect(fixture.contexts).toEqual([context]);
    expect(contextRequests).toHaveLength(1);
    expect(contextRequests[0]).toMatchObject({
      interactionId: "todos.create",
      mode: "direct",
    });
    expect(contextRequests[0]?.signal.aborted).toBe(false);
  });

  it("registers a remote Binding through an explicit transport", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const protocol = createProtocolHandler({
      binding,
      context: () => Object.freeze({ role: "owner" as const, marker: {} }),
      path: "/_boundary/agent",
    });
    const host = createFakeHost();
    const registration = await registerWebMcpTransport({
      transport: fetchTransport({
        baseUrl: "http://test.local/_boundary/agent",
        fetch: (url, init) => protocol(new Request(url, init)),
      }),
      tools: [
        webMcpTool(projection.handles.list, { untrustedContentHint: true }),
        webMcpTool(projection.handles.create),
      ],
      modelContext: host,
    });
    registrations.push(registration);

    expect(registration.tools.map((entry) => entry.name).sort()).toEqual([
      "todos.create",
      "todos.list",
    ]);
    await expect(
      invoke(host, "todos.create", { title: "From WebMCP transport" }),
    ).resolves.toMatchObject({
      version: 1,
      interactionId: "todos.create",
      mode: "direct",
      certainty: "completed",
      result: {
        kind: "returned",
        value: { id: 1, title: "From WebMCP transport" },
      },
    });
    expect(fixture.rows).toEqual([{ id: 1, title: "From WebMCP transport" }]);
  });

  it("forwards exposedTo and re-registers when the origin allowlist changes", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();
    const partner = ["https://trusted-partner.example"];

    expect(() =>
      webMcpTool(projection.handles.list, { exposedTo: [" "] }),
    ).toThrow(WebMcpError);

    const registration = await registerWebMcpBinding({
      binding,
      context: () => ({ role: "owner" as const }),
      tools: [webMcpTool(projection.handles.list, { exposedTo: partner })],
      modelContext: host,
    });
    registrations.push(registration);

    expect(host.registerOptions.get("todos.list")).toEqual({
      exposedTo: partner,
    });
    expect(registration.tools[0]).toMatchObject({ exposedTo: partner });

    await registration.sync({
      binding,
      tools: [webMcpTool(projection.handles.list, { exposedTo: partner })],
    });
    expect(host.added.filter((name) => name === "todos.list")).toHaveLength(1);

    await registration.sync({
      binding,
      tools: [
        webMcpTool(projection.handles.list, {
          exposedTo: ["https://other-partner.example"],
        }),
      ],
    });
    expect(host.removed).toEqual(["todos.list"]);
    expect(host.registerOptions.get("todos.list")).toEqual({
      exposedTo: ["https://other-partner.example"],
    });
  });

  it("requires an explicit WebMCP-safe name for a valid versioned interaction id", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      invalidName: {
        interaction: fixture.compiled.handles.invalidName,
        modes: ["direct"],
      },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();

    await expect(
      registerWebMcpBinding({
        binding,
        context: () => ({ role: "owner" as const }),
        tools: [webMcpTool(projection.handles.invalidName)],
        modelContext: host,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL" });
    expect(host.registered.size).toBe(0);

    const registration = await registerWebMcpBinding({
      binding,
      context: () => ({ role: "owner" as const }),
      tools: [
        webMcpTool(projection.handles.invalidName, { name: "todos.versioned" }),
      ],
      modelContext: host,
    });
    registrations.push(registration);
    expect([...host.registered.keys()]).toEqual(["todos.versioned"]);
    expect(registration.tools[0]).toMatchObject({
      interactionId: "todos.create~v1",
      name: "todos.versioned",
    });
  });

  it("fails the complete preflight when a selected tool has no description", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      untitled: {
        interaction: fixture.compiled.handles.untitled,
        modes: ["direct"],
      },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();

    await expect(
      registerWebMcpBinding({
        binding,
        context: () => ({ role: "owner" as const }),
        tools: [webMcpTool(projection.handles.untitled)],
        modelContext: host,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL" });
    expect(host.registered.size).toBe(0);
  });

  it("keeps request proposals powerless and returns denied, fault, and cancellation evidence", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      create: {
        interaction: fixture.compiled.handles.create,
        modes: ["direct", "request"],
      },
      explode: {
        interaction: fixture.compiled.handles.explode,
        modes: ["direct"],
      },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();
    let role: "owner" | "viewer" = "owner";
    const registration = await registerWebMcpBinding({
      binding,
      context: () => ({ role }),
      tools: [
        webMcpTool(projection.handles.create, {
          mode: "direct",
          name: "create_direct",
          consequentialHint: false,
          debugging: true,
        }),
        webMcpTool(projection.handles.create, {
          mode: "request",
          name: "create_request",
          consequentialHint: true,
        }),
        webMcpTool(projection.handles.explode),
      ],
      modelContext: host,
    });
    registrations.push(registration);

    expect(host.registered.get("create_direct")?.annotations).toEqual({
      readOnlyHint: false,
      consequentialHint: false,
      debugging: true,
    });
    expect(host.registered.get("create_request")?.annotations).toEqual({
      readOnlyHint: false,
      consequentialHint: true,
    });
    const proposed = await invoke(host, "create_request", { title: "Review me" });
    expect(proposed).toMatchObject({
      mode: "request",
      certainty: "not-started",
      result: { kind: "proposed", proposal: { title: "Review me" } },
    });
    expect(JSON.stringify(proposed)).not.toMatch(/approve|grant|execute|reconcile/u);

    role = "viewer";
    const denied = await invoke(host, "create_direct", { title: "Denied" });
    expect(denied).toMatchObject({
      certainty: "not-started",
      result: { kind: "denied", code: "CALL_NOT_ADMITTED" },
    });
    expect(fixture.rows).toEqual([]);

    role = "owner";
    const fault = await invoke(host, "todos.explode");
    expect(fault).toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(JSON.stringify(fault)).not.toContain("private-adapter-secret");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await invoke(
      host,
      "create_direct",
      { title: "Cancelled" },
      controller.signal,
    );
    expect(cancelled).toMatchObject({
      certainty: "not-started",
      result: { kind: "fault", cause: "invalid-invocation" },
    });
    expect(fixture.rows).toEqual([]);
  });

  it("syncs explicit Binding/tool sets without churning retained tools, then disposes", async () => {
    const first = await createAdapterFixture();
    const listed = await projectInteractions(first.compiled, {
      list: { interaction: first.compiled.handles.list, modes: ["direct"] },
    });
    const writable = await projectInteractions(first.compiled, {
      list: { interaction: first.compiled.handles.list, modes: ["direct"] },
      create: { interaction: first.compiled.handles.create, modes: ["direct"] },
    });
    const listedBinding = await first.bind(listed);
    const writableBinding = await first.bind(writable);
    const host = createFakeHost();
    const registration = await registerWebMcpBinding({
      binding: listedBinding,
      context: () => ({ role: "owner" as const }),
      tools: [webMcpTool(listed.handles.list)],
      modelContext: host,
    });
    registrations.push(registration);

    await registration.sync({
      binding: writableBinding,
      tools: [
        webMcpTool(writable.handles.list),
        webMcpTool(writable.handles.create),
      ],
    });
    expect([...host.registered.keys()].sort()).toEqual([
      "todos.create",
      "todos.list",
    ]);
    expect(host.added.filter((name) => name === "todos.list")).toHaveLength(1);

    await registration.sync({
      binding: listedBinding,
      tools: [webMcpTool(listed.handles.list)],
    });
    expect([...host.registered.keys()]).toEqual(["todos.list"]);
    expect(host.removed).toEqual(["todos.create"]);

    registration.dispose();
    registration.dispose();
    expect(host.registered.size).toBe(0);
    await expect(
      registration.sync({
        binding: listedBinding,
        tools: [webMcpTool(listed.handles.list)],
      }),
    ).rejects.toMatchObject({ code: "DISPOSED_REGISTRATION" });
  });

  it("rolls back every newly added tool when an explicit sync only partly registers", async () => {
    const fixture = await createAdapterFixture();
    const listed = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const wider = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
      explode: { interaction: fixture.compiled.handles.explode, modes: ["direct"] },
    });
    const listedBinding = await fixture.bind(listed);
    const widerBinding = await fixture.bind(wider);
    const host = createFakeHost();
    const registration = await registerWebMcpBinding({
      binding: listedBinding,
      context: () => ({ role: "owner" as const }),
      tools: [webMcpTool(listed.handles.list)],
      modelContext: host,
    });
    registrations.push(registration);

    let additions = 0;
    const register = host.registerTool.bind(host);
    host.registerTool = async (tool, options) => {
      additions += 1;
      if (additions === 2) throw new Error("host rejected the second add");
      return register(tool, options);
    };

    await expect(
      registration.sync({
        binding: widerBinding,
        tools: [
          webMcpTool(wider.handles.list),
          webMcpTool(wider.handles.create),
          webMcpTool(wider.handles.explode),
        ],
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_FAILED" });
    expect([...host.registered.keys()]).toEqual(["todos.list"]);
  });

  it("skips stale queued syncs before disposal", async () => {
    const fixture = await createAdapterFixture();
    const listed = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const writable = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const listedBinding = await fixture.bind(listed);
    const writableBinding = await fixture.bind(writable);
    const host = createFakeHost();
    const registration = await registerWebMcpBinding({
      binding: listedBinding,
      context: () => ({ role: "owner" as const }),
      tools: [webMcpTool(listed.handles.list)],
      modelContext: host,
    });
    registrations.push(registration);

    const stale = registration.sync({
      binding: writableBinding,
      tools: [
        webMcpTool(writable.handles.list),
        webMcpTool(writable.handles.create),
      ],
    });
    const latest = registration.sync({
      binding: listedBinding,
      tools: [webMcpTool(listed.handles.list)],
    });
    await Promise.all([stale, latest]);

    expect([...host.registered.keys()]).toEqual(["todos.list"]);
    expect(host.added).toEqual(["todos.list"]);
  });

  it("republishes presentation changes so browser metadata and the local summary agree", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();
    const registration = await registerWebMcpBinding({
      binding,
      context: () => ({ role: "owner" as const }),
      tools: [webMcpTool(projection.handles.list, { title: "Todos" })],
      modelContext: host,
    });
    registrations.push(registration);

    await registration.sync({
      binding,
      tools: [
        webMcpTool(projection.handles.list, {
          title: "Notebook",
          description: "Read the current todo collection.",
          untrustedContentHint: true,
          consequentialHint: true,
          debugging: true,
        }),
      ],
    });
    expect(host.added.filter((name) => name === "todos.list")).toHaveLength(2);
    expect(host.removed).toEqual(["todos.list"]);
    expect(registration.tools[0]).toMatchObject({
      title: "Notebook",
      untrustedContentHint: true,
      consequentialHint: true,
      debugging: true,
    });
    expect(host.registered.get("todos.list")).toMatchObject({
      title: "Notebook",
      description: "Read the current todo collection.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
        consequentialHint: true,
        debugging: true,
      },
    });

    // Removing an explicit hint restores the derived default at the browser.
    await registration.sync({ binding, tools: [webMcpTool(projection.handles.list)] });
    expect(host.registered.get("todos.list")?.annotations).toEqual({
      readOnlyHint: true,
      consequentialHint: false,
    });
    expect(registration.tools[0]).not.toHaveProperty("debugging");
  });

  it.each(["consequentialHint", "debugging", "untrustedContentHint"] as const)(
    "rejects a non-boolean %s before publishing a tool",
    async (annotation) => {
      const fixture = await createAdapterFixture();
      const projection = await projectInteractions(fixture.compiled, {
        list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      });
      expect(() => webMcpTool(projection.handles.list, { [annotation]: "true" } as never))
        .toThrowError(expect.objectContaining({
          code: "INVALID_TOOL",
          path: `webMcpTool.${annotation}`,
        }));
    },
  );

  it("snapshots host-selected annotation values before registration", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const options = { consequentialHint: true, debugging: true };
    const tool = webMcpTool(projection.handles.list, options);
    options.consequentialHint = false;
    options.debugging = false;
    const host = createFakeHost();
    const registration = await registerWebMcpBinding({
      binding: await fixture.bind(projection),
      context: () => ({ role: "owner" as const }),
      tools: [tool],
      modelContext: host,
    });
    registrations.push(registration);
    expect(host.registered.get("todos.list")?.annotations).toEqual({
      readOnlyHint: true,
      consequentialHint: true,
      debugging: true,
    });
  });

  it("registers every projected interaction without a second Binding handshake", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    let inspects = 0;
    const protocol = createProtocolHandler({
      binding,
      context: () => Object.freeze({ role: "owner" as const, marker: {} }),
      path: "/_boundary/agent",
    });
    const host = createFakeHost();
    const registration = await registerWebMcpTransport({
      transport: {
        inspect: async () => {
          inspects += 1;
          return protocol(
            new Request("http://test.local/_boundary/agent/manifest"),
          ).then((response) => response.json());
        },
        invoke: (invocation, framing) =>
          fetchTransport({
            baseUrl: "http://test.local/_boundary/agent",
            fetch: (url, init) => protocol(new Request(url, init)),
          }).invoke(invocation, framing),
      },
      tools: [
        webMcpTool(projection.handles.list),
        webMcpTool(projection.handles.create),
      ],
      modelContext: host,
    });
    registrations.push(registration);
    expect(inspects).toBe(1);
    expect([...host.registered.keys()].sort()).toEqual([
      "todos.create",
      "todos.list",
    ]);

    await expect(
      invoke(host, "todos.create", { title: "Still callable" }),
    ).resolves.toMatchObject({
      result: { kind: "returned", value: { title: "Still callable" } },
    });
  });

  it("stamps per-invoke transport headers from a host frame", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const seen: string[] = [];
    const protocol = createProtocolHandler({
      binding,
      context: (request) => {
        seen.push(request.headers.get("x-host-run") ?? "");
        return Object.freeze({ role: "owner" as const, marker: {} });
      },
      path: "/_boundary/agent",
    });
    const host = createFakeHost();
    const registration = await registerWebMcpTransport({
      transport: fetchTransport({
        baseUrl: "http://test.local/_boundary/agent",
        fetch: (url, init) => protocol(new Request(url, init)),
      }),
      tools: [webMcpTool(projection.handles.create)],
      modelContext: host,
      frame: (request) => ({
        headers: { "x-host-run": request.claims?.run ?? "missing" },
      }),
    });
    registrations.push(registration);

    await invoke(host, "todos.create", { title: "Framed" }, undefined, {
      run: "turn-7",
    });
    expect(seen).toEqual(["turn-7"]);
  });

  it("rejects a live-name collision instead of silently replacing another owner", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost({ keepAfterAbort: true });
    await host.registerTool({
      name: "todos.list",
      description: "foreign",
      execute: () => undefined,
    });
    await expect(
      registerWebMcpBinding({
        binding,
        context: () => ({ role: "owner" as const }),
        tools: [webMcpTool(projection.handles.list)],
        modelContext: host,
      }),
    ).rejects.toBeInstanceOf(WebMcpError);
    await expect(
      registerWebMcpBinding({
        binding,
        context: () => ({ role: "owner" as const }),
        tools: [webMcpTool(projection.handles.list)],
        modelContext: host,
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_LIVE_REPLACEMENT" });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("WebMCP publication lifetime across awaits", () => {
  it("disposal during a pending handshake prevents publication", async () => {
    const fixture = await createAdapterFixture();
    const projection = await projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const host = createFakeHost();
    const tools = [webMcpTool(projection.handles.list)];
    const registration = await registerWebMcpTransport({
      modelContext: host, tools: [],
      transport: { inspect: async () => binding.manifest, invoke: async () => { throw new Error("unused"); } },
    });
    const started = deferred();
    const release = deferred();
    const sync = registration.sync({ tools, transport: {
      inspect: async () => { started.resolve(); await release.promise; return binding.manifest; },
      invoke: async () => { throw new Error("unused"); },
    } });
    await started.promise;
    registration.dispose();
    release.resolve();
    await sync;
    expect(host.added).toEqual([]);
    expect(registration.tools).toEqual([]);
  });

  for (const action of ["dispose", "supersede"] as const) {
    it(`${action} during pending registration aborts publication ownership`, async () => {
      const fixture = await createAdapterFixture();
      const projection = await projectInteractions(fixture.compiled, {
        list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      });
      const binding = await fixture.bind(projection);
      const host = createFakeHost();
      const started = deferred();
      const release = deferred();
      const register = host.registerTool.bind(host);
      host.registerTool = async (tool, options) => {
        await register(tool, options);
        started.resolve();
        await release.promise;
      };
      const transport = { inspect: async () => binding.manifest, invoke: async () => { throw new Error("unused"); } };
      const registration = await registerWebMcpTransport({ modelContext: host, transport, tools: [] });
      const first = registration.sync({ transport, tools: [webMcpTool(projection.handles.list)] });
      await started.promise;
      const latest = action === "dispose"
        ? (registration.dispose(), Promise.resolve())
        : registration.sync({ transport, tools: [] });
      expect(host.registered.size).toBe(0);
      release.resolve();
      await Promise.all([first, latest]);
      expect(host.registered.size).toBe(0);
      expect(registration.tools).toEqual([]);
      registration.dispose();
    });
  }
});
