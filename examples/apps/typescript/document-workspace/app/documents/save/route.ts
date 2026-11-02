import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { demoContextFromCookie, type DemoContext } from "../../../lib/context";
import { documentCaller, projection } from "../../../lib/boundary";
import { saveFailure } from "../../../lib/save-result";
import { parseRichText } from "../../../lib/rich-text";

export async function POST(request: Request) {
  let context: DemoContext;
  let form: FormData;
  try {
    context = demoContextFromCookie(request.headers.get("cookie"));
  } catch {
    return new Response("choose a demo session", { status: 401 });
  }
  try {
    form = await request.formData();
  } catch {
    return new Response("save input is invalid", { status: 400 });
  }
  try {
    const boundary = documentCaller(() => context, () => revalidatePath("/"), "http");
    const id = form.get("id");
    const title = form.get("title");
    const body = form.get("body");
    const richText = form.get("richText");
    if (id !== "doc-1" || typeof title !== "string" || typeof body !== "string") {
      return new Response("save input is invalid", { status: 400 });
    }
    if (richText !== null && (typeof richText !== "string" || !parseRichText(richText))) {
      return new Response("rich text is invalid", { status: 400 });
    }
    await boundary.action.save({
      id,
      title,
      body,
      ...(typeof richText === "string" ? { richText } : {}),
      expectedRevision: Number(form.get("expectedRevision")),
    });
  } catch (error) {
    const failure = saveFailure(error, projection.handles.save);
    return Response.json(failure, {
      status: failure.status === "uncertain" ? 503 : failure.status === "conflict" ? 409 : 403,
    });
  }
  return NextResponse.redirect(new URL("/", request.url), 303);
}
