/**
 * Three Projection presets over the compiled Draft interactions, one per authority.
 *
 * A worker proposes. An author accepts or rejects. Neither implies the
 * other, and a host that only needs to gate invocation of already-declared
 * interactions needs neither: {@link runnerProjection} selects nothing at all.
 * No preset here hands out every Draft capability; that convenience would
 * erase the authority split the other two presets exist to express. A host
 * that genuinely wants every capability composes its own Projection from
 * `compiled.handles` directly — this module does not ship that shortcut.
 */
import { direct } from "@foxworth/boundary";
import { projectInteractions } from "@foxworth/boundary";
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { JsonValue } from "@foxworth/boundary/program";
import type { CompiledInteractions, InteractionHandle, ProjectionSelection } from "@foxworth/boundary";
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { InteractionDefinition, Projection } from "@foxworth/boundary";
import type { draftsInteractions } from "./definitions";

type DraftsCompiled = CompiledInteractions<typeof draftsInteractions>;

function requestOnly<Handle extends InteractionHandle>(
  handle: Handle,
): ProjectionSelection<Handle, readonly ["request"]> {
  return Object.freeze({
    interaction: handle,
    modes: Object.freeze(["request"] as const),
  });
}

/** A worker's authority: propose only, direct mode. Never accept or reject. */
export function proposerProjection(compiled: DraftsCompiled) {
  return projectInteractions(compiled, {
    propose: direct(compiled.handles.propose),
  });
}

/** An author's authority: accept and reject, request mode. Never propose. */
export function authorProjection(compiled: DraftsCompiled) {
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
export function runnerProjection(compiled: DraftsCompiled) {
  return projectInteractions(compiled, {});
}
