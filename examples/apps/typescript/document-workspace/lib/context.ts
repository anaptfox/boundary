import type { TraceContext } from "./activity-types";
import type { AgentId } from "./agents";

export type DemoContext = Readonly<{
  session: "alice" | "bob";
  documentId: "doc-1";
  canEdit: boolean;
  assistantMaySave?: boolean;
  assistantAgent?: AgentId;
  /** Server-mapped delegation, never accepted from tool arguments. */
  delegation?: Readonly<{ executor: string; delegator: "alice" | "bob"; workspace: string; mayDraft: boolean }>;
  trace?: TraceContext;
}>;

function sessionFromCookie(value: string | null): "alice" | "bob" | undefined {
  const match = value?.match(/(?:^|;\s*)boundary_demo_session=(alice|bob)(?:;|$)/u);
  return match?.[1] as "alice" | "bob" | undefined;
}

/**
 * Demo-only seeded sessions. A cookie is intentionally not production identity
 * evidence; replace this mapping with the application's verified session layer.
 */
export function demoContextFromCookie(cookie: string | null): DemoContext {
  const session = sessionFromCookie(cookie);
  if (!session) throw new Error("choose a demo session before accessing the document");
  return Object.freeze({
    session,
    documentId: "doc-1",
    canEdit: session === "alice",
  });
}
