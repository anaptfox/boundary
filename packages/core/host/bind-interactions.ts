import { compileInteractions } from "./compile";
import { snapshotDefinitions } from "./definition-snapshot";
import { implementInteractions } from "./implement";
import { installInteractions } from "./install";
import { directRealizationIds } from "./direct";
import { projectInteractions } from "./projection";
import { bindProjection } from "./binding";
import { namedCallers, namedTryCallers } from "./named-callers";
import type {
  CreateHostCallers,
  CreateHostIssue,
  CreateHostOptions,
  CreateHostResult,
  ExactCallerAliases,
  ContextFromHandlers,
  ContextInferringHandlers,
  CompatibleHandlerContexts,
} from "./bind-interactions-types";
import type {
  InteractionDefinitions,
  ProjectionSelection,
  ProjectionSelections,
} from "./types";

export class CreateHostError extends Error {
  readonly issues: readonly CreateHostIssue[];

  constructor(issues: readonly CreateHostIssue[]) {
    super(`Could not bind ${issues.length} caller${issues.length === 1 ? "" : "s"}`);
    this.name = "CreateHostError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

type OwnDataRecord = Record<string, unknown>;

function ownDataRecord(value: unknown, path: string): OwnDataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must use a plain-object prototype`);
  }
  const copy: OwnDataRecord = Object.create(null) as OwnDataRecord;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`${path} must contain only enumerable string data properties`);
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(copy);
}

function exactKeys(
  record: OwnDataRecord,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError(`${path} must contain exactly: ${expected.join(", ")}`);
  }
}

function snapshotAliases(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))
  ) {
    throw new TypeError(`${path} must be a dense array without extra properties`);
  }
  const aliases: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TypeError(`${path}[${index}] must be an enumerable string data property`);
    }
    if (aliases.includes(descriptor.value)) throw new TypeError(`${path} contains duplicate alias ${descriptor.value}`);
    aliases.push(descriptor.value);
  }
  return Object.freeze(aliases);
}

type CallerSnapshot = Readonly<{
  direct: readonly string[];
  admit: (actor: unknown) => boolean | PromiseLike<boolean>;
}>;

function snapshotCallers(value: unknown): Readonly<{
  callers: Readonly<Record<string, CallerSnapshot>>;
  issues: readonly CreateHostIssue[];
}> {
  const callers = ownDataRecord(value, "callers");
  const snapshot: Record<string, CallerSnapshot> = Object.create(null) as Record<string, CallerSnapshot>;
  const issues: CreateHostIssue[] = [];
  for (const name of Object.keys(callers)) {
    try {
      const config = ownDataRecord(callers[name], `callers.${name}`);
      exactKeys(config, ["direct", "admit"], `callers.${name}`);
      const direct = snapshotAliases(config.direct, `callers.${name}.direct`);
      if (typeof config.admit !== "function") {
        throw new TypeError(`callers.${name}.admit must be a function`);
      }
      Object.defineProperty(snapshot, name, {
        value: Object.freeze({ direct, admit: config.admit as CallerSnapshot["admit"] }),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    } catch (cause) {
      issues.push(Object.freeze({ caller: name, cause }));
    }
  }
  return Object.freeze({ callers: Object.freeze(snapshot), issues: Object.freeze(issues) });
}

function defineValue(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

/** Compile, install, project, and bind named direct callers through Boundary's native pipeline. */
export function createHost<
  const Definitions extends InteractionDefinitions,
  const Handlers extends ContextInferringHandlers<Definitions>,
  const Callers extends CreateHostCallers<Definitions, ContextFromHandlers<Definitions, Handlers>>,
>(
  definitions: Definitions,
  options: Omit<CreateHostOptions<Definitions, ContextFromHandlers<Definitions, Handlers>, Callers>, "handlers" | "callers"> & {
    readonly handlers: Handlers & Record<Exclude<keyof Handlers, keyof Definitions>, never> & CompatibleHandlerContexts<Definitions, Handlers>;
    readonly callers: Callers & ExactCallerAliases<Definitions, Callers>;
  },
): CreateHostResult<Definitions, ContextFromHandlers<Definitions, Handlers>, Callers>;
export function createHost<
  const Definitions extends InteractionDefinitions,
  Context,
  const Callers extends CreateHostCallers<Definitions, Context> = CreateHostCallers<Definitions, Context>,
>(
  definitions: Definitions,
  options: unknown,
): CreateHostResult<Definitions, Context, Callers> {
  const copiedOptions = ownDataRecord(options, "options");
  exactKeys(copiedOptions, ["installationId", "realizationVersion", "handlers", "callers"], "options");
  const installationId = copiedOptions.installationId;
  const realizationVersion = copiedOptions.realizationVersion;
  if (typeof installationId !== "string" || typeof realizationVersion !== "string") {
    throw new TypeError("installationId and realizationVersion must be strings");
  }
  const handlers = ownDataRecord(copiedOptions.handlers, "handlers");
  const callerSnapshot = snapshotCallers(copiedOptions.callers);
  const callerSnapshots = callerSnapshot.callers;
  const definitionSnapshot = snapshotDefinitions(definitions) as Definitions;
  const aliases = Object.keys(definitionSnapshot);
  const preflightIssues: CreateHostIssue[] = [...callerSnapshot.issues];
  for (const [name, caller] of Object.entries(callerSnapshots)) {
    for (const alias of caller.direct) {
      if (!aliases.includes(alias)) {
        preflightIssues.push(Object.freeze({
          caller: name,
          cause: new TypeError(`callers.${name}.direct contains unknown interaction alias ${alias}`),
        }));
        break;
      }
    }
  }
  const issues: CreateHostIssue[] = [...preflightIssues, ...Object.entries(callerSnapshots)
    .filter(([, caller]) => caller.direct.includes("then"))
    .map(([name]) => ({
      caller: name,
      cause: new TypeError('interaction alias "then" cannot be exposed as a named async method'),
    }))];
  if (issues.length > 0) throw new CreateHostError(issues);

  const compiled = compileInteractions(definitionSnapshot);
  const implementations = implementInteractions(
    definitionSnapshot as Definitions,
    handlers as never,
  ) as import("./types").InteractionImplementations<Definitions, Context>;
  const installed = installInteractions(compiled, {
    installationId,
    implementations,
    realizationIds: directRealizationIds(compiled, realizationVersion),
  });

  const projections: Record<string, import("./types").Projection<ProjectionSelections>> = Object.create(null) as Record<string, import("./types").Projection<ProjectionSelections>>;
  const bindings: Record<string, import("./types").ProjectionBinding<any, Context>> = Object.create(null) as Record<string, import("./types").ProjectionBinding<any, Context>>;
  const controllers: Record<string, import("./types").BindingController> = Object.create(null) as Record<string, import("./types").BindingController>;
  try {
    const outcomes = Object.entries(callerSnapshots).map(([name, caller]) => {
        try {
          const selection: Record<string, ProjectionSelection> =
            Object.create(null) as Record<string, ProjectionSelection>;
          for (const alias of caller.direct) {
            defineValue(
              selection,
              alias,
              Object.freeze({
                interaction: compiled.handles[alias],
                modes: Object.freeze(["direct"] as const),
              }),
            );
          }
          const projection = projectInteractions(compiled, selection);
          const bound = bindProjection(projection, installed.installation, {
            admit: async ({ context }) =>
              (await caller.admit(context)) === true
                ? { decision: "allow" as const }
                : { decision: "deny" as const, reason: "denied" },
          });
          if (bound.status === "unrealized") {
            return { name, projection, issue: bound.report };
          }
          return {
            name,
            projection,
            binding: bound.binding,
            controller: bound.controller,
          };
        } catch (cause) {
          return { name, cause };
        }
      });

    for (const outcome of outcomes) {
      if ("cause" in outcome) {
        issues.push({ caller: outcome.name, cause: outcome.cause });
      } else if ("issue" in outcome) {
        issues.push({ caller: outcome.name, cause: outcome.issue });
      } else {
        defineValue(projections, outcome.name, outcome.projection);
        defineValue(bindings, outcome.name, outcome.binding);
        defineValue(controllers, outcome.name, outcome.controller);
      }
    }
    if (issues.length > 0) {
      throw new CreateHostError(issues);
    }

    const frozenProjections = Object.freeze(projections);
    const frozenBindings = Object.freeze(bindings);
    const frozenControllers = Object.freeze(controllers);
    const callers = namedCallers<Definitions, Context, Callers>(
      callerSnapshots as Callers,
      frozenProjections,
      frozenBindings,
    );
    const tryCallers = namedTryCallers<Definitions, Context, Callers>(callerSnapshots as Callers, frozenBindings);
    return Object.freeze({
      compiled,
      installation: installed.installation,
      installationController: installed.controller,
      projections: frozenProjections,
      bindings: frozenBindings,
      bindingControllers: frozenControllers,
      callers,
      tryCallers,
    }) as CreateHostResult<Definitions, Context, Callers>;
  } catch (cause) {
    for (const controller of Object.values(controllers)) controller.revoke();
    installed.controller.revoke();
    throw cause;
  }
}
