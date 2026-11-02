import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgentUIStream, ToolLoopAgent, tool, toolSearch, stepCountIs, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
import type { RoomHost } from "./host";

/** The callback receives only deferred tools already selected for this generation. */
export function rankSelectedProjectionTools({ query, tools }: { query: string; tools: Array<{ name: string; description?: string }> }) {
  const words = query.toLowerCase().split(/\s+/u);
  return tools.filter((entry) => words.some((word) => `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(word))).map((entry) => entry.name);
}

/** A deterministic, stream-only local provider fixture; no external inference. */
export const fixtureModel: LanguageModel = {
  specificationVersion: "v4", provider: "boundary-fixture", modelId: "todo-guide", supportedUrls: {},
  async doGenerate() { throw new Error("fixture supports streaming only"); },
  async doStream(options) {
    const prompt = JSON.stringify(options.prompt);
    const last = options.prompt.at(-1);
    const results = last?.role === "tool" ? last.content : [];
    const lastResult = results.at(-1);
    const previous = lastResult?.type === "tool-result" ? lastResult.toolName : undefined;
    let call: { name: string; input: object } | undefined;
    if (!previous) call = { name: "tool_search", input: { query: "todo complete" } };
    else if (previous === "tool_search") call = { name: "listTodos", input: {} };
    else if (previous === "listTodos" && /complete\s+\d+/iu.test(prompt)) call = { name: "proposeCompleteTodo", input: { id: Number(prompt.match(/complete\s+(\d+)/iu)?.[1]) } };
    const text = previous === "proposeCompleteTodo" ? "A completion proposal is ready. Review it below and approve it yourself." : "The board is available below. Ask ‘complete 1’ to create a proposal; only your approval changes the board.";
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (call) controller.enqueue({ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) });
      else { controller.enqueue({ type: "text-start", id: "reply" }); controller.enqueue({ type: "text-delta", id: "reply", delta: text }); controller.enqueue({ type: "text-end", id: "reply" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_calls" : "stop" }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } });
      controller.close();
    } }) };
  },
};

export function roomAgent(host: RoomHost, model: LanguageModel = fixtureModel) {
  // The read handle comes from the Binding's selected CompiledSurface. Completion is
  // absent. The second tool only records a host-owned proposal.
  const listHandle = host.readProjection.handles.list;
  return new ToolLoopAgent({ model, maxRetries: 0, stopWhen: stepCountIs(4),
    instructions: "Search the selected tools, read the board, and propose completion only when asked. A proposal does not change a todo. Human approval is outside your tool catalog.",
    tools: {
      tool_search: toolSearch({ maxResults: 5, search: rankSelectedProjectionTools }),
      listTodos: tool({ description: `Read todos through ${listHandle.interactionId}.`, inputSchema: z.object({}).strict(), deferLoading: true, execute: () => host.list() }),
      proposeCompleteTodo: tool({ description: "Propose completing one open todo. Human approval is required.", inputSchema: z.object({ id: z.number().int().positive() }).strict(), deferLoading: true, execute: ({ id }) => host.propose(id) }),
    },
  });
}

export function localModel(): LanguageModel {
  const id = process.env.BOUNDARY_ROOM_MODEL;
  if (!id) return fixtureModel;
  return createOpenAICompatible({ name: "ollama-local", baseURL: "http://127.0.0.1:11434/v1", fetch: (url, init) => fetch(url, { ...init, redirect: "error" }) })(id);
}

export async function agentStream(host: RoomHost, messages: UIMessage[], signal: AbortSignal, checkpoint: (message: UIMessage) => void, model: LanguageModel = fixtureModel) {
  return createAgentUIStream({ agent: roomAgent(host, model), uiMessages: messages, abortSignal: signal,
    onError: () => "The local reply was interrupted. No effect was retried.",
    onUIMessageStepEnd: ({ responseMessage }) => checkpoint(structuredClone(responseMessage)),
  });
}
