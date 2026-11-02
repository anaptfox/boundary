import { isWebMcpAvailable, resolveModelContext } from "./host";
import type { ModelContextPort, ModelContextActivityEvent, WebMcpActivity, RegisterWebMcpBindingOptions, RegisterWebMcpTransportOptions, WebMcpContextRequest, WebMcpFrame, WebMcpRegistration, WebMcpSyncOptions, WebMcpToolSummary } from "./types";
import { PreparedTool, hostNameConflict, prepareCatalog } from "./catalog";
import { LiveTool, executeTool } from "./execute";
import { fail } from "./tools";

function requireModelContext(modelContext?: ModelContextPort): ModelContextPort {
  const resolvedPort = resolveModelContext(modelContext);
  if (!resolvedPort || !isWebMcpAvailable(resolvedPort)) {
    fail(
      "UNSUPPORTED_HOST",
      "modelContext",
      "document.modelContext.registerTool is not available",
    );
  }
  return resolvedPort;
}

async function openWebMcpRegistration<Context>(
  port: ModelContextPort,
  initial: WebMcpSyncOptions<Context>,
  context?: (
    request: WebMcpContextRequest,
  ) => Context | Promise<Context>,
  frame?: WebMcpFrame,
  onActivity?: (activity: WebMcpActivity) => void,
): Promise<WebMcpRegistration<Context>> {

  const live = new Map<string, LiveTool<Context>>();
  let tools: readonly WebMcpToolSummary[] = Object.freeze([]);
  let disposed = false;
  let generation = 0;
  let queue = Promise.resolve();
  const pending = new Set<AbortController>();

  const listen = Boolean(onActivity && port.addEventListener && port.removeEventListener);
  function activity(event: ModelContextActivityEvent) {
    if (disposed || !live.has(event.toolName)) return;
    onActivity?.(Object.freeze({ toolName: event.toolName, state: event.type === "toolcancel" ? "cancelled" : "started" }));
  }

  function setTools(next: readonly WebMcpToolSummary[]) {
    tools = Object.freeze(next.map((entry) => Object.freeze({ ...entry })));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (listen) {
      port.removeEventListener!("toolactivated", activity);
      port.removeEventListener!("toolcancel", activity);
    }
    generation += 1;
    for (const controller of pending) controller.abort();
    pending.clear();
    for (const entry of live.values()) entry.controller.abort();
    live.clear();
    setTools([]);
  }

  async function apply(syncOptions: WebMcpSyncOptions<Context>): Promise<void> {
    if (disposed) {
      fail("DISPOSED_REGISTRATION", "sync", "this WebMCP registration has been disposed");
    }
    const assigned = generation;
    const desired = await prepareCatalog(syncOptions);
    if (disposed || assigned !== generation) return;
    await publish(desired, assigned);
  }

  async function publish(desired: PreparedTool<Context>[], assigned: number): Promise<void> {
    const desiredByName = new Map(desired.map((entry) => [entry.name, entry]));
    const retained = new Set<string>();

    for (const [name, entry] of live) {
      const next = desiredByName.get(name);
      if (next && next.identity === entry.prepared.identity) {
        // This replacement is explicit because the caller supplied it to sync.
        // A normal invocation never discovers or follows another Binding.
        entry.prepared = next;
        retained.add(name);
      }
    }

    const removals: LiveTool<Context>[] = [];
    for (const [name, entry] of live) {
      if (!retained.has(name)) removals.push(entry);
    }
    for (const entry of removals) {
      live.delete(entry.prepared.name);
      entry.controller.abort();
    }

    const additions = desired.filter((entry) => !retained.has(entry.name));
    const added: LiveTool<Context>[] = [];
    try {
      for (const prepared of additions) {
        const controller = new AbortController();
        const entry: LiveTool<Context> = { prepared, controller };
        pending.add(controller);
        try {
          await port.registerTool(
            {
              name: prepared.name,
              ...(prepared.title === undefined ? {} : { title: prepared.title }),
              description: prepared.description,
              inputSchema: prepared.inputSchema as object,
              annotations: {
                readOnlyHint: prepared.readOnlyHint,
                consequentialHint: prepared.consequentialHint,
                ...(prepared.debugging === undefined ? {} : { debugging: prepared.debugging }),
                ...(prepared.untrustedContentHint === undefined
                  ? {}
                  : { untrustedContentHint: prepared.untrustedContentHint }),
              },
              execute: (input, executeOptions) =>
                executeTool(
                  entry,
                  context,
                  input,
                  executeOptions?.signal,
                  frame,
                  executeOptions?.claims,
                ),
            },
            {
              signal: controller.signal,
              ...(prepared.exposedTo === undefined
                ? {}
                : { exposedTo: prepared.exposedTo }),
            },
          );
        } catch (error) {
          pending.delete(controller);
          controller.abort();
          if (disposed || assigned !== generation) {
            for (const addedEntry of added) {
              live.delete(addedEntry.prepared.name);
              addedEntry.controller.abort();
            }
            return;
          }
          if (hostNameConflict(error)) {
            fail(
              "INCOMPATIBLE_LIVE_REPLACEMENT",
              `tools.${prepared.interactionId}.name`,
              `tool name ${prepared.name} is already registered and cannot be replaced until reload`,
            );
          }
          fail(
            "REGISTRATION_FAILED",
            `tools.${prepared.interactionId}`,
            error instanceof Error ? error.message : "tool registration failed",
          );
        }
        pending.delete(controller);
        if (disposed || assigned !== generation) {
          controller.abort();
          for (const addedEntry of added) {
            live.delete(addedEntry.prepared.name);
            addedEntry.controller.abort();
          }
          return;
        }
        live.set(prepared.name, entry);
        added.push(entry);
      }
    } catch (error) {
      for (const entry of added) {
        live.delete(entry.prepared.name);
        entry.controller.abort();
      }
      throw error;
    }

    setTools(desired.map((entry) => entry.summary));
  }

  function enqueue(
    path: "sync",
    runApply: () => Promise<void>,
  ): Promise<void> {
    const assigned = ++generation;
    for (const controller of pending) controller.abort();
    const run = queue.then(async () => {
      if (disposed) {
        fail("DISPOSED_REGISTRATION", path, "this WebMCP registration has been disposed");
      }
      if (assigned !== generation) return;
      await runApply();
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function sync(syncOptions: WebMcpSyncOptions<Context>): Promise<void> {
    return enqueue("sync", () => apply(syncOptions));
  }

  const registration: WebMcpRegistration<Context> = {
    get tools() {
      return tools;
    },
    sync,
    dispose,
  };

  try {
    await sync(initial);
    if (listen) {
      port.addEventListener!("toolactivated", activity);
      port.addEventListener!("toolcancel", activity);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return Object.freeze(registration);
}

export async function registerWebMcpBinding<Context>(
  options: RegisterWebMcpBindingOptions<Context>,
): Promise<WebMcpRegistration<Context>> {
  if (typeof options.context !== "function") {
    fail(
      "INVALID_TOOL",
      "registerWebMcpBinding.context",
      "context must resolve invocation-scoped host context",
    );
  }
  return openWebMcpRegistration(
    requireModelContext(options.modelContext),
    { caller: options.caller, tools: options.tools },
    options.context,
    undefined,
    options.onActivity,
  );
}

/** Present one already-pinned remote Binding on `document.modelContext`. */
export async function registerWebMcpTransport(
  options: RegisterWebMcpTransportOptions,
): Promise<WebMcpRegistration> {
  return openWebMcpRegistration(
    requireModelContext(options.modelContext),
    { transport: options.transport, tools: options.tools },
    undefined,
    options.frame,
    options.onActivity,
  );
}
