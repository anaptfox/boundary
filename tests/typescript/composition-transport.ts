import { createServer, type Server } from "node:http";
import { afterEach } from "vitest";
import { fetchTransport } from "../../packages/adapters/http/protocol";
import { sendFetchResponse, toFetchRequest } from "../../packages/adapters/http/node";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

/** The same behavioral assertions run in-process and over an actual loopback socket. */
export async function compositionTransport(handler: (request: Request) => Promise<Response>) {
  if (process.env.BOUNDARY_COMPOSITION_LIVE !== "1") {
    return fetchTransport({ baseUrl: "http://boundary.test/boundary", fetch: (input, init) => handler(new Request(input, init)) });
  }
  const server = createServer((request, response) => {
    void handler(toFetchRequest(request)).then((result) => sendFetchResponse(response, result, request.method)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listening address");
  return fetchTransport({ baseUrl: `http://127.0.0.1:${address.port}/boundary` });
}
