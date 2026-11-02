export {
  NameError,
  witIdentifier,
  type NameDiagnosticCode,
  type NameResult,
} from "./name";

export {
  DEFAULT_WIT_PROJECTION_OPTIONS,
  WitProjectionError,
  projectWit,
  type ProjectedInteraction,
  type WitProjection,
  type WitProjectionDiagnosticCode,
  type WitProjectionOptions,
} from "./wit";

export {
  HostImports,
  qualifiedImport,
  type ImportCheck,
  type RequiredImport,
} from "./imports";

export { readRequiredImports } from "./component";

export {
  authorityDigest,
  inspectPlugin,
  type PluginInspection,
  type PluginLifetime,
} from "./host";

export {
  type GuestInstance,
  loadPlugin,
  type PluginCallOptions,
  type PluginCallResult,
  type PluginFault,
  type PluginHostFunction,
  type PluginHostReply,
  type PluginLoadResult,
} from "./execute";

export { createPluginExecutor, PluginExecutor } from "./executor";
export type { ExecutorOptions } from "./worker-protocol";
