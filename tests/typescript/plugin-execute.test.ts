import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostImports,
  createPluginExecutor,
  loadPlugin,
  inspectPlugin,
} from "../../packages/guests/plugin/index";

const executors: ReturnType<typeof createPluginExecutor>[] = [];
const instances: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WIT_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const INTERFACE = "boundary:guest/footprints@1.0.0";

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(resolve(root, "tests/fixtures/wasm-imports", name)),
  );
}

function zigBytes(): Uint8Array | undefined {
  const path = resolve(root, "examples/guests/thumbnail/zig/zig-out/thumbnail.component.wasm");
  if (!existsSync(path)) {
    return undefined;
  }
  return new Uint8Array(readFileSync(path));
}

describe("Node plugin execution", () => {
  it("refuses overreach before transpile", async () => {
    const imports = new HostImports(INTERFACE).provide("images");
    const executor = createPluginExecutor();
    executors.push(executor);
    const result = await loadPlugin({
      executor,
      bytes: fixture("overreach.component.wasm"),
      imports,
      witDigest: WIT_DIGEST,
      host: { images: () => "{}" },
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") {
      throw new Error("expected refused");
    }
    expect(result.unmapped).toEqual(["boundary:guest/footprints@1.0.0#publications"]);
  });

  it("treats a dummy export trap as unknown", async () => {
    const imports = new HostImports(INTERFACE).provide("images");
    const executor = createPluginExecutor();
    executors.push(executor);
    const result = await loadPlugin({
      executor,
      bytes: fixture("compliant.component.wasm"),
      imports,
      witDigest: WIT_DIGEST,
      host: { images: () => "{}" },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    instances.push(result.instance);
    const outcome = await result.instance.call(
      "images-make-thumbnail",
      JSON.stringify({ imageId: "original", maxWidth: 200 }),
    );
    expect(outcome.status).toBe("fault");
    if (outcome.status !== "fault") {
      throw new Error("expected fault");
    }
    expect(outcome.certainty).toBe("unknown");
    // Each call runs on its own instance by default, so a trap on the first
    // call is not inherited by the second.
    const again = await result.instance.call(
      "images-make-thumbnail",
      JSON.stringify({ imageId: "original", maxWidth: 200 }),
    );
    expect(again.status).toBe("fault");
  });

  it("makes the lifetime part of the realization id", async () => {
    const imports = new HostImports(INTERFACE).provide("images");
    const bytes = fixture("compliant.component.wasm");
    const perCall = await inspectPlugin(bytes, imports, WIT_DIGEST);
    const persistent = await inspectPlugin(bytes, imports, WIT_DIGEST, "persistent");
    expect(perCall.lifetime).toBe("per-call");
    expect(perCall.componentDigest).toBe(persistent.componentDigest);
    expect(perCall.realizationId).not.toBe(persistent.realizationId);
  });

  it.skipIf(zigBytes() === undefined)("calls the Zig plugin after loading", async () => {
    const bytes = zigBytes();
    if (bytes === undefined) {
      throw new Error("build the Zig component with just wasm-zig-guest");
    }
    const imports = new HostImports(INTERFACE).provide("images");
    const executor = createPluginExecutor();
    executors.push(executor);
    const result = await loadPlugin({
      executor,
      bytes,
      imports,
      witDigest: WIT_DIGEST,
      host: {
        async images(request, { signal }) {
          if (signal.aborted) return { tag: "unknown", val: "aborted" };
          const parsed = JSON.parse(request) as { imageId?: string };
          if (parsed.imageId === "original") {
            return JSON.stringify({ width: 800, height: 600 });
          }
          return { tag: "err", val: JSON.stringify({ error: "not_found" }) };
        },
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    instances.push(result.instance);
    const returned = await result.instance.call(
      "images-make-thumbnail",
      JSON.stringify({ imageId: "original", maxWidth: 200 }),
    );
    expect(returned).toMatchObject({ status: "returned" });
    if (returned.status !== "returned") {
      throw new Error("expected returned");
    }
    expect(JSON.parse(returned.payload)).toMatchObject({
      imageId: "original",
      width: 200,
      height: 150,
    });
    const declared = await result.instance.call(
      "images-make-thumbnail",
      JSON.stringify({ imageId: "missing", maxWidth: 200 }),
    );
    expect(declared.status).toBe("declared-error");
  });
});
