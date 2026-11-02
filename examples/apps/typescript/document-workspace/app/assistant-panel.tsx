"use client";

import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./model-picker";
import { useRouter } from "next/navigation";
import { agents, type AgentId } from "../lib/agents";
import type { RoomInput } from "../lib/room-types";
import { useRoom } from "./use-room";
import { RoomQuestion } from "./room-question";
import { Markdown } from "./markdown";
import { RoomDraft } from "./room-draft";

export function AssistantPanel({ canEdit, draftBusy, session, onBusyChange }: { canEdit: boolean; draftBusy: boolean; session: "alice" | "bob"; onBusyChange: (busy: boolean) => void }) {
  const router = useRouter();
  const { room, connected, sending, resetting, error, send, stop, reset, reconnect } = useRoom();
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [discovery, setDiscovery] = useState(0);
  const [prompt, setPrompt] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const composer = useRef<HTMLFormElement>(null);
  const submitted = useRef<RoomInput | undefined>(undefined);
  const lastActive = useRef<string | undefined>(undefined);
  const busy = Boolean(room.active);
  useEffect(() => { onBusyChange(busy || sending); }, [busy, sending, onBusyChange]);
  useEffect(() => {
    if (lastActive.current && !room.active) router.refresh();
    lastActive.current = room.active?.id;
  }, [room.active, router]);
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [room.version]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/assistant", { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("offline");
      const data: { models: string[]; defaultModel: string | null } = await response.json();
      setModels(data.models); setModel(data.defaultModel ?? "");
    }).catch(() => { if (!controller.signal.aborted) { setModels([]); setModel(""); } });
    return () => controller.abort();
  }, [discovery]);
  const reconnectAll = () => { reconnect(); setDiscovery((value) => value + 1); };

  return <section id="assistant" className="assistant-panel shared-chat" aria-label="Shared document room">
    <header className="chat-heading"><div className="chat-presence"><span className="agent-avatar scout">S</span><span className="agent-avatar editor">E</span></div><div><h2>All in the same room.</h2><p>Speak naturally. Your collaborators will join in.</p></div><details className="chat-settings"><summary aria-label="Chat settings">···</summary><div><label className="field-label">LOCAL MODEL</label><ModelPicker models={models} value={model} disabled={busy || sending || !models.length} onChange={setModel} /><p>{connected ? "Connected to the shared room" : "Reconnecting to the room…"}</p><button className="text-button" onClick={reconnectAll}>Reconnect</button><p>Conversation is saved on this server and shared by Alice and Bob. Reconnecting does not repeat work.</p></div></details></header>
    <div className="agent-roster" aria-label="Room participants">{(Object.keys(agents) as AgentId[]).map((id) => <div key={id} className={`agent-card ${id} ${room.active?.speaker === id ? "participating" : ""}`} title={agents[id].introduction}><span className={`agent-avatar ${id}`}>{agents[id].initial}</span><span><strong>{agents[id].name}</strong><small>{room.active?.speaker === id ? "In the conversation" : agents[id].role}</small></span><span className="agent-op-count">{agents[id].interactions.length} {agents[id].interactions.length === 1 ? "op" : "boundary"}</span></div>)}</div>
    <div className="room-actions"><span>Fresh conversation. Same document.</span><button type="button" className="text-button" disabled={busy || sending || !connected || !room.messages.length || Boolean(room.storageError)} title="Clear this conversation for everyone. The document stays unchanged." onClick={() => { void reset().then((done) => { if (done) { setPrompt(""); submitted.current = undefined; follow.current = true; } }); }}>{resetting ? "Resetting…" : "Reset chat"}</button></div>
    <div className="assistant-transcript" ref={transcript} onScroll={() => { const node = transcript.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 70; }} aria-label="Room conversation" aria-live="polite">
      {!room.messages.length && <div className="chat-welcome"><span className="welcome-glyph">✳</span><h3>Put an idea<br />into the room.</h3><p>Scout finds what’s missing.<br />Editor helps put it into words.<br />You don’t have to choose between them.</p><div className="chat-starters"><button onClick={() => setPrompt("What is missing from this document? Discuss it together and suggest a stronger opening, without saving yet.")}>What would make this stronger? <span>↗</span></button><button onClick={() => setPrompt("Let's think this through together. Who is this document for, and what should they take away?")}>Help me think this through. <span>↗</span></button></div></div>}
      {room.messages.map((message) => {
        const agent = message.author === "scout" || message.author === "editor" ? message.author : undefined;
        if (message.author === "room") return <p key={message.id} className="room-notice">{message.text}</p>;
        return <article key={message.id} className={`chat-message ${agent ? "assistant" : "user"} ${agent ?? ""}`}>
          <div className="message-label">{agent ? <><span className={`agent-avatar ${agent}`}>{agents[agent].initial}</span>{agents[agent].name}<small>{agents[agent].role}</small></> : <><span className="human-message-dot" />{message.author === session ? "You" : message.author === "alice" ? "Alice" : "Bob"}<small>to the room{message.allowSave ? " · one save allowed" : ""}</small></>}</div>
          {message.tools.map((interaction) => <div key={interaction.id} className={`tool-result ${interaction.interaction === "documents.save" && interaction.state === "returned" ? "saved-change" : ""} ${interaction.state === "uncertain" || interaction.state === "rejected" || interaction.state === "conflict" ? "tool-warning" : ""}`}><span>{interaction.state === "running" ? "↳" : interaction.state === "returned" ? "✓" : "!"} {interaction.interaction}{interaction.interaction.startsWith("documents.") ? <a href="#activity">Boundary ↗</a> : <small>Room coordination</small>}</span><p>{interaction.summary}</p></div>)}
          {message.text && <div className="chat-prose"><Markdown>{message.text}</Markdown></div>}
          {message.draft && <RoomDraft key={message.draft.id} draft={message.draft} />}
          {message.question && <RoomQuestion question={message.question} disabled={busy || sending || !connected || Boolean(room.storageError)} canApply={canEdit && !draftBusy} session={session} send={send} />}
          {(message.state === "interrupted" || message.state === "error" || message.state === "queued") && <small className="message-state">{message.state === "queued" ? "Waiting for the current exchange to settle…" : message.state === "interrupted" ? "Interrupted · retained in room history" : "Reply incomplete · inspect interaction results"}</small>}
        </article>;
      })}
      {room.active && <div className="model-working">{room.active.speaker && <span className={`agent-avatar ${room.active.speaker}`}>{agents[room.active.speaker].initial}</span>}<span>{room.active.phase === "stopping" ? "Stopping this exchange safely…" : room.active.speaker ? `${agents[room.active.speaker].name} is working with the room…` : "The room is considering who can help…"}</span></div>}
    </div>
    {(error || room.storageError) && <p className="notice warning" role="alert">{room.storageError ?? error} <button type="button" className="text-button" onClick={reconnectAll}>Reconnect</button></p>}
    {!connected && <p className="room-connection">Reconnecting… the server may still be working. Nothing is being replayed.</p>}
    <form ref={composer} className="assistant-composer" onSubmit={(event) => {
      event.preventDefault(); if (sending || !connected || !model || !prompt.trim() || room.storageError) return;
      const text = prompt.trim(); const permission = false;
      const prior = submitted.current;
      const request = prior && prior.text === text && prior.model === model && prior.allowSave === permission ? prior : { id: crypto.randomUUID(), text, model, allowSave: permission };
      submitted.current = request; follow.current = true;
      void send(request).then((accepted) => { if (accepted) { setPrompt((value) => value.trim() === text ? "" : value); submitted.current = undefined; } });
    }}>
      <div className="composer-recipient"><span className="room-recipient">To everyone in the room</span><span>@mentions are optional</span></div>
      <label className="sr-only" htmlFor="assistant-prompt">Message the room</label>
      <textarea id="assistant-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} rows={2} placeholder={room.messages.some((message) => message.question?.state === "pending") ? "A new message starts new work. Answer above to continue…" : busy ? "Jump in. A new message interrupts the exchange…" : "What's on your mind?"} required onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); composer.current?.requestSubmit(); } }} />
      <div className="composer-actions"><span className="save-consent">Draft together. Apply only when you approve.</span><div className="room-send-actions">{(busy || room.messages.some((message) => message.question?.state === "pending")) && <button className="text-button" type="button" onClick={() => void stop()}>{busy ? "Stop" : "Cancel request"}</button>}<button className="button primary send-message" aria-label={busy ? "Interrupt and send to room" : "Send to room"} disabled={sending || !connected || !model || !prompt.trim() || Boolean(room.storageError)}>↑</button></div></div>
    </form>
    <footer className="chat-foot"><span className={`status-dot ${connected && model ? "" : "offline-dot"}`} />{model ? "Local Ollama" : "Ollama unavailable"}<span>Shared live room</span></footer>
  </section>;
}
