import type {
  AnyInteractionDefinition,
  CompiledInteractions,
  DefinitionInput,
  InteractionDefinitions,
  InteractionHandle,
  RealizationId,
} from "@foxworth/boundary";
import {
  createControlRequestContributions,
  type ControlRequestContributionSources,
  type ControlRequestContributions as HostControlRequestContributions,
  type RequestInvocationPolicy,
} from "#host/control";
import { cloneJson, isInteractionId, isSha256Digest, validatePortableSchema, type JsonObject, type JsonSchema } from "@foxworth/boundary/program";
import { exactObject } from "#program/internal";
import { controlError } from "./errors";
import { requestForControlRequester } from "./controller";
import { PUBLIC_PROPOSAL_SCHEMA } from "./proposal-records";
import {
  requireResolvedControl,
  targetForControl,
  type ResolvedControl,
} from "./realization";
import type {
  ControlRequester,
  MaybePromise,
} from "./types";

export type ControlRequestContribution<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
  Actor = unknown,
  Context = unknown,
> = Readonly<{
  interaction: InteractionHandle<Definition>;
  control: ResolvedControl<Context>;
  executionRealizationId: RealizationId;
  actor(context: Context): MaybePromise<Actor>;
}>;

export type ControlRequestContributions<
  Definitions extends InteractionDefinitions,
  Actor,
  Context,
> = Readonly<
  Partial<{
    [Alias in keyof Definitions]: ControlRequestContribution<
      Definitions[Alias],
      Actor,
      Context
    >;
  }>
>;

function assertStaticControl(
  interaction: InteractionHandle,
  control: ResolvedControl,
  executionRealizationId: unknown,
  path: string,
): ResolvedControl {
  const resolved = requireResolvedControl(control);
  if (
    interaction.interactionId !== resolved.identity.interactionId ||
    interaction.contractDigest !== resolved.identity.contractDigest
  ) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      path,
      "request contribution interaction does not match the controlled realization",
    );
  }
  if (
    typeof executionRealizationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(executionRealizationId) ||
    !isSha256Digest(resolved.controlDigest) ||
    !isSha256Digest(resolved.hook.realizationDigest)
  ) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "request contribution requires static control and execution realization identity",
    );
  }
  validatePortableSchema(resolved.previewSchema, `${path}.previewSchema`);
  return resolved;
}

function snapshotRequestPolicy(
  value: unknown,
  path: string,
): RequestInvocationPolicy {
  let candidate;
  try {
    candidate = cloneJson(value as never, path);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      error instanceof Error ? error.message : "request policy must be portable data",
      error,
    );
  }
  const policy = exactObject(candidate, {
    path,
    keys: [
      "mode",
      "bindingDigest",
      "projectionDigest",
      "installationId",
      "installationDigest",
      "expectedProgramDigest",
      "actualProgramDigest",
      "installationProgramDigest",
      "interactionId",
      "expectedContractDigest",
      "actualContractDigest",
      "realizationId",
    ],
    fail: (failure) => {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        failure.path,
        failure.message,
      );
    },
  });
  if (policy.mode !== "request") {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      `${path}.mode`,
      "request policy mode must be request",
    );
  }
  for (const field of [
    "bindingDigest",
    "projectionDigest",
    "installationDigest",
    "expectedProgramDigest",
    "actualProgramDigest",
    "installationProgramDigest",
    "expectedContractDigest",
    "actualContractDigest",
  ] as const) {
    if (!isSha256Digest(policy[field])) {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        `${path}.${field}`,
        `${field} is invalid`,
      );
    }
  }
  if (!isInteractionId(policy.interactionId)) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      `${path}.interactionId`,
      "interactionId is invalid",
    );
  }
  for (const field of ["installationId", "realizationId"] as const) {
    if (
      typeof policy[field] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(policy[field])
    ) {
      throw controlError(
        "CONTROL_INVALID_REALIZATION",
        `${path}.${field}`,
        `${field} is invalid`,
      );
    }
  }
  return Object.freeze(policy) as unknown as RequestInvocationPolicy;
}

