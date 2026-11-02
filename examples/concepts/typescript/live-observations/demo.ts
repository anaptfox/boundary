import { startExampleHost } from "./startHost";
import { agentClient, createCounterView, waitUntil } from "./view";

const host = await startExampleHost();
const view = createCounterView(host.baseUrl, host.tokens.a);
const agent = agentClient(host.baseUrl, host.tokens.a);
try {
  await view.subscription.ready;
  console.log("Human view after subscribing:", view.value);
  await agent.callRaw("counter.increment", { uncertain: false });
  await waitUntil(() => view.value === 1, "agent change");
  console.log("Human view after independent agent change:", view.value);
  try { await agent.callRaw("counter.increment", { uncertain: true }); }
  catch { console.log("Agent result is uncertain; the mutation is not retried."); }
  await waitUntil(() => view.value === 2, "uncertain effect refresh");
  console.log("Authoritative human read after uncertain effect:", view.value);
  view.subscription.disconnect();
  await agent.callRaw("counter.increment", { uncertain: false });
  await view.subscription.reconnect();
  console.log("Human view after reconnect refresh:", view.value);
} finally { view.dispose(); await host.close(); }
