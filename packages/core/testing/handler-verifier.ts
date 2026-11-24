import { validateSchemaValue, type JsonSchema, type JsonValue } from "@foxworth/boundary/program";
import { InteractionFault, bindProjection, pickProjection, projectAllDirect } from "@foxworth/boundary";
import { generateInvalidSamples, generateValidSamples } from "./schema-samples";

export type HandlerVerificationFailure = Readonly<{ interaction: string; input: JsonValue; phase: "valid" | "invalid"; message: string }>;
export type HandlerVerificationReport = Readonly<{ ok: boolean; checkedInteractions: number; validCasesRun: number; invalidCasesRun: number; failures: readonly HandlerVerificationFailure[] }>;

export async function verifyDirectHandlers(options: {
  compiled: any; installation: any; context?: unknown; aliases?: readonly string[];
  maxSamplesPerInteraction?: number; admit?: (context: unknown) => unknown;
}): Promise<HandlerVerificationReport> {
  const all = projectAllDirect(options.compiled);
  const projection = options.aliases ? pickProjection(all, ...options.aliases) : all;
  const bound = bindProjection(projection, options.installation, {
    admit: (options.admit ?? (() => ({ decision: "allow" }))) as never,
  });
  if (bound.status !== "bound") return Object.freeze({ ok: false, checkedInteractions: 0, validCasesRun: 0, invalidCasesRun: 0,
    failures: Object.freeze([{ interaction: "<binding>", input: null, phase: "valid" as const, message: "projection did not bind" }]) });
  const caller = bound.binding.connect();
  const failures: HandlerVerificationFailure[] = [];
  let validCasesRun = 0; let invalidCasesRun = 0; let checkedInteractions = 0;
  for (const [alias, handle] of Object.entries(projection.handles)) {
    const descriptor = options.compiled.program.interactions.find((x: any) => x.contract.id === (handle as any).interactionId);
    if (!descriptor) continue;
    checkedInteractions++;
    const inputSchema = descriptor.contract.inputSchema as JsonSchema;
    for (const input of generateValidSamples(inputSchema, { maxSamples: options.maxSamplesPerInteraction })) {
      validCasesRun++;
      try {
        const output = await (caller.call as (...args: any[]) => Promise<unknown>)(handle, input, options.context) as JsonValue;
        if (validateSchemaValue(descriptor.contract.outputSchema, output).length) failures.push({ interaction: alias, input, phase: "valid", message: "returned output does not match outputSchema" });
      } catch (error) {
        if (!(error instanceof InteractionFault) || !["denied", "declared-error"].includes(error.cause)) {
          failures.push({ interaction: alias, input, phase: "valid", message: error instanceof Error ? `${error.name}: ${error.message}` : "undeclared failure" });
        }
      }
    }
    for (const input of generateInvalidSamples(inputSchema)) {
      invalidCasesRun++;
      try {
        await (caller.call as (...args: any[]) => Promise<unknown>)(handle, input, options.context);
        failures.push({ interaction: alias, input, phase: "invalid", message: "invalid input was accepted" });
      } catch (error) {
        if (!(error instanceof InteractionFault) || error.cause !== "invalid-input" || error.certainty !== "not-started") failures.push({ interaction: alias, input, phase: "invalid", message: "invalid input did not fail before start" });
      }
    }
  }
  return Object.freeze({ ok: failures.length === 0, checkedInteractions, validCasesRun, invalidCasesRun, failures: Object.freeze(failures) });
}
