/**
 * TypeScript client for the per-user local bus.
 *
 * Line-delimited JSON over a Unix domain socket. The bus answers where a
 * Binding can be reached and holds nothing else. Trust is the OS user via
 * the socket directory's 0700 permissions, not a second Offer filter and
 * not SO_PEERCRED.
 */
import { createConnection, type Socket } from "node:net";
import type { ReachRecord } from "@foxworth/boundary/reach";

const MAX_LINE = 64 * 1024;

export type BusResponse =
  | { readonly status: "ok"; readonly records?: readonly ReachRecord[] }
  | { readonly status: "error"; readonly code: string; readonly message: string };

export class BusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusError";
  }
}

export class BusClient {
  private constructor(
    private readonly socket: Socket,
    private leftover: Buffer,
  ) {}

  static connect(path: string): Promise<BusClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.setNoDelay?.(true);
        resolve(new BusClient(socket, Buffer.alloc(0)));
      });
      socket.once("error", reject);
    });
  }

  async register(record: ReachRecord): Promise<void> {
    const response = await this.send({ op: "register", record });
    this.expectOk(response);
  }

  async unregister(bindingDigest: string): Promise<void> {
    const response = await this.send({
      op: "unregister",
      binding_digest: bindingDigest,
    });
    this.expectOk(response);
  }

  async list(): Promise<readonly ReachRecord[]> {
    const response = await this.send({ op: "list" });
    this.expectOk(response);
    return response.records ?? [];
  }

  close(): void {
    this.socket.destroy();
  }

  private expectOk(response: BusResponse): asserts response is Extract<
    BusResponse,
    { status: "ok" }
  > {
    if (response.status === "error") {
      throw new BusError(`${response.code}: ${response.message}`);
    }
  }

  private send(request: object): Promise<BusResponse> {
    return new Promise((resolve, reject) => {
      const payload = `${JSON.stringify(request)}\n`;
      const onReadable = () => {
        try {
          const line = this.readLine();
          if (line === undefined) {
            return;
          }
          this.socket.off("readable", onReadable);
          this.socket.off("error", onError);
          resolve(JSON.parse(line) as BusResponse);
        } catch (error) {
          this.socket.off("readable", onReadable);
          this.socket.off("error", onError);
          reject(error);
        }
      };
      const onError = (error: Error) => {
        this.socket.off("readable", onReadable);
        reject(error);
      };
      this.socket.on("readable", onReadable);
      this.socket.once("error", onError);
      this.socket.write(payload, (error) => {
        if (error) {
          this.socket.off("readable", onReadable);
          this.socket.off("error", onError);
          reject(error);
        }
      });
    });
  }

  private readLine(): string | undefined {
    const chunk = this.socket.read() as Buffer | null;
    if (chunk !== null) {
      this.leftover = Buffer.concat([this.leftover, chunk]);
    }
    const newline = this.leftover.indexOf(0x0a);
    if (newline === -1) {
      if (this.leftover.length > MAX_LINE) {
        throw new BusError(`bus line exceeds the ${MAX_LINE}-byte cap`);
      }
      return undefined;
    }
    if (newline > MAX_LINE) {
      throw new BusError(`bus line exceeds the ${MAX_LINE}-byte cap`);
    }
    const line = new TextDecoder().decode(this.leftover.subarray(0, newline));
    this.leftover = this.leftover.subarray(newline + 1);
    return line;
  }
}
