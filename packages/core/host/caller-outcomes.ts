import { DeclaredInteractionError } from "./definitions";
import { InteractionFault, type InteractionFaultCause, type InteractionFaultCertainty } from "./errors";
import type { DefinitionErrors, DefinitionInput, DefinitionOutput, HandleDefinition, InteractionHandle, ProjectedInteractionHandle } from "./types";

export type DeclaredErrorOutcome<Errors> = keyof Errors extends never ? never : {
  [Code in keyof Errors & string]: Readonly<{ kind: "declared-error"; code: Code; details: Errors[Code]; certainty: "completed" }>;
}[keyof Errors & string];
export type DirectOutcome<Output, Errors> = Readonly<{ kind: "ok"; value: Output; certainty: "completed" }> | DeclaredErrorOutcome<Errors> | Readonly<{ kind: "denied"; certainty: "not-started" }> | Readonly<{ kind: "fault"; cause: InteractionFaultCause; certainty: InteractionFaultCertainty; message: string }>;
export type RequestOutcome<Proposal> = Readonly<{ kind: "ok"; proposal: Proposal; certainty: "completed" }> | Readonly<{ kind: "denied"; certainty: "not-started" }> | Readonly<{ kind: "fault"; cause: InteractionFaultCause; certainty: InteractionFaultCertainty; message: string }>;

export function unwrapOutcome<Output, Errors>(outcome: DirectOutcome<Output, Errors>): Output;
export function unwrapOutcome<Proposal>(outcome: RequestOutcome<Proposal>): Proposal;
export function unwrapOutcome(outcome: any): unknown {
  if (outcome.kind === "ok") return "value" in outcome ? outcome.value : outcome.proposal;
  if (outcome.kind === "declared-error") throw new DeclaredInteractionError("", outcome.code, outcome.details as never);
  if (outcome.kind === "denied") throw new InteractionFault("denied", "not-started", "interaction admission was denied");
  throw new InteractionFault(outcome.cause, outcome.certainty, outcome.message);
}

type Modes<H> = H extends ProjectedInteractionHandle<InteractionHandle, infer M, any> ? M[number] : never;
type Definition<H> = H extends ProjectedInteractionHandle<infer Handle, any, any> ? HandleDefinition<Handle> : never;
type Args<H, C> = H extends ProjectedInteractionHandle<infer Handle, any, any>
  ? Handle extends { readonly inputArity: 0 }
    ? [C] extends [void] ? readonly [] : readonly [context: C]
    : [C] extends [void] ? readonly [input: DefinitionInput<HandleDefinition<Handle>>] : readonly [input: DefinitionInput<HandleDefinition<Handle>>, context: C]
  : never;
type DirectResult<H> = DirectOutcome<DefinitionOutput<Definition<H>>, DefinitionErrors<Definition<H>>>;
type Proposal<H> = H extends ProjectedInteractionHandle<any, readonly InteractionMode[], infer P> ? P : never;
import type { InteractionMode } from "./types";
export type DirectCallers<Handles extends Readonly<Record<string, ProjectedInteractionHandle>>, Context> = Readonly<{ [K in keyof Handles as "direct" extends Modes<Handles[K]> ? K : never]: (...args: Args<Handles[K], Context>) => Promise<DefinitionOutput<Definition<Handles[K]>>> }>;
export type TryCallers<Handles extends Readonly<Record<string, ProjectedInteractionHandle>>, Context> = Readonly<{ [K in keyof Handles as "direct" extends Modes<Handles[K]> ? K : never]: (...args: Args<Handles[K], Context>) => Promise<DirectResult<Handles[K]>> }>;
export type RequestCallers<Handles extends Readonly<Record<string, ProjectedInteractionHandle>>, Context> = Readonly<{ [K in keyof Handles as "request" extends Modes<Handles[K]> ? K : never]: (...args: Args<Handles[K], Context>) => Promise<Proposal<Handles[K]>> }>;
export type TryRequestCallers<Handles extends Readonly<Record<string, ProjectedInteractionHandle>>, Context> = Readonly<{ [K in keyof Handles as "request" extends Modes<Handles[K]> ? K : never]: (...args: Args<Handles[K], Context>) => Promise<RequestOutcome<Proposal<Handles[K]>>> }>;
