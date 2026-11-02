/**
 * TypeScript bus client against a live `boundary bus` Unix socket.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createReachRecord } from "../../../packages/discovery/reach/index";
import { BusClient } from "../../../packages/discovery/bus/index";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const opsBin = join(root, "target/debug/boundary");

const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Serves one real Binding manifest over HTTP.
 *
 * The bus proves possession before it accepts a record: it fetches
 * `{base}/manifest` and refuses unless the manifest names the same Binding.
 * So a live registration test needs a live surface. The manifest comes from
 * the reviewed host-lifecycle vector rather than a hand-shaped stub, because
 * the client that fetches it validates what it gets back.
 */
async function serveManifest(): Promise<{ url: string; bindingDigest: string }> {
  const vector = JSON.parse(
    readFileSync(join(root, "tests/conformance/v1/host-lifecycle.json"), "utf8"),
  ) as { artifacts: { binding: { bindingDigest: string } } };
  const manifest = vector.artifacts.binding;
  const body = JSON.stringify(manifest);
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      etag: `"${manifest.bindingDigest}"`,
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the manifest server did not bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/boundary/v1`,
    bindingDigest: manifest.bindingDigest,
  };
}

async function startBus(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "boundary-bus-live-"));
  dirs.push(dir);
  const socket = join(dir, "bus.sock");
  const child = spawn(opsBin, ["bus", "--socket", socket], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("boundary bus did not start")), 5000);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(new Error(`boundary bus exited ${code}`));
    });
  });
  return socket;
}

describe("TypeScript bus client on the live boundary bus", () => {
  it("registers so boundary list sees the record", async () => {
    const socket = await startBus();
    const surface = await serveManifest();
    const record = await createReachRecord(
      surface.bindingDigest,
      "deploy:live:1",
      [{ kind: "http", url: surface.url }],
    );
    const client = await BusClient.connect(socket);
    await client.register(record);
    const listed = await client.list();
    expect(listed.map((entry) => entry.bindingDigest)).toEqual([
      record.bindingDigest,
    ]);
    client.close();
  });

  it("withdraws a registered binding while its client remains connected", async () => {
    const socket = await startBus();
    const surface = await serveManifest();
    const record = await createReachRecord(surface.bindingDigest, "deploy:withdraw:1", [
      { kind: "http", url: surface.url },
    ]);
    const client = await BusClient.connect(socket);
    try {
      await client.register(record);
      expect(await client.list()).toEqual([record]);
      await client.unregister(record.bindingDigest);
      expect(await client.list()).toEqual([]);
      await client.register(record);
      expect(await client.list()).toEqual([record]);
    } finally {
      client.close();
    }
  });

  it("refuses a digest the registrant cannot serve", async () => {
    const socket = await startBus();
    const surface = await serveManifest();
    // Claims someone else's digest while serving its own manifest — the
    // squatting case, which is free without a possession proof.
    const record = await createReachRecord(
      `sha256:${"a".repeat(64)}`,
      "deploy:live:1",
      [{ kind: "http", url: surface.url }],
    );
    const client = await BusClient.connect(socket);
    await expect(client.register(record)).rejects.toThrow(/NOT_POSSESSED/);
    expect(await client.list()).toEqual([]);
    client.close();
  });
});
