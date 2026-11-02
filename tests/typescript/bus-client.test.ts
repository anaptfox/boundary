/**
 * TypeScript bus client against a live Unix socket.
 *
 * The mock server speaks the same line protocol as boundary-bus so the
 * client is proven at the socket, not against an in-memory double of itself.
 */
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReachRecord } from "../../packages/discovery/reach/index";
import { BusClient } from "../../packages/discovery/bus/index";

const sockets: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const dir of sockets.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listen(
  handler: (line: string) => object,
): { path: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "boundary-bus-ts-"));
  sockets.push(dir);
  const path = join(dir, "bus.sock");
  const server = createServer((socket) => {
    let leftover = "";
    socket.on("data", (chunk) => {
      leftover += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      let newline = leftover.indexOf("\n");
      while (newline !== -1) {
        const line = leftover.slice(0, newline);
        leftover = leftover.slice(newline + 1);
        socket.write(`${JSON.stringify(handler(line))}\n`);
        newline = leftover.indexOf("\n");
      }
    });
  });
  servers.push(server);
  server.listen(path);
  return {
    path,
    close: () => {
      server.close();
    },
  };
}

describe("TypeScript bus client", () => {
  it("registers a record and lists it back", async () => {
    const record = await createReachRecord(
      `sha256:${"1".repeat(64)}`,
      "deploy:test:1",
      [{ kind: "http", url: "http://127.0.0.1:9/boundary/v1" }],
    );
    const listed: unknown[] = [];
    const bus = listen((line) => {
      const request = JSON.parse(line) as { op: string; record?: unknown };
      if (request.op === "register") {
        listed.push(request.record);
        return { status: "ok" };
      }
      if (request.op === "list") {
        return { status: "ok", records: listed };
      }
      return { status: "error", code: "UNKNOWN", message: request.op };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const client = await BusClient.connect(bus.path);
    await client.register(record);
    const records = await client.list();
    expect(records).toEqual([record]);
    client.close();
  });
});
