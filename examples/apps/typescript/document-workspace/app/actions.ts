"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { demoContextFromCookie, type DemoContext } from "../lib/context";
import { documentCaller, projection } from "../lib/boundary";
import { saveFailure, type SaveResult } from "../lib/save-result";
import { parseRichText } from "../lib/rich-text";

export type SaveDocumentActionResult = SaveResult;

/** A genuine Next Server Action; its context is derived again for every form submission. */
export async function saveDocumentAction(
  _previous: SaveDocumentActionResult,
  form: FormData,
): Promise<SaveDocumentActionResult> {
  const id = form.get("id");
  const title = form.get("title");
  const body = form.get("body");
  const richText = form.get("richText");
  const expectedRevision = Number(form.get("expectedRevision"));
  if (
    id !== "doc-1" || typeof title !== "string" || typeof body !== "string"
    || !Number.isInteger(expectedRevision) || expectedRevision < 1
  ) return { status: "rejected" };
  if (richText !== null && (typeof richText !== "string" || !parseRichText(richText))) {
    return { status: "rejected" };
  }
  let context: DemoContext;
  try {
    const session = (await cookies()).get("boundary_demo_session")?.value ?? null;
    context = demoContextFromCookie(session === null ? null : `boundary_demo_session=${session}`);
  } catch {
    return { status: "rejected" };
  }
  try {
    const boundary = documentCaller(() => context, () => revalidatePath("/"), "human");
    const saved = await boundary.action.save({
      id,
      title,
      body,
      ...(typeof richText === "string" ? { richText } : {}),
      expectedRevision,
    });
    return { status: "saved", revision: saved.revision };
  } catch (error) {
    return saveFailure(error, projection.handles.save);
  }
}
