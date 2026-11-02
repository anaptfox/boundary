import { createHandoffInvocation } from "@foxworth/boundary/handoff";

export async function invokeFrom(manifest: unknown, amount: number, mode: "direct" | "request" = "direct") {
  return createHandoffInvocation(manifest, "workspace.increment", mode, { amount });
}

export async function readFrom(manifest: unknown) {
  return createHandoffInvocation(manifest, "workspace.read", "direct", null);
}
