import type { JsonValue } from "@foxworth/boundary/program";
import {
  publicAttempt,
  type AttemptOutput,
  type AttemptRecord,
  type AttemptRef,
  type ControlAdmin,
  type ControlReader,
  type EffectResult,
  type Grant,
  type UntypedAttemptRef,
} from "@foxworth/boundary/control";

type Output = { readonly revision: number };
type OtherOutput = { readonly message: string };
type Context = { readonly tenant: string };

declare const admin: ControlAdmin<string, Context>;
declare const reader: ControlReader;
declare const grant: Grant<JsonValue, Output>;
declare const typedAttempt: AttemptRef<Output>;
declare const untypedAttempt: AttemptRef;
declare const decodedAttempt: UntypedAttemptRef;
declare const durableAttempt: AttemptRecord;
declare const attemptOrId: AttemptRef | string;
declare const context: Context;

async function inferredRecovery() {
  const result = await admin.execute(grant, "executor", context);
  result satisfies EffectResult<Output>;
  if (result.status !== "uncertain") return;
  result.attempt satisfies AttemptRef<Output>;

  const recovered = await admin.reconcile(result.attempt, "executor", context);
  recovered satisfies EffectResult<Output>;
  if (recovered.status === "completed") {
    recovered.value.revision satisfies number;
    // @ts-expect-error recovered output retains the grant's declared shape
    recovered.value.message;
  } else if (recovered.status === "uncertain") {
    const repeated = await admin.reconcile(recovered.attempt, "executor", context);
    repeated satisfies EffectResult<Output>;
  }

  // @ts-expect-error an output type is not a reconciliation reference type
  await admin.reconcile<OtherOutput>(result.attempt, "executor", context);
  // @ts-expect-error an existing attempt cannot be assigned a different output
  await admin.reconcile<AttemptRef<OtherOutput>>(result.attempt, "executor", context);
  // @ts-expect-error completed values cannot be relabeled as unrelated output
  recovered satisfies EffectResult<OtherOutput>;
}

async function untypedRecovery() {
  const byId = await admin.reconcile("attempt-1", "executor", context);
  const byReference = await admin.reconcile(untypedAttempt, "executor", context);
  const byUnion = await admin.reconcile(attemptOrId, "executor", context);
  const projected = await admin.reconcile(publicAttempt(durableAttempt), "executor", context);
  const byDecodedReference = await admin.reconcile(decodedAttempt, "executor", context);
  const byDurableRecord = await admin.reconcile(durableAttempt, "executor", context);
  const reconstructed = Object.freeze({ ...durableAttempt });
  const byPlainIdentity = await admin.reconcile(reconstructed, "executor", context);
  byId satisfies EffectResult<unknown>;
  byReference satisfies EffectResult<unknown>;
  byUnion satisfies EffectResult<unknown>;
  projected satisfies EffectResult<unknown>;
  byDecodedReference satisfies EffectResult<unknown>;
  byDurableRecord satisfies EffectResult<unknown>;
  byPlainIdentity satisfies EffectResult<unknown>;
  // @ts-expect-error a durable record has no private native output relation
  durableAttempt satisfies AttemptRef<Output>;
  // @ts-expect-error reconstructing a plain identity cannot mint output evidence
  reconstructed satisfies AttemptRef<Output>;
  // @ts-expect-error a decoded structural identity is not a typed Control reference
  decodedAttempt satisfies AttemptRef<Output>;
  if (byId.status === "completed") {
    // @ts-expect-error persisted IDs do not restore native output evidence
    byId.value.revision;
  }
  if (projected.status === "uncertain") {
    // @ts-expect-error projection from a durable record does not invent a type
    projected.attempt satisfies AttemptRef<Output>;
  }
  // @ts-expect-error a generic reference argument cannot retype an unknown handle
  await admin.reconcile<AttemptRef<Output>>(untypedAttempt, "executor", context);
  // @ts-expect-error a typed reference argument cannot retype a persisted ID
  await admin.reconcile<AttemptRef<Output>>("attempt-1", "executor", context);
  // @ts-expect-error explicit reference generics cannot type a raw durable record
  await admin.reconcile<AttemptRef<Output>>(durableAttempt, "executor", context);
  // @ts-expect-error explicit reference generics cannot type a rebuilt plain object
  await admin.reconcile<AttemptRef<Output>>(reconstructed, "executor", context);
  // @ts-expect-error the public durable projector cannot mint caller-selected output
  publicAttempt<Output>(durableAttempt);

  const observed = await reader.get({ kind: "attempt", id: "attempt-1" });
  // @ts-expect-error reader output has no native output-type evidence
  observed satisfies AttemptRef<Output>;
}

declare const inferredOutput: AttemptOutput<typeof typedAttempt>;
inferredOutput satisfies Output;
declare const unknownOutput: AttemptOutput<typeof untypedAttempt>;
// @ts-expect-error untyped references extract unknown
unknownOutput satisfies Output;

void inferredRecovery;
void untypedRecovery;
