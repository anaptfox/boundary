import { cloneJson, hashJson, isInteractionId, isSha256Digest, type JsonObject, type JsonValue, type InteractionIdentity, type Sha256Digest } from "@foxworth/boundary/program";
import { exactObject } from "#program/internal";
import { controlError } from "./errors";
import type { AnyControlHook, ControlHook, ControlTarget } from "./types";

export const CONTROL_REALIZATION_DOMAIN = "boundary.control-realization/v1";

export type ControlRealizationIdentity = InteractionIdentity;

export type ControlRuntimeIdentity = {
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
};

export type ControlDigestIdentity = {
  readonly interactionId: string;
  readonly interactionContractDigest: Sha256Digest;
  readonly realizationDigest: Sha256Digest;
  readonly stateSchema: JsonObject;
  readonly previewSchema: JsonObject;
};

export type ControlSchemaCompilation = {
  readonly contract: JsonObject;
};

export type ControlSchemaCompiler = {
  compileSchema(
    schema: unknown,
    context: {
      readonly role: "input" | "output" | "error";
      readonly path: string;
    },
  ): ControlSchemaCompilation;
};

export type ResolvedControl<Context = unknown> = {
  readonly identity: ControlRealizationIdentity;
  readonly hook: AnyControlHook<Context>;
  readonly controlDigest: Sha256Digest;
  readonly stateSchema: JsonObject;
  readonly previewSchema: JsonObject;
};

const controlHookSnapshots = new WeakMap<object, AnyControlHook<any>>();

const resolvedControls = new WeakSet<object>();

const CONTROL_HOOK_FIELDS = Object.freeze([
  "realizationDigest",
  "state",
  "preview",
  "plan",
  "apply",
  "verify",
  "reconcile",
] as const);

function snapshotInteractionIdentity(value: unknown): ControlRealizationIdentity {
  let candidate: JsonValue;
  try {
    candidate = cloneJson(value as JsonValue, "control.identity");
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control.identity",
      error instanceof Error
        ? error.message
        : "control interaction identity must be portable data",
      error,
    );
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control.identity",
      "control interaction identity must be an object",
    );
  }
  const object = exactObject(candidate, {
    path: "control.identity",
    keys: ["interactionId", "contractDigest"],
    fail: (failure) => {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        failure.path,
        failure.message,
      );
    },
  });
  if (!isInteractionId(object.interactionId)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control.identity.interactionId",
      "interactionId must be a stable ASCII token of at most 128 characters",
    );
  }
  if (!isSha256Digest(object.contractDigest)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control.identity.contractDigest",
      "contractDigest must be sha256:<64 lowercase hex>",
    );
  }
  return Object.freeze({
    interactionId: object.interactionId as string,
    contractDigest: object.contractDigest as Sha256Digest,
  });
}

export function requireResolvedControl<Context>(
  control: ResolvedControl<Context>,
): ResolvedControl<Context> {
  if (!control || typeof control !== "object" || !resolvedControls.has(control)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control",
      "an authentic digested controlled realization is required",
    );
  }
  return control;
}

function snapshotRuntimeIdentity(value: unknown): ControlRuntimeIdentity {
  let candidate: JsonValue;
  try {
    candidate = cloneJson(value as JsonValue, "control.runtimeIdentity");
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control.runtimeIdentity",
      error instanceof Error ? error.message : "runtime identity must be portable data",
      error,
    );
  }
  const object = exactObject(candidate, {
    path: "control.runtimeIdentity",
    keys: [
      "bindingDigest",
      "projectionDigest",
      "installationId",
      "installationDigest",
      "expectedProgramDigest",
      "actualProgramDigest",
      "programDigest",
      "interactionId",
      "expectedContractDigest",
      "contractDigest",
      "requestRealizationId",
      "executionRealizationId",
    ],
    fail: (failure) => {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        failure.path,
        failure.message,
      );
    },
  });
  for (const field of [
    "bindingDigest",
    "projectionDigest",
    "installationDigest",
    "expectedProgramDigest",
    "actualProgramDigest",
    "programDigest",
    "expectedContractDigest",
    "contractDigest",
  ] as const) {
    if (!isSha256Digest(object[field])) {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        `control.runtimeIdentity.${field}`,
        `${field} must be sha256:<64 lowercase hex>`,
      );
    }
  }
  if (!isInteractionId(object.interactionId)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      "control.runtimeIdentity.interactionId",
      "interactionId is invalid",
    );
  }
  for (const field of [
    "installationId",
    "requestRealizationId",
    "executionRealizationId",
  ] as const) {
    if (
      typeof object[field] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(object[field])
    ) {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        `control.runtimeIdentity.${field}`,
        `${field} must be a stable non-empty ASCII token`,
      );
    }
  }
  return Object.freeze(object) as unknown as ControlRuntimeIdentity;
}

export function targetForControl<Context>(
  control: ResolvedControl<Context>,
  identity: ControlRuntimeIdentity,
): ControlTarget {
  const resolved = requireResolvedControl(control);
  const runtime = snapshotRuntimeIdentity(identity);
  if (
    runtime.interactionId !== resolved.identity.interactionId ||
    runtime.contractDigest !== resolved.identity.contractDigest
  ) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      "control.runtimeIdentity",
      "runtime interaction does not match the static controlled realization",
    );
  }
  return Object.freeze({
    ...runtime,
    controlRealizationDigest: resolved.hook.realizationDigest,
    controlDigest: resolved.controlDigest,
  });
}

