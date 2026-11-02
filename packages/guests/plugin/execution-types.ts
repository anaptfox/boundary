import type { InvocationCertainty } from "@foxworth/boundary/program";
import type { PluginInspection } from "./host";

export type PluginHostReply =
  | string
  | { readonly tag: "ok" | "err" | "unknown"; readonly val: string };

/** Runs in the host. Cancellation is advisory; an effect may already have started. */
export type PluginHostFunction = (
  request: string,
  context: { readonly signal: AbortSignal },
) => PluginHostReply | Promise<PluginHostReply>;

export type PluginFault = {
  readonly status: "fault";
  readonly certainty: Exclude<InvocationCertainty, "completed">;
  readonly reason: string;
};
export type PluginCallResult =
  | { readonly status: "returned"; readonly payload: string }
  | { readonly status: "declared-error"; readonly payload: string }
  | PluginFault;
export type PluginCallOptions = {
  readonly signal?: AbortSignal;
  /** Overrides the executor deadline for this call, including queue time. */
  readonly timeoutMs?: number;
};
export interface GuestInstance {
  call(name: string, input: string, options?: PluginCallOptions): Promise<PluginCallResult>;
  /** Revokes this binding. Closing during execution terminates its worker. */
  close(): Promise<void>;
}
export type PluginLoadResult =
  | { readonly status: "ready"; readonly inspection: PluginInspection; readonly instance: GuestInstance }
  | { readonly status: "refused"; readonly unmapped: readonly string[]; readonly provided: readonly string[] }
  | PluginFault;

export function fault(reason: string, certainty: PluginFault["certainty"] = "not-started"): PluginFault {
  return { status: "fault", certainty, reason };
}
