export type EntryPoint = "human" | "assistant" | "protocol" | "http" | "mcp" | "webmcp" | "read-only-probe" | "stale-probe";
export type TraceContext = Readonly<{ id: string; source: EntryPoint; agent?: "scout" | "editor" }>;
export type ActivityEvent = Readonly<{
  id: string; time: string; callId: string; source: EntryPoint; session: "alice" | "bob";
  stage: "invocation" | "policy" | "state" | "outcome" | "refresh";
  interactionId: string; detail: string;
  agent?: "scout" | "editor";
  expectedRevision?: number; revision?: number; decision?: "allow" | "deny";
  bindingDigest?: string; projectionDigest?: string; resultKind?: string; certainty?: string;
}>;
