import { createProjectionClient } from "@foxworth/boundary/client";
import { fetchTransport } from "@foxworth/boundary/http";
import { createInteractionCacheScope, mountRead } from "@foxworth/boundary/client";
import { subscribeToObservations } from "@foxworth/boundary/client";

/** A mounted human read; the independent agent client performs the mutations. */
export function createCounterView(baseUrl: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const client = createProjectionClient(fetchTransport({ baseUrl: `${baseUrl}/boundary`, headers }));
  const scope = createInteractionCacheScope();
  let value: unknown;
  let refreshes = 0;
  const unmount = mountRead(client, "counter.read", async () => {
    value = await client.callRaw("counter.read");
    refreshes++;
  }, scope);
  const subscription = subscribeToObservations(client, { url: `${baseUrl}/events`, headers, scope });
  return {
    client, subscription,
    get value() { return value; },
    get refreshes() { return refreshes; },
    dispose() { subscription.dispose(); unmount(); },
  };
}

export function agentClient(baseUrl: string, token: string, path = "/boundary") {
  return createProjectionClient(fetchTransport({
    baseUrl: `${baseUrl}${path}`, headers: { authorization: `Bearer ${token}` },
  }));
}

export async function waitUntil(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
