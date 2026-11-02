import { isDeclaredInteractionError, InteractionFault } from "@foxworth/boundary";
import type { projection } from "./boundary";

export type SaveResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "saved"; revision: number }>
  | Readonly<{ status: "conflict"; actualRevision: number }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "uncertain" }>;

/** Called only after invocation; an unknown fault is never a denied save. */
export function saveFailure(
  error: unknown,
  handle: typeof projection.handles.save,
): Exclude<SaveResult, { status: "idle" | "saved" }> {
  if (isDeclaredInteractionError(error, handle, "conflict")) {
    return { status: "conflict", actualRevision: error.details.actualRevision };
  }
  if (error instanceof InteractionFault && error.certainty === "not-started") {
    return { status: "rejected" };
  }
  return { status: "uncertain" };
}
