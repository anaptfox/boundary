import { requestContext } from "../../../lib/demo-request";
import { localModels } from "../../../lib/ollama";

/** Model discovery only. All conversation and agent work belongs to /api/room. */
export async function GET(request: Request) {
  try { requestContext(request); } catch { return Response.json({ error: "Choose a demo session." }, { status: 401 }); }
  try { return Response.json({ status: "available", ...await localModels() }, { headers: { "cache-control": "no-store" } }); }
  catch { return Response.json({ status: "offline", models: [], defaultModel: null }, { status: 503 }); }
}