function publicProposalSchema(previewSchema: JsonObject): JsonSchema {
  const base = cloneJson(PUBLIC_PROPOSAL_SCHEMA, "control.publicProposal");
  const properties = base.properties as JsonObject;
  const schema = cloneJson(
    {
      ...base,
      properties: { ...properties, preview: previewSchema },
    },
    "control.requestSchema",
  ) as JsonSchema;
  validatePortableSchema(schema, "control.requestSchema");
  return schema;
}

/**
 * Project proposal creation into opaque Host request contributions.
 *
 * The returned bindings possess only an authentic `ControlRequester`; Reader
 * and Admin are structurally absent. Under the Host-supplied request-only plan
 * contract, each request performs one proposal-creation attempt and never
 * approves, grants, executes, reconciles, retries, or replays.
 */
export function contributeControlRequests<
  Definitions extends InteractionDefinitions,
  Actor,
  Context,
>(
  compiled: CompiledInteractions<Definitions>,
  requester: ControlRequester<Actor, Context>,
  contributions: ControlRequestContributions<Definitions, Actor, Context>,
): HostControlRequestContributions<Definitions, Context> {
  const requestProposal = requestForControlRequester(requester);
  if (
    !contributions ||
    typeof contributions !== "object" ||
    Array.isArray(contributions)
  ) {
    throw new TypeError("control request contributions must be a record");
  }
  const requests: Record<string, unknown> = {};
  for (const [alias, contribution] of Object.entries(contributions)) {
    const path = `control.requests.${alias}`;
    if (!contribution || typeof contribution !== "object") {
      throw new TypeError(`${path} must be an object`);
    }
    const interaction = contribution.interaction;
    const control = contribution.control;
    const executionRealizationId = contribution.executionRealizationId;
    const actorForContext = contribution.actor;
    if (typeof actorForContext !== "function") {
      throw new TypeError(`${path}.actor must be a function`);
    }
    if (compiled.handles[alias] !== interaction) {
      throw controlError(
        "CONTROL_INTEGRITY_MISMATCH",
        `${path}.interaction`,
        "request contribution must use the authentic compiled handle for its alias",
      );
    }
    const resolved = assertStaticControl(
      interaction,
      control,
      executionRealizationId,
      path,
    );
    const previewSchema = publicProposalSchema(resolved.previewSchema);
    const binding = Object.freeze({
      interaction,
      controlDigest: resolved.controlDigest,
      previewSchema,
      async request(
        input: DefinitionInput<Definitions[keyof Definitions]>,
        context: Context,
        policyValue: RequestInvocationPolicy,
      ) {
        const policy = snapshotRequestPolicy(policyValue, `${path}.policy`);
        if (
          policy.installationProgramDigest !== compiled.program.programDigest ||
          policy.interactionId !== interaction.interactionId ||
          policy.actualContractDigest !== interaction.contractDigest
        ) {
          throw controlError(
            "CONTROL_INTEGRITY_MISMATCH",
            `${path}.policy`,
            "Host request policy does not match the compiled control contribution",
          );
        }
        const target = targetForControl(resolved, {
          bindingDigest: policy.bindingDigest,
          projectionDigest: policy.projectionDigest,
          installationId: policy.installationId,
          installationDigest: policy.installationDigest,
          expectedProgramDigest: policy.expectedProgramDigest,
          programDigest: policy.installationProgramDigest,
          actualProgramDigest: policy.actualProgramDigest,
          interactionId: policy.interactionId,
          expectedContractDigest: policy.expectedContractDigest,
          contractDigest: policy.actualContractDigest,
          requestRealizationId: policy.realizationId,
          executionRealizationId,
        });
        const actor = await actorForContext(context);
        return requestProposal({ actor, context, target, input });
      },
    });
    Object.defineProperty(requests, alias, {
      value: binding,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return createControlRequestContributions(
    compiled,
    Object.freeze(requests) as ControlRequestContributionSources<
      Definitions,
      Context
    >,
  );
}
