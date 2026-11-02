"use client";

import { useEffect, useState } from "react";
import type { RoomEvent, RoomInput, RoomSnapshot } from "../lib/room-types";

export function applyRoomEvent(previous: RoomSnapshot, event: RoomEvent): RoomSnapshot {
  if (event.type === "snapshot") return event.snapshot;
  if (event.version <= previous.version) return previous;
  if (event.type === "state") return { ...previous, version: event.version, active: event.active, storageError: event.storageError };
  if (event.type === "text") return { ...previous, version: event.version, messages: previous.messages.map((message) => message.id === event.id ? { ...message, text: message.text + event.delta } : message) };
  const index = previous.messages.findIndex((message) => message.id === event.message.id);
  return { ...previous, version: event.version, messages: index < 0 ? [...previous.messages, event.message] : previous.messages.map((message) => message.id === event.message.id ? event.message : message) };
}

export function useRoom() {
  const [room, setRoom] = useState<RoomSnapshot>({ version: 0, messages: [], active: null });
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string>();
  const [connection, setConnection] = useState(0);
  useEffect(() => {
    const events = new EventSource("/api/room?stream=1");
    events.onmessage = (message) => {
      try { const event = JSON.parse(message.data) as RoomEvent; setRoom((previous) => applyRoomEvent(previous, event)); setConnected(true); }
      catch { setConnected(false); events.close(); setError("The room stream could not be read. Reconnect to inspect server state."); }
    };
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, [connection]);
  async function send(input: RoomInput) {
    setSending(true); setError(undefined);
    try {
      const response = await fetch("/api/room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (response.status === 400 || response.status === 409) {
        const data = await response.json();
        setError(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "This answer was not accepted. Reconnect to inspect the question.");
        return false;
      }
      if (!response.ok) throw new Error("not confirmed");
      return true;
    } catch { setError("Message acceptance is unconfirmed. Your text is kept below. Reconnect and check whether it appeared before sending again; nothing was retried."); return false; }
    finally { setSending(false); }
  }
  async function stop() {
    setError(undefined);
    try { const response = await fetch("/api/room", { method: "PATCH" }); if (!response.ok) throw new Error("not confirmed"); }
    catch { setError("Stop could not be confirmed. Inspect the room and saved document; disconnecting does not undo a save."); }
  }
  async function reset() {
    setResetting(true); setError(undefined);
    try {
      const response = await fetch("/api/room", { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        setError(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Reset could not be confirmed. Reconnect to inspect the conversation.");
        return false;
      }
      return true;
    } catch { setError("Reset could not be confirmed. Reconnect to inspect the conversation."); return false; }
    finally { setResetting(false); }
  }
  return { room, connected, sending: sending || resetting, resetting, error, send, stop, reset, reconnect: () => { setError(undefined); setConnection((value) => value + 1); } };
}
