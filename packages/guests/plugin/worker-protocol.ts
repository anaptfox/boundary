import type { ResourceLimits } from "node:worker_threads";
import type { PluginCallResult } from "./execution-types.ts";
import type { PluginLifetime } from "./host.ts";
import type { RequiredImport } from "./imports.ts";

export type ExecutorOptions = {
  maxWorkers?: number;
  maxInstances?: number;
  maxPending?: number;
  maxArtifactBytes?: number;
  maxPreparedBytes?: number;
  maxPayloadBytes?: number;
  /**
   * Bytes a guest may copy across host imports in one invocation: the UTF-8
   * length of every request plus every reply or declared error, summed.
   * Startup and each call get a separate, full budget. A request that would
   * pass it is refused before the host function runs; a reply that would pass
   * it is withheld. Either faults the call with `unknown` certainty. Equality
   * is allowed. Mirrors `GuestLimits::hostcall_copy_bytes` in
   * `crates/boundary-plugin`. It bounds copy volume, not retained host data.
   */
  hostcallCopyBytes?: number;
  prepareTimeoutMs?: number;
  callTimeoutMs?: number;
  /** V8 heap limits; these do not cap Wasm linear memory or total process RSS. */
  resourceLimits?: ResourceLimits;
};
export type ExecutorLimits = Required<Omit<ExecutorOptions, "resourceLimits">>;
export const DEFAULT_EXECUTOR_LIMITS: ExecutorLimits = {
  maxWorkers: 4, maxInstances: 64, maxPending: 32,
  maxArtifactBytes: 64 * 1024 * 1024, maxPreparedBytes: 128 * 1024 * 1024,
  maxPayloadBytes: 1024 * 1024, hostcallCopyBytes: 128 * 1024 * 1024,
  prepareTimeoutMs: 60_000, callTimeoutMs: 30_000,
};
export type WorkerSetup = {
  bytes: Uint8Array;
  maxPreparedBytes: number;
  maxPayloadBytes: number;
  hostcallCopyBytes: number;
};
export type WorkerCommand =
  | { type: "bind"; job: number; binding: number; required: readonly RequiredImport[]; lifetime: PluginLifetime }
  | { type: "call"; job: number; binding: number; name: string; input: string }
  | { type: "close"; binding: number };
export type WorkerEvent =
  | { type: "prepared"; bytes: number; modules: number; prepareMs: number; compileMs: number }
  | { type: "prepare-failed"; reason: string }
  | { type: "host"; job: number; binding: number; name: string; request: string; shared: SharedArrayBuffer }
  | { type: "result"; job: number; outcome: PluginCallResult; instantiateMs: number; invokeMs: number };
