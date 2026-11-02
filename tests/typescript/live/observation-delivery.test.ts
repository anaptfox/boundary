import { describe, expect, it } from "vitest";
import { startExampleHost } from "../../../examples/concepts/typescript/live-observations/startHost";
import { agentClient, createCounterView, waitUntil } from "../../../examples/concepts/typescript/live-observations/view";

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("observation delivery between independent Node processes", () => {
  it("authenticates, isolates tenants and installations, refreshes uncertain effects and reconnect gaps, and disposes", async () => {
    const host = await startExampleHost();
    const a = createCounterView(host.baseUrl, host.tokens.a);
    const b = createCounterView(host.baseUrl, host.tokens.b);
    const agentA = agentClient(host.baseUrl, host.tokens.a);
    const agentB = agentClient(host.baseUrl, host.tokens.b);
    const diagnostics = async () => {
      const response = await fetch(`${host.baseUrl}/diagnostics`, { headers: { authorization: `Bearer ${host.tokens.a}` } });
      return await response.json() as { value: number; writes: number; subscribers: number };
    };
    const captureAbort = new AbortController();
    try {
      const unauthorized = await fetch(`${host.baseUrl}/events`);
      expect(unauthorized.status).toBe(401);
      await Promise.all([a.subscription.ready, b.subscription.ready]);
      expect(a.value).toBe(0);
      expect(a.refreshes).toBe(1);
      expect(b.value).toBe(0);
      const capture = await fetch(`${host.baseUrl}/events`, {
        headers: { authorization: `Bearer ${host.tokens.a}` }, signal: captureAbort.signal,
      });
      const reader = capture.body!.getReader();
      const capturedEvent = (async () => {
        let text = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("capture ended before observation");
          text += new TextDecoder().decode(chunk.value);
          const block = text.split("\n\n").find((part) => part.startsWith("event: observation\n"));
          if (block) return JSON.parse(block.slice(block.indexOf("data: ") + 6)) as Record<string, unknown>;
        }
      })();
      await agentA.callRaw("counter.increment", { uncertain: false });
      const delivered = await capturedEvent;
      expect(delivered.interactionId).toBe("counter.increment");
      expect(delivered).not.toHaveProperty("correlation");
      expect(delivered).not.toHaveProperty("input");
      expect(delivered).not.toHaveProperty("result");
      captureAbort.abort();
      await reader.cancel().catch(() => {});
      await waitUntil(() => a.value === 1, "agent write delivered");
      const aRefreshes = a.refreshes;
      await agentB.callRaw("counter.increment", { uncertain: false });
      await waitUntil(() => b.value === 1, "other tenant receives its write");
      await settle();
      expect(a.refreshes).toBe(aRefreshes);
      expect(a.value).toBe(1);
      await expect(agentA.callRaw("counter.increment", { uncertain: true })).rejects.toMatchObject({ certainty: "unknown" });
      await waitUntil(() => a.value === 2, "uncertain applied effect refresh");
      expect((await diagnostics()).writes).toBe(2);
      a.subscription.disconnect();
      await agentA.callRaw("counter.increment", { uncertain: false });
      await settle();
      expect(a.value).toBe(2);
      await a.subscription.reconnect();
      expect(a.value).toBe(3);
      const beforeOther = a.refreshes;
      const other = agentClient(host.baseUrl, host.tokens.a, "/other");
      await other.callRaw("counter.increment", { uncertain: false });
      await settle();
      expect(a.refreshes).toBe(beforeOther);
      expect(a.value).toBe(3);
      expect((await diagnostics()).value).toBe(4);
      a.dispose();
      const beforeDisposed = a.refreshes;
      await agentA.callRaw("counter.increment", { uncertain: false });
      await settle();
      expect(a.refreshes).toBe(beforeDisposed);
      expect(a.subscription.state).toBe("disposed");
      await expect(a.subscription.reconnect()).rejects.toThrow("disposed");
      expect((await diagnostics()).writes).toBe(5);
      expect((await diagnostics()).subscribers).toBe(0);
    } finally { captureAbort.abort(); a.dispose(); b.dispose(); await host.close(); }
  }, 25_000);
});
