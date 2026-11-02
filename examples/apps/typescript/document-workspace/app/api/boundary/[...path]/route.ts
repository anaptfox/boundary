import { createProjectionHandlers } from "@foxworth/boundary/frameworks/next";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { demoContextFromCookie } from "../../../../lib/context";
import { binding } from "../../../../lib/boundary";
import { tracedContext } from "../../../../lib/activity";

const handler = createProtocolHandler({
  binding,
  path: "/api/boundary",
  context: (request) => tracedContext(demoContextFromCookie(request.headers.get("cookie")), "protocol"),
});

export const { GET, POST } = createProjectionHandlers(handler);
