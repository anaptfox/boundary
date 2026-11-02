import { documentCaller } from "../../../lib/boundary";
import { demoContextFromCookie } from "../../../lib/context";

export async function GET(request: Request) {
  try {
    const context = demoContextFromCookie(request.headers.get("cookie"));
    return Response.json(
      await documentCaller(() => context).read.publicationStatus({ id: "doc-1" },
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Choose a demo session" }, { status: 401 });
  }
}
