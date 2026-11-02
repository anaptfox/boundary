import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectionViteLifecycle,
  type ProjectionViteCandidate,
} from "@foxworth/boundary/frameworks/vite";
import { createViteTodoHost } from "../fixtures/runtimes/vite/host";

function candidate(
  generation: string,
  dispose: () => void | Promise<void> = () => undefined,
): ProjectionViteCandidate {
  return {
    generation,
    handler: async () => new Response(generation),
    dispose,
  };
}

describe("@foxworth/boundary/frameworks/vite lifecycle", () => {
  it("serves a bound persisted domain workflow without replaying its write on reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "boundary-vite-test-"));
    const statePath = join(root, "todos.json");
    try {
      const first = await createViteTodoHost(statePath);
      const created = await first.handler(new Request("https://vite.test/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "persisted" }),
      }));
      const createdBody = await created.json() as { result: unknown };
      expect(createdBody.result).toMatchObject({
        kind: "returned",
        value: { title: "persisted" },
      });

      const reloaded = await createViteTodoHost(statePath);
      const listed = await reloaded.handler(new Request("https://vite.test/todos"));
      const listedBody = await listed.json() as { result: unknown };
      expect(listedBody.result).toMatchObject({
        kind: "returned",
        value: [{ title: "persisted" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a validated explicit generation atomically", async () => {
    const seen: string[] = [];
    const lifecycle = createProjectionViteLifecycle({
      entry: ({ previousGeneration }) => {
        const next = previousGeneration === undefined ? "g1" : "g2";
        return candidate(next);
      },
      validate: ({ generation }) => {
        seen.push(generation);
      },
    });

    await expect(lifecycle.start("development")).resolves.toMatchObject({
      state: "ready",
      generation: "g1",
    });
    await expect(lifecycle.replace("development")).resolves.toMatchObject({
      state: "ready",
      generation: "g2",
    });
    expect(seen).toEqual(["g1", "g2"]);
    await lifecycle.dispose();
  });

  it("keeps the previous generation when a candidate fails and disposes the candidate", async () => {
    const rejectedDispose = vi.fn();
    let next = candidate("g1");
    const lifecycle = createProjectionViteLifecycle({
      entry: () => next,
      onDiagnostic: () => {
        throw new Error("observer failed");
      },
      validate: ({ generation }) => {
        if (generation === "bad") throw new Error("syntax error");
      },
    });

    await lifecycle.start("development");
    next = candidate("bad", rejectedDispose);
    const status = await lifecycle.replace("development");

    expect(status).toMatchObject({ state: "ready", generation: "g1" });
    expect(rejectedDispose).toHaveBeenCalledOnce();
    expect(lifecycle.diagnostic()).toMatchObject({
      code: "CANDIDATE_REJECTED",
      generation: "bad",
    });
    await expect(lifecycle.dispatch(new Request("https://vite.test/"))).resolves.toMatchObject({
      status: 200,
    });
    next = candidate("g2");
    await expect(lifecycle.replace("development")).resolves.toMatchObject({
      state: "ready",
      generation: "g2",
    });
    await lifecycle.dispose();
  });

  it("waits for retired work before cleanup and rejects stale clients explicitly", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldDispose = vi.fn();
    let active = true;
    const oldHandler = async () => {
      await held;
      return new Response("old");
    };
    const lifecycle = createProjectionViteLifecycle({
      entry: () => ({
        generation: active ? "g1" : "g2",
        handler: active ? oldHandler : async () => new Response("new"),
        dispose: active ? oldDispose : undefined,
      }),
    });

    await lifecycle.start("development");
    const request = lifecycle.dispatch(new Request("https://vite.test/"));
    active = false;
    await lifecycle.replace("development");
    expect(oldDispose).not.toHaveBeenCalled();
    await expect(
      lifecycle.dispatch(
        new Request("https://vite.test/", {
          headers: { "x-boundary-vite-generation": "g1" },
        }),
      ),
    ).resolves.toMatchObject({ status: 409 });
    release();
    await expect(request).resolves.toMatchObject({ status: 200 });
    await lifecycle.dispose();
    expect(oldDispose).toHaveBeenCalledOnce();
  });

  it("closes once and disposes the published generation without retrying work", async () => {
    const dispose = vi.fn();
    let entries = 0;
    const lifecycle = createProjectionViteLifecycle({
      entry: () => {
        entries += 1;
        return candidate(`g${entries}`, dispose);
      },
    });

    await lifecycle.start("preview");
    await lifecycle.dispose();
    await lifecycle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(entries).toBe(1);
    await expect(lifecycle.replace("preview")).resolves.toMatchObject({
      state: "closed",
    });
  });

  it("does not dispose the current object when the entry rejects that same object", async () => {
    const dispose = vi.fn();
    const current = candidate("g1", dispose);
    let calls = 0;
    const lifecycle = createProjectionViteLifecycle({
      entry: () => { calls += 1; return current; },
      validate: () => { if (calls > 1) throw new Error("reject current"); },
    });
    await lifecycle.start("development");
    expect(dispose).not.toHaveBeenCalled();
    await lifecycle.replace("development");
    expect(dispose).not.toHaveBeenCalled();
    await lifecycle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes a fresh invalid candidate but never disposes the accepted original", async () => {
    const invalidDispose = vi.fn();
    let invalid = false;
    const lifecycle = createProjectionViteLifecycle({
      entry: () => invalid
        ? ({ generation: "bad", handler: undefined, dispose: invalidDispose } as unknown as ProjectionViteCandidate)
        : candidate("g1"),
    });

    await lifecycle.start("development");
    invalid = true;
    await lifecycle.replace("development");
    expect(invalidDispose).toHaveBeenCalledOnce();
    await lifecycle.dispose();
  });

  it("rejects dispatch immediately after close starts and waits for a pending handler", async () => {
    let releaseHandler!: () => void;
    const handlerReady = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let streamCancelled = false;
    const dispose = vi.fn();
    const lifecycle = createProjectionViteLifecycle({
      entry: () => ({
        generation: "g1",
        handler: async () => {
          await handlerReady;
          return new Response(new ReadableStream({ cancel() { streamCancelled = true; } }));
        },
        dispose,
      }),
    });

    await lifecycle.start("development");
    const pending = lifecycle.dispatch(new Request("https://vite.test/"));
    const closing = lifecycle.dispose();
    await expect(lifecycle.dispatch(new Request("https://vite.test/"))).resolves.toMatchObject({ status: 503 });
    expect(dispose).not.toHaveBeenCalled();
    releaseHandler();
    await pending;
    await closing;
    expect(streamCancelled).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stamps null-body responses and observes cancellation failures before release", async () => {
    const dispose = vi.fn();
    const lifecycle = createProjectionViteLifecycle({
      entry: () => ({ generation: "g1", handler: async () => new Response(null), dispose }),
    });
    await lifecycle.start("development");
    const response = await lifecycle.dispatch(new Request("https://vite.test/"));
    expect(response.headers.get("x-boundary-vite-generation")).toBe("g1");
    await lifecycle.dispose();
    expect(dispose).toHaveBeenCalledOnce();

    const cancelDispose = vi.fn();
    const failing = new ReadableStream({
      cancel() { return Promise.reject(new Error("cancel failed")); },
    });
    const cancelling = createProjectionViteLifecycle({
      entry: () => ({ generation: "g1", handler: async () => new Response(failing), dispose: cancelDispose }),
    });
    await cancelling.start("development");
    const cancellingResponse = await cancelling.dispatch(new Request("https://vite.test/"));
    await expect(cancellingResponse.body?.cancel()).rejects.toThrow("cancel failed");
    await cancelling.dispose();
    expect(cancelDispose).toHaveBeenCalledOnce();
  });

  it("tracks a retired active generation and all concurrent closes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const oldDispose = vi.fn();
    let next = false;
    const lifecycle = createProjectionViteLifecycle({
      entry: () => ({
        generation: next ? "g2" : "g1",
        handler: async () => { if (!next) await gate; return new Response(next ? "new" : "old"); },
        dispose: next ? undefined : oldDispose,
      }),
    });
    await lifecycle.start("development");
    const active = lifecycle.dispatch(new Request("https://vite.test/"));
    next = true;
    await lifecycle.replace("development");
    const first = lifecycle.dispose();
    const second = lifecycle.dispose();
    expect(second).toBe(first);
    expect(oldDispose).not.toHaveBeenCalled();
    release();
    await Promise.all([active, first, second]);
    expect(oldDispose).toHaveBeenCalledOnce();
  });

  it("holds a streaming generation until completion or cancellation", async () => {
    let close!: () => void;
    const stream = new ReadableStream({
      start(controller) { close = () => controller.close(); controller.enqueue(new TextEncoder().encode("one")); },
    });
    const dispose = vi.fn();
    let generation = "g1";
    const lifecycle = createProjectionViteLifecycle({ entry: () => ({ generation, handler: async () => new Response(stream), dispose: generation === "g1" ? dispose : undefined }) });
    await lifecycle.start("development");
    const response = await lifecycle.dispatch(new Request("https://vite.test/"));
    generation = "g2";
    await lifecycle.replace("development");
    expect(dispose).not.toHaveBeenCalled();
    close();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    await lifecycle.dispose();
    expect(dispose).toHaveBeenCalledOnce();

    const cancelDispose = vi.fn();
    const never = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    const cancelling = createProjectionViteLifecycle({ entry: () => ({ generation: "g1", handler: async () => new Response(never), dispose: cancelDispose }) });
    await cancelling.start("development");
    const cancellingResponse = await cancelling.dispatch(new Request("https://vite.test/"));
    await cancellingResponse.body?.cancel();
    await cancelling.dispose();
    expect(cancelDispose).toHaveBeenCalledOnce();
  });
});
