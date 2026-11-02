import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const form = await request.formData();
  const session = form.get("session");
  if (session !== "alice" && session !== "bob") return new Response("unknown demo session", { status: 400 });
  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set("boundary_demo_session", session, { httpOnly: true, sameSite: "lax", path: "/" });
  return response;
}
