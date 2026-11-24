import type { InteractionDescriptor, PortableSchema } from "@foxworth/boundary/program";
import { failHost } from "./errors";
import type { AnyInteractionDefinition, InteractionHandle } from "./types";

export type CompiledMetadata = Readonly<{
  definitions: Readonly<Record<string, AnyInteractionDefinition>>;
  descriptors: ReadonlyMap<string, InteractionDescriptor>;
  aliasesByDefinition: ReadonlyMap<AnyInteractionDefinition, string>;
  handlesByDefinition: ReadonlyMap<AnyInteractionDefinition, InteractionHandle>;
  nativeTargets: ReadonlyMap<string, unknown>;
  errorSchemas: ReadonlyMap<
    string,
    Readonly<Record<string, PortableSchema>>
  >;
}>;

export type HandleMetadata = Readonly<{
  compiled: object;
  alias: string;
  definition: AnyInteractionDefinition;
  descriptor: InteractionDescriptor;
}>;

export const compiledMetadata = new WeakMap<object, CompiledMetadata>();
export const handleMetadata = new WeakMap<object, HandleMetadata>();

export function metadataForCompiled(value: unknown): CompiledMetadata {
  if (value === null || typeof value !== "object") {
    return failHost(
      "INVALID_INSTALLATION",
      "compiled",
      "an authentic CompiledInteractions value is required",
    );
  }
  const metadata = compiledMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_INSTALLATION",
      "compiled",
      "an authentic CompiledInteractions value is required",
    );
  }
  return metadata;
}

export function metadataForHandle(value: unknown): HandleMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return handleMetadata.get(value);
}

export function handleBelongsToCompiled(
  handle: unknown,
  compiled: object,
): boolean {
  return metadataForHandle(handle)?.compiled === compiled;
}
