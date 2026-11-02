"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActivityEvent, EntryPoint } from "../lib/activity-types";

type Snapshot = { events: ActivityEvent[]; revision: number; bindingDigest: string; projectionDigest: string };
const sources: Record<EntryPoint, string> = { human: "Human · Next Server Action", assistant: "Ollama · SDK tool", protocol: "Protocol · HTTP", http: "Native HTTP form", mcp: "External · MCP", webmcp: "Browser · WebMCP", "read-only-probe": "Read-only check", "stale-probe": "Stale-revision check" };
const stages = { invocation: "Invocation", policy: "Host policy", state: "App storage", outcome: "Boundary outcome", refresh: "Next invalidation" };

export function ActivityPanel({ revision, disabled }: { revision: number; disabled: boolean }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [offline, setOffline] = useState(false);
  const [probe, setProbe] = useState<string>();
  const [probing, setProbing] = useState(false);
  const [tick, setTick] = useState(0);
  const requestedRevision = useRef(revision);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/activity", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        const data: Snapshot = await response.json();
        setSnapshot(data); setOffline(false);
        if (data.revision !== revision && data.revision !== requestedRevision.current) {
          requestedRevision.current = data.revision; router.refresh();
        }
      } catch { if (!controller.signal.aborted) setOffline(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 2000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision, router, tick]);
  const calls = new Map<string, ActivityEvent[]>();
  for (const event of snapshot?.events ?? []) calls.set(event.callId, [...(calls.get(event.callId) ?? []), event]);
  const recent = [...calls.values()].slice(-8).reverse();
  async function runProbe(kind: "denied" | "stale") {
    setProbing(true); setProbe(undefined);
    try {
      const response = await fetch("/api/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
      if (!response.ok) throw new Error("probe failed");
      const result = await response.json() as { status?: string; actualRevision?: number; expectedRevision?: number };
      setProbe(result.status === "conflict" ? `Stale save rejected: current revision ${result.actualRevision}. No change made.` : result.status === "rejected" ? kind === "stale" && result.expectedRevision === 0 ? "Revision 0 rejected by input validation. Save once, then repeat to see the application's revision conflict." : "Save rejected before execution. No change made." : "Outcome unknown. Inspect the persisted document before another edit.");
    } catch { setProbe("Check could not be confirmed. Inspect the saved revision; no automatic retry."); }
    finally { setProbing(false); setTick((value) => value + 1); }
  }
  return <section id="activity" className="activity-panel" aria-label="Live interaction activity">
    <div className="activity-heading"><div><div className="panel-kicker">03 / SEE THE BOUNDARY WORK</div><h2>Different callers. Same rules.</h2><p className="panel-intro">Actual invocation events—not a simulated flow. Save above or ask Ollama, then follow what happened.</p></div><span className="revision-pill">SAVED REV {snapshot?.revision ?? revision}</span></div>
    <div className="boundary-checks"><button className="button" disabled={disabled || probing} onClick={() => void runProbe("denied")}>Try a read-only save</button><button className="button" disabled={disabled || probing} onClick={() => void runProbe("stale")}>Try a stale revision</button><span>Safe checks: neither can save a new revision.</span></div>
    {probe && <p className="probe-result" role="status">{probe}</p>}
    {offline && <p className="notice warning">Activity unavailable. The document’s saved state remains the source of truth.</p>}
    <div className="activity-calls">{!recent.length && <p className="activity-empty">Your first interaction will appear here. Try a boundary check to begin.</p>}{recent.map((events) => {
      const first = events[0]!;
      const outcome = events.find((event) => event.stage === "outcome");
      return <details className="activity-call" key={first.callId} open={recent[0] === events}>
        <summary><span className={`call-indicator ${events.some((event) => event.decision === "deny") ? "denied" : ""}`} /><span><strong>{first.agent ? `${first.agent === "scout" ? "Scout" : "Editor"} · Ollama tool` : sources[first.source]}</strong><small>{first.interactionId} · {first.session}{first.expectedRevision !== undefined ? ` · starting rev ${first.expectedRevision}` : ""}</small></span><span className="call-outcome">{outcome?.resultKind ?? "In progress"}</span></summary>
        <ol className="event-stages">{events.map((event) => <li key={event.id}><span>{stages[event.stage]}</span><p>{event.detail}{event.revision !== undefined ? ` Revision ${event.revision}.` : ""}</p>{event.certainty && <code>{event.certainty}</code>}</li>)}</ol>
        {outcome?.bindingDigest && <p className="trace-identity">Binding <code title={outcome.bindingDigest}>{outcome.bindingDigest.slice(0, 20)}…</code> · {outcome.bindingDigest === snapshot?.bindingDigest ? "matches current binding" : "earlier binding"}</p>}
      </details>;
    })}</div>
    <details className="identity-details"><summary>What belongs to Next.js, Boundary, and this app?</summary><dl><dt>Next.js</dt><dd>Server-rendered page, Server Action, route handlers, revalidatePath and router.refresh.</dd><dt>Boundary</dt><dd>Selected interaction contracts, one Binding, admission and typed invocation outcomes.</dd><dt>This application</dt><dd>Editor and assistant UI, demo sessions, permission policy, document persistence and revision checks.</dd></dl><p>Current binding: <code>{snapshot?.bindingDigest ?? "Loading…"}</code></p><a href="/api/boundary/manifest" target="_blank" rel="noreferrer">Inspect selected interactions →</a></details>
    <p className="fine-print">Recent local diagnostics, refreshed every 2 seconds. Not a durable audit log or collaboration service. External MCP and optional browser WebMCP use the same checked interactions; publication approval stays with the human.</p>
  </section>;
}
