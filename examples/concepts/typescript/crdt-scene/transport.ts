import { createServer, request, type Server } from "node:http";
import { once } from "node:events";

export type ReplicaDirection = "left-to-right" | "right-to-left";

export interface ReplicaRelay {
  readonly evidence: string;
  deliver(direction: ReplicaDirection, update: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface LocalReplicaRelay extends ReplicaRelay {
  readonly port: number;
}

export type ReplicaRelayFactory = (
  apply: (direction: ReplicaDirection, update: Uint8Array) => void | Promise<void>,
) => Promise<ReplicaRelay>;

/** In-process delivery for unit tests; engine updates and Sync messages stay native. */
export async function startInProcessReplicaRelay(
  apply: (direction: ReplicaDirection, update: Uint8Array) => void | Promise<void>,
): Promise<ReplicaRelay> {
  return Object.freeze({
    evidence: "in-process native replica exchange",
    async deliver(direction: ReplicaDirection, update: Uint8Array) {
      await apply(direction, new Uint8Array(update));
    },
    async close() {},
  });
}

/** A private, short-lived loopback relay used only by the executable example. */
export async function startLocalReplicaRelay(
  apply: (direction: ReplicaDirection, update: Uint8Array) => void | Promise<void>,
): Promise<LocalReplicaRelay> {
  const server: Server = createServer((incoming, outgoing) => {
    const direction = incoming.url === "/left-to-right"
      ? "left-to-right"
      : incoming.url === "/right-to-left"
        ? "right-to-left"
        : undefined;
    if (incoming.method !== "POST" || !direction) {
      outgoing.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    incoming.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (tooLarge) {
        outgoing.writeHead(413).end("replica update exceeded the test relay limit");
        return;
      }
      void Promise.resolve()
        .then(() => apply(direction, new Uint8Array(Buffer.concat(chunks))))
        .then(() => outgoing.writeHead(204).end())
        .catch((error: unknown) => {
          outgoing.writeHead(500).end(String(error));
        });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The local replica relay did not bind a TCP port");
  }

  return Object.freeze({
    evidence: "loopback TCP within one packed-consumer process",
    port: address.port,
    async deliver(direction: ReplicaDirection, update: Uint8Array) {
      await new Promise<void>((resolve, reject) => {
        const outgoing = request({
          host: "127.0.0.1",
          port: address.port,
          path: `/${direction}`,
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          timeout: 2000,
        }, (incoming) => {
          incoming.resume();
          incoming.on("end", () => {
            if (incoming.statusCode !== 204) {
              reject(new Error(`Replica relay returned HTTP ${incoming.statusCode}`));
            } else {
              resolve();
            }
          });
        });
        outgoing.on("timeout", () => outgoing.destroy(new Error("Replica relay timed out")));
        outgoing.on("error", reject);
        outgoing.end(update);
      });
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}
