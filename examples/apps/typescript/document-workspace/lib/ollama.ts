import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

export function ollamaUrl(): URL {
  const url = new URL(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OLLAMA_BASE_URL must be a loopback HTTP origin");
  }
  return url;
}
const modelSchema = z.object({ name: z.string(), remote_host: z.string().optional(), remote_model: z.string().optional(), capabilities: z.array(z.string()).optional() });

export async function localModels() {
  const response = await fetch(new URL("/api/tags", ollamaUrl()), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("Ollama is unavailable");
  const data = z.object({ models: z.array(modelSchema) }).parse(await response.json());
  const models = data.models.filter((model) => !model.remote_host && !model.remote_model && !/cloud/i.test(model.name)
    && (!model.capabilities || model.capabilities.includes("tools"))).map((model) => model.name);
  const configured = process.env.OLLAMA_MODEL;
  const defaultModel = configured && models.includes(configured) ? configured
    : models.find((name) => name === "qwen3.6:35b-mlx") ?? models.find((name) => name === "llama3.2:3b") ?? models.find((name) => name === "llama3.2:latest") ?? models[0];
  return { models, defaultModel: defaultModel ?? null };
}

export function ollamaModel(name: string, options: { structured?: boolean } = {}) {
  return createOpenAICompatible({
    name: "ollama-local", baseURL: new URL("/v1", ollamaUrl()).href,
    supportsStructuredOutputs: options.structured === true,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  }).chatModel(name);
}
