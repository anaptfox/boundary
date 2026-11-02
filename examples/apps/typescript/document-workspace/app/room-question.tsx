"use client";

import { useRef, useState } from "react";
import type { RoomInput, RoomQuestion as Question } from "../lib/room-types";

/** App-rendered interaction data; no library-owned UI or model-authored markup. */
export function RoomQuestion({ question, disabled, canApply, session, send }: {
  question: Question; disabled: boolean; canApply: boolean; session: "alice" | "bob";
  send: (input: RoomInput) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempted = useRef<RoomInput | undefined>(undefined);
  const pending = question.state === "pending";
  const own = question.work.owner === session;
  const locked = disabled || submitting || !pending || !own;
  async function answer(value: string) {
    if (locked || !value.trim()) return;
    // Retain the id after an ambiguous acceptance. A click never becomes a new save attempt.
    const request = attempted.current?.answer?.value === value ? attempted.current : {
      id: crypto.randomUUID(), text: value, model: question.work.model, allowSave: false,
      answer: { questionId: question.id, value },
    };
    attempted.current = request; setSubmitting(true);
    try { if (await send(request)) setText(""); } finally { setSubmitting(false); }
  }
  return <section className={`room-question ${question.kind === "approval" ? "draft-approval" : ""}`} aria-label={question.kind === "approval" ? "Draft approval" : "Question for you"}>
    <small>{pending ? question.kind === "approval" ? "YOUR CALL · NOTHING SAVED YET" : own ? "OVER TO YOU" : `WAITING FOR ${question.work.owner.toUpperCase()}` : question.state === "answered" ? "ANSWERED" : "CANCELLED"}</small>
    <h4>{question.prompt}</h4>
    {pending ? <>
      <div className="question-options">{question.options.map((option) => <button key={option} type="button" disabled={locked || (question.kind === "approval" && option === "Apply" && !canApply)} onClick={() => void answer(option)}>{option}</button>)}</div>
      {question.kind !== "approval" && <form onSubmit={(event) => { event.preventDefault(); void answer(text.trim()); }}>
        <label className="sr-only" htmlFor={`answer-${question.id}`}>Your answer</label>
        <textarea id={`answer-${question.id}`} value={text} maxLength={4000} rows={2} disabled={locked} onChange={(event) => setText(event.target.value)} placeholder={question.kind === "text" ? "Give us a little direction…" : "Or answer in your own words…"} />
        <button type="submit" className="text-button" disabled={locked || !text.trim()}>Send answer ↗</button>
      </form>}
      {question.kind === "approval" && !canApply && own && <p>Applying needs edit access and a clean document editor.</p>}
      {submitting && <p role="status">Sending your answer…</p>}
    </> : question.answer ? <p>{question.answer}</p> : <p>This question no longer resumes work.</p>}
  </section>;
}
