import type { BindingManifest } from "@foxworth/boundary";
import type { HandoffInvocation, HandoffOutcome } from "@foxworth/boundary/handoff";

export type ClientInvokeFraming = Readonly<{
  headers?: HeadersInit;
}>;

export interface ClientTransport {
  inspect(): Promise<BindingManifest>;
  invoke(
    invocation: HandoffInvocation,
    framing?: ClientInvokeFraming,
  ): Promise<HandoffOutcome>;
}
