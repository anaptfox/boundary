"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { demoContextFromCookie } from "../lib/context";
import { documentCaller, projection, publications } from "../lib/boundary";
import type { PublicationView } from "../lib/publication";

export type PublicationActionResult = {
  view?: PublicationView;
  message?: string;
};
async function context() {
  return demoContextFromCookie((await cookies()).toString());
}
export async function publicationAction(
  _previous: PublicationActionResult,
  form: FormData,
): Promise<PublicationActionResult> {
  const current = await context();
  try {
    const mode = form.get("mode");
    if (mode === "request") {
      const revision = Number(form.get("revision"));
      await documentCaller(() => current).action.request(
        projection.handles.publish,
        { id: "doc-1", expectedRevision: revision },
      );
    } else if (mode === "approve" || mode === "reconcile") {
      const id = form.get("proposal");
      const digest = form.get("digest");
      if (
        typeof id !== "string" || typeof digest !== "string" ||
        id.length > 200 || digest.length > 100
      ) throw new Error("Invalid publication reference");
      await publications.review(id, digest, current, mode === "reconcile");
    } else if (mode !== "inspect") {
      throw new Error("Unknown publication action");
    }
    revalidatePath("/");
    return { view: await publications.view(current) };
  } catch {
    // An interrupted reply is not evidence that an effect did not happen.
    return {
      message:
        "Publication needs inspection. Check status before making another request; nothing will be retried automatically.",
    };
  }
}
