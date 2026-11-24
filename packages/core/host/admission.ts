import { type JsonValue } from "@foxworth/boundary/program";
import type { Admission, AdmissionDecision } from "./types";
import { BindingMetadata, ModeResolution, bindingRevoked } from "./binding-state";

export async function admitted<Context>(
  metadata: BindingMetadata<Context>,
  resolution: ModeResolution<Context>,
  input: JsonValue,
  context: Context,
): Promise<AdmissionDecision | undefined> {
  const lineage: BindingMetadata<Context>[] = [];
  let authorizedContext: unknown = context;
  let current: BindingMetadata<Context> | undefined = metadata;
  while (current !== undefined) {
    lineage.push(current);
    current = current.parent;
  }
  for (const stage of lineage.reverse()) {
    // The invocation's post-admission check reports revocation before dispatch.
    if (bindingRevoked(metadata)) return { decision: "allow" };
    const stageResolution = stage.interactions
      .get(resolution.manifest.interactionId)?.byMode.get(resolution.manifest.mode);
    if (stageResolution === undefined) return undefined;
    const decision = await admitOne(stage, stageResolution, input, context);
    if (decision?.decision !== "allow") return decision;
    if ("context" in decision) authorizedContext = decision.context;
  }
  return Object.is(authorizedContext, context)
    ? { decision: "allow" }
    : { decision: "allow", context: authorizedContext } as AdmissionDecision;
}

async function admitOne<Context>(
  metadata: BindingMetadata<Context>,
  resolution: ModeResolution<Context>,
  input: JsonValue,
  context: Context,
): Promise<AdmissionDecision | undefined> {
  try {
    const decision = await metadata.admission(
      Object.freeze({
        context,
        handle: Object.freeze({
          interactionId: resolution.manifest.interactionId,
          expectedContractDigest:
            resolution.manifest.expectedContractDigest,
          actualContractDigest: resolution.manifest.actualContractDigest,
          reads: resolution.expected.contract.reads,
          changes: resolution.expected.contract.changes,
        }),
        mode: resolution.manifest.mode,
        input,
        policy: Object.freeze({
          installationId: metadata.installation.installationId,
          realizationId: resolution.manifest.realizationId,
        }),
      }),
    );
    if (
      decision === null ||
      typeof decision !== "object" ||
      (decision.decision !== "allow" && decision.decision !== "deny")
    ) {
      return undefined;
    }
    return decision;
  } catch {
    return undefined;
  }
}

export const admitAll: Admission<any> = Object.freeze(() =>
  Object.freeze({ decision: "allow" as const }),
);

/** Admit when `allow(context)` is true; otherwise deny with `reason`. */
export function admitWhen<Context>(
  allow: (context: Context) => boolean,
  reason: string | ((context: Context) => string) = "denied",
): Admission<Context> {
  return (request) =>
    allow(request.context)
      ? { decision: "allow" }
      : {
          decision: "deny",
          reason:
            typeof reason === "function" ? reason(request.context) : reason,
        };
}
