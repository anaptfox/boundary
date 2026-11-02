import { bindProjection } from "./binding";
import { createCaller } from "./caller";
import { compileInteractions } from "./compile";
import { snapshotDefinitions } from "./definition-snapshot";
import { failHost } from "./errors";
import { implementInteractions } from "./implement";
import { installInteractions } from "./install";
import { bindNativeInteractions } from "./native-bindings";
import { projectInteractions } from "./projection";
import { deriveRealizationIds } from "./realization-ids";
import { metadataForControlRequestContributions } from "./request-contributions";
import { compiledSurface, requireSurface, type AnySurface, type Surface, type SurfaceAlias } from "./surface";
import type {
  AnyCaller,
  CallerFor,
  CompatibleHandlerContexts,
  ConnectOptions,
  ConnectResult,
  ContextFromHandlers,
  ContextInferringHandlers,
  HandlerInstallOptions,
  Installation,
  NativeInstallOptions,
  SurfaceFits,
} from "./facade-types";
import type {
  BindingController,
  InteractionDefinitions,
  ProjectionBinding,
  ProjectionSelection,
  SchemaAdapter,
  UnrealizedIssue,
  UnrealizedReport,
} from "./types";

const FIXES: Readonly<Record<UnrealizedIssue["reason"], string>> = Object.freeze({
  "missing-interaction": "install a handler for it or remove it from the surface",
  "incompatible-contract": "declare the installed interaction with the contract the surface expects, or re-create the surface from the installed declarations",
  "incompatible-arity": "give the installed interaction the same input arity the surface expects",
  "missing-direct": "install a handler for it or move it from call to propose",
  "missing-request": "contribute a Control request for it in install(..., { requests }) or move it from propose to call",
  "installation-revoked": "install again; a revoked Installation never serves new callers",
  "binding-revoked": "connect from a live Installation",
  "interaction-not-selected": "select the interaction on the surface",
  "contract-not-selected": "keep the parent's expected contract",
  "arity-not-selected": "keep the parent's input arity",
  "mode-not-selected": "select the mode on the parent",
});

/** Thrown by `connect` when the Surface cannot be realized by the Installation. */
export class ConnectError extends Error {
  readonly report: UnrealizedReport;
  /** What the Surface required. */
  readonly expected: string;
  /** What the Installation offered, one line per issue. */
  readonly found: string;
  /** What to change, one line per issue. */
  readonly fix: string;

  constructor(report: UnrealizedReport) {
    const issues = report.issues;
    const expected = `every interaction selected by the surface realized by installation "${report.installationId}" in its selected modes`;
    const found = issues.length === 0
      ? "no realizable selection"
      : issues.map((issue) => `${issue.alias} (${issue.interactionId}${issue.mode ? `, ${issue.mode}` : ""}): ${issue.reason}: ${issue.message}`).join("\n");
    const fix = issues.length === 0
      ? "connect from a live Installation"
      : [...new Set(issues.map((issue) => `${issue.alias}: ${FIXES[issue.reason]}`))].join("\n");
    super(`Cannot connect surface to installation "${report.installationId}": ${issues.length} unrealized interaction${issues.length === 1 ? "" : "s"}.\nexpected: ${expected}\nfound: ${found}\nfix: ${fix}`);
    this.name = "ConnectError";
    this.report = report;
    this.expected = expected;
    this.found = found;
    this.fix = fix;
  }
}

function generatedId(programDigest: string): string {
  const random = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return `generated:${programDigest.replace(/^sha256:/u, "").slice(0, 12)}:${random}`;
}

function plainOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost("INVALID_INSTALLATION", "install.options",
      "expected { version, handlers | dispatch, id?, requests?, schemas? }; found a non-object; fix: pass an options record");
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !allowed.includes(key) || !("value" in descriptor)) {
      return failHost("INVALID_INSTALLATION", `install.options.${String(key)}`,
        `expected only ${allowed.join(", ")} as data properties; found "${String(key)}"; fix: remove it`);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Shallow data-property snapshot of a host record, without accessors or symbols. */
function dataRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost("INVALID_INSTALLATION", path,
      "expected a plain record; found a non-object; fix: pass an object keyed by interaction alias");
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      return failHost("INVALID_INSTALLATION", `${path}.${String(key)}`,
        "expected enumerable string data properties; found an accessor or symbol; fix: use plain values");
    }
    defineValue(copy, key, descriptor.value);
  }
  return Object.freeze(copy);
}

function defineValue(record: object, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: false, writable: false });
}

/**
 * Compile a declaration record and install its implementations in one step.
 * `install` composes `compileInteractions`, `implementInteractions` (or native
 * bindings), and `installInteractions`; it adds no behaviour of its own.
 */
export function install<
  const Definitions extends InteractionDefinitions,
  const Handlers extends ContextInferringHandlers<Definitions>,
>(
  definitions: Definitions,
  options: Omit<HandlerInstallOptions<Definitions, ContextFromHandlers<Definitions, Handlers>>, "handlers"> & {
    readonly handlers: Handlers
      & Record<Exclude<keyof Handlers, keyof Definitions>, never>
      & CompatibleHandlerContexts<Definitions, Handlers>;
  },
): Promise<Installation<Definitions, ContextFromHandlers<Definitions, Handlers>>>;
export function install<
  const Definitions extends InteractionDefinitions,
  Targets extends { readonly [Alias in keyof Definitions]: unknown },
  Context = void,