function snapshotSchemaContract(
  compilation: ControlSchemaCompilation,
  path: string,
): JsonObject {
  if (!compilation || typeof compilation !== "object") {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "schema compiler must return a contract object",
    );
  }
  if (!Object.prototype.propertyIsEnumerable.call(compilation, "contract")) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "compiled schema contract must be an enumerable data property",
    );
  }
  let contract: JsonValue;
  try {
    contract = cloneJson(
      (compilation as Record<string, unknown>).contract as JsonValue,
      path,
    );
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      error instanceof Error
        ? error.message
        : "compiled schema contract must be portable data",
      error,
    );
  }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "compiled schema contract must be an object",
    );
  }
  return contract as JsonObject;
}

function requiredFunction(
  value: unknown,
  path: string,
): asserts value is (...args: readonly unknown[]) => unknown {
  if (typeof value !== "function") {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "control realization must provide plan, apply, verify, and reconcile functions",
    );
  }
}

export function validateControlHook<Context = unknown>(
  value: unknown,
  path: string,
): AnyControlHook<Context> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "controlled change must provide a control realization object",
    );
  }
  const existing = controlHookSnapshots.get(value);
  if (existing) return existing as AnyControlHook<Context>;
  const fields = exactObject(value, {
    path,
    keys: CONTROL_HOOK_FIELDS,
    fail: (failure) => {
      throw failure.code === "SNAPSHOT_INVALID_PROPERTY"
        ? controlError(
            "CONTROL_INVALID_REALIZATION",
            failure.path,
            "control fields must be enumerable data properties",
          )
        : controlError(
            "CONTROL_INVALID_REALIZATION",
            path,
            "control realization must contain exactly realizationDigest, state, preview, plan, apply, verify, and reconcile",
          );
    },
  }) as Record<(typeof CONTROL_HOOK_FIELDS)[number], unknown>;
  requiredFunction(fields.plan, `${path}.plan`);
  requiredFunction(fields.apply, `${path}.apply`);
  requiredFunction(fields.verify, `${path}.verify`);
  requiredFunction(fields.reconcile, `${path}.reconcile`);
  if (!isSha256Digest(fields.realizationDigest)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      `${path}.realizationDigest`,
      "realizationDigest must be sha256:<64 lowercase hex>",
    );
  }
  const snapshot = Object.freeze({
    realizationDigest: fields.realizationDigest,
    state: fields.state,
    preview: fields.preview,
    plan: fields.plan,
    apply: fields.apply,
    verify: fields.verify,
    reconcile: fields.reconcile,
  }) as AnyControlHook<Context>;
  controlHookSnapshots.set(value, snapshot);
  controlHookSnapshots.set(snapshot, snapshot);
  return snapshot;
}

/** Type and freeze one author-facing control realization. */
export function controlled<
  Input,
  Output,
  State extends JsonValue,
  Preview extends JsonValue,
  StateSchema = unknown,
  PreviewSchema = unknown,
  Context = unknown,
>(
  hook: ControlHook<
    Input,
    Output,
    State,
    Preview,
    StateSchema,
    PreviewSchema,
    Context
  >,
): ControlHook<
  Input,
  Output,
  State,
  Preview,
  StateSchema,
  PreviewSchema,
  Context
> {
  return validateControlHook(hook, "controlled") as ControlHook<
    Input,
    Output,
    State,
    Preview,
    StateSchema,
    PreviewSchema,
    Context
  >;
}

export function digestControlRealization<Context = unknown>(
  compiler: ControlSchemaCompiler,
  identity: ControlRealizationIdentity,
  control: unknown,
): ResolvedControl<Context> {
  const exactIdentity = snapshotInteractionIdentity(identity);
  const hook = validateControlHook<Context>(
    control,
    `${exactIdentity.interactionId}.control`,
  );
  const state = compiler.compileSchema(hook.state, {
    role: "input",
    path: `${exactIdentity.interactionId}.control.state`,
  });
  const stateSchema = snapshotSchemaContract(
    state,
    `${exactIdentity.interactionId}.control.state.contract`,
  );
  const preview = compiler.compileSchema(hook.preview, {
    role: "output",
    path: `${exactIdentity.interactionId}.control.preview`,
  });
  const previewSchema = snapshotSchemaContract(
    preview,
    `${exactIdentity.interactionId}.control.preview.contract`,
  );
  const digestIdentity: ControlDigestIdentity = Object.freeze({
    interactionId: exactIdentity.interactionId,
    interactionContractDigest: exactIdentity.contractDigest,
    realizationDigest: hook.realizationDigest,
    stateSchema,
    previewSchema,
  });
  const resolved = Object.freeze({
    identity: exactIdentity,
    hook,
    controlDigest: hashJson(
      CONTROL_REALIZATION_DOMAIN,
      digestIdentity as unknown as JsonObject,
    ),
    stateSchema,
    previewSchema,
  });
  resolvedControls.add(resolved);
  return resolved;
}
