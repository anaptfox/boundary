/**
 * Three Surface presets over the compiled Draft interactions, one per authority.
 *
 * A worker proposes. An author accepts or rejects. Neither implies the
 * other, and a host that only needs to gate invocation of already-declared
 * interactions needs neither: {@link runnerSurface} selects nothing at all.
 * No preset here hands out every Draft capability; that convenience would
 * erase the authority split the other two presets exist to express. A host
 * that genuinely wants every capability composes its own selection from
 * `compiled.handles` directly — this module does not ship that shortcut.
 */
import { projectInteractions } from "@foxworth/boundary/pipeline";
import type { CompiledInteractions, InteractionHandle, HandleSelection } from "@foxworth/boundary/pipeline";
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { JsonValue } from "@foxworth/boundary/program";
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { InteractionDefinition } from "@foxworth/boundary";
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { CompiledSurface } from "@foxworth/boundary/pipeline";
import type { draftsInteractions } from "./definitions";

type DraftsCompiled = CompiledInteractions<typeof draftsInteractions>;

function requestOnly<Handle extends InteractionHandle>(
  handle: Handle,
): HandleSelection<Handle, readonly ["request"]> {
  return Object.freeze({
    interaction: handle,
    modes: Object.freeze(["request"] as const),
  });
}

/** A worker's authority: propose only, direct mode. Never accept or reject. */
export async function proposerSurface(compiled: DraftsCompiled) {
  return projectInteractions(compiled, {
    propose: { interaction: compiled.handles.propose, modes: ["direct"] },
  });
}

/** An author's authority: accept and reject, request mode. Never propose. */
export async function authorSurface(compiled: DraftsCompiled) {
  return projectInteractions(compiled, {
    accept: requestOnly(compiled.handles.accept),
    reject: requestOnly(compiled.handles.reject),
  });
}

/**
 * No Draft authority at all: neither propose, nor accept, nor reject. For
 * a host that only needs to gate invocation of interactions already
 * declared and must prove it grants no Draft-deciding capability at all.
 */
export async function runnerSurface(compiled: DraftsCompiled) {
  return projectInteractions(compiled, {});
}