>(
  definitions: Definitions,
  options: NativeInstallOptions<Definitions, Targets, Context>,
): Promise<Installation<Definitions, Context>>;
export async function install<Definitions extends InteractionDefinitions, Context>(
  definitions: Definitions,
  options: unknown,
): Promise<Installation<Definitions, Context>> {
  const snapshot = snapshotDefinitions(definitions) as Definitions;
  // Snapshot before the first await: later mutation of the host's option
  // records must not change what gets installed.
  const copied = plainOptions(options, ["version", "id", "handlers", "dispatch", "requests", "schemas"]);
  if (copied.handlers !== undefined) copied.handlers = dataRecord(copied.handlers, "install.options.handlers");
  if (copied.dispatch !== undefined) {
    const dispatch = dataRecord(copied.dispatch, "install.options.dispatch");
    copied.dispatch = Object.freeze({
      targets: dataRecord(dispatch.targets, "install.options.dispatch.targets"),
      dispatchers: dataRecord(dispatch.dispatchers, "install.options.dispatch.dispatchers"),
    });
  }
  if ((copied.handlers === undefined) === (copied.dispatch === undefined)) {
    return failHost("INVALID_INSTALLATION", "install.options",
      "expected exactly one of handlers or dispatch; found both or neither; fix: pass handlers for TypeScript functions or dispatch for native targets");
  }
  if (copied.id !== undefined && typeof copied.id !== "string") {
    return failHost("INVALID_INSTALLATION_ID", "install.options.id",
      "expected a string installation id; found a non-string; fix: omit id for a generated one or pass a stable token");
  }
  if (copied.requests !== undefined && typeof copied.requests !== "function") {
    return failHost("INVALID_REQUEST_BINDING", "install.options.requests",
      "expected a function of the compilation returning Control request contributions; found a non-function; fix: pass requests: (compiled) => contributeControlRequests(compiled, ...)");
  }
  const schemas = copied.schemas as readonly SchemaAdapter<any>[] | undefined;
  const compiled = await compileInteractions(snapshot, schemas === undefined ? {} : { schemas });
  const requests = copied.requests === undefined
    ? undefined
    : (copied.requests as (value: unknown) => unknown)(compiled);
  const requestAliases = new Set<string>(
    requests === undefined ? [] : metadataForControlRequestContributions(requests).entries.keys(),
  );
  const interactionIds = Object.fromEntries(
    Object.entries(compiled.handles).map(([alias, handle]) => [alias, handle.interactionId]),
  );
  const realizationIds = deriveRealizationIds(interactionIds, copied.version, requestAliases);
  const installationId = copied.id ?? generatedId(compiled.program.programDigest);
  const installed = copied.handlers !== undefined
    ? await installInteractions<Definitions, Context>(compiled, {
        installationId,
        implementations: implementInteractions<Definitions, Context>(snapshot, copied.handlers as never),
        ...(requests === undefined ? {} : { requests: requests as never }),
        realizationIds,
      })
    : await installInteractions<Definitions, Context>(compiled, {
        installationId,
        bindings: bindNativeInteractions(
          compiled,
          (copied.dispatch as { targets: never }).targets,
          (copied.dispatch as { dispatchers: never }).dispatchers,
        ) as never,
        ...(requests === undefined ? {} : { requests: requests as never }),
        realizationIds,
      });

  const bindings = new WeakMap<object, Readonly<{ binding: ProjectionBinding<any, Context>; controller: BindingController }>>();

  async function tryConnect(
    surfaceValue: unknown,
    connectOptions: ConnectOptions<Context>,
  ): Promise<ConnectResult<AnySurface, Context>> {
    const selected = requireSurface(surfaceValue, "connect.surface");
    if (connectOptions === null || typeof connectOptions !== "object" || typeof connectOptions.admit !== "function") {
      return failHost("INVALID_ADMISSION", "connect.admit",
        "expected an admission function; found none; fix: pass { admit: admitWhen((actor) => ..., \"reason\") }; there is no admit-all default");
    }
    const expected = await compiledSurface(selected, schemas);
    const selection: Record<string, ProjectionSelection> = Object.create(null) as Record<string, ProjectionSelection>;
    for (const alias of new Set([...selected.call, ...selected.propose])) {
      const modes: ("direct" | "request")[] = [];
      if (selected.call.includes(alias)) modes.push("direct");
      if (selected.propose.includes(alias)) modes.push("request");
      defineValue(selection, alias, Object.freeze({
        interaction: expected.handles[alias],
        modes: Object.freeze(modes),
      }));
    }
    const projection = await projectInteractions(expected, selection);
    const bound = await bindProjection(projection, installed.installation, connectOptions);
    if (bound.status === "unrealized") {
      return Object.freeze({ status: "unrealized", report: bound.report });
    }
    const binding = bound.binding;
    const caller = createCaller(binding);
    bindings.set(caller, Object.freeze({ binding, controller: bound.controller }));
    return Object.freeze({ status: "connected", caller: caller as never });
  }

  function entryFor(caller: unknown, path: string) {
    const entry = caller !== null && typeof caller === "object" ? bindings.get(caller) : undefined;
    if (entry === undefined) {
      return failHost("INVALID_ARTIFACT", path,
        "expected a caller connected from this Installation; found another value; fix: pass the value connect() returned");
    }
    return entry;
  }

  const result: Installation<Definitions, Context> = Object.freeze({
    id: installationId,
    program: compiled.program,
    manifest: installed.installation.manifest,
    compiled,
    installation: installed.installation,
    get revoked() {
      return installed.controller.revoked;
    },
    async connect(surfaceValue: unknown, connectOptions: ConnectOptions<Context>) {
      const outcome = await tryConnect(surfaceValue, connectOptions);
      if (outcome.status === "unrealized") throw new ConnectError(outcome.report);
      return outcome.caller as never;
    },
    tryConnect: tryConnect as never,
    revoke(caller?: AnyCaller<Context>) {
      if (caller === undefined) return installed.controller.revoke();
      return entryFor(caller, "revoke.caller").controller.revoke();
    },
    binding(caller: AnyCaller<Context>) {
      return entryFor(caller, "binding.caller").binding;
    },
  });
  return result;
}

export type { Surface, SurfaceAlias, SurfaceFits, CallerFor };
