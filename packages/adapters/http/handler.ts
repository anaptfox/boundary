import type {
  InteractionMode,
  ProjectedInteractionHandle,
  ProjectionBinding,
} from "@foxworth/boundary";
import { createCheckedHandoff } from "@foxworth/boundary/handoff";
import { AdapterError } from "@foxworth/boundary/remote";
import {
  compileExposure,
  invokePreparedInteraction,
  prepareExposedInteraction,
  faultResult,
  sanitizedInternalResult,
  statusForRemoteResult,
  type InteractionHasInput,
  type InteractionInput,
  type RemoteCallResult,
} from "@foxworth/boundary/remote";
import {
  modeForHandle,
  interactionKey,
  snapshotProjectedHandle,
  type AnyProjectedInteractionHandle,
} from "@foxworth/boundary/remote";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HttpHandler = (request: Request) => Promise<Response>;

export type RouteInputContext = Readonly<{
  request: Request;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | readonly string[]>>;
  body(): Promise<unknown>;
}>;

type RouteBaseOptions = Readonly<{
  method: HttpMethod;
  path: string;
  mode?: InteractionMode;
  successStatus?: number;
  headers?: Readonly<Record<string, string>>;
}>;

export type RouteOptions<Handle extends AnyProjectedInteractionHandle> =
  InteractionHasInput<Handle> extends false
    ? RouteBaseOptions & Readonly<{ input?: never }>
    : RouteBaseOptions & Readonly<{
        input?: (context: RouteInputContext) =>
          | InteractionInput<Handle>
          | Promise<InteractionInput<Handle>>;
      }>;

export type HttpRoute<
  Handle extends AnyProjectedInteractionHandle = AnyProjectedInteractionHandle,
> = Readonly<{
  handle: Handle;
  mode: InteractionMode;
  method: HttpMethod;
  path: string;
  inputMapping: "default" | "custom";
  successStatus?: number;
  headers?: Readonly<Record<string, string>>;
}>;

type RouteRuntime = Readonly<{
  handle: AnyProjectedInteractionHandle;
  mode: InteractionMode;
  method: HttpMethod;
  path: string;
  pattern: RegExp;
  parameters: readonly string[];
  input?: (context: RouteInputContext) => unknown | Promise<unknown>;
  successStatus?: number;
  headers: Readonly<Record<string, string>>;
}>;

const routeRuntimes = new WeakMap<object, RouteRuntime>();
const requestFailures = new WeakMap<
  object,
  Readonly<{ path: string; message: string }>
>();
const PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function requestFailure(path: string, message: string): AdapterError {
  const error = new AdapterError("INVALID_REQUEST", path, message);
  requestFailures.set(error, Object.freeze({ path, message }));
  return error;
}

function fail(path: string, message: string): never {
  throw new AdapterError("INVALID_DECLARATION", path, message);
}

function pathPattern(path: string): {
  readonly pattern: RegExp;
  readonly parameters: readonly string[];
} {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    fail("route.path", "route paths must be absolute pathnames without query or fragment");
  }
  const parameters: string[] = [];
  const pieces = path.split("/").filter(Boolean).map((segment) => {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      const name = segment.slice(1, -1);
      if (!PATH_SEGMENT.test(name) || parameters.includes(name)) {
        fail("route.path", `invalid or duplicate route parameter: ${name}`);
      }
      parameters.push(name);
      return "([^/]+)";
    }
    if (segment.includes("{") || segment.includes("}")) {
      fail("route.path", "route parameters must occupy a complete path segment");
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  });
  return {
    pattern: new RegExp(`^/${pieces.join("/")}${path.endsWith("/") && pieces.length > 0 ? "/" : ""}$`, "u"),
    parameters: Object.freeze(parameters),
  };
}

export function route<Handle extends AnyProjectedInteractionHandle>(
  handleValue: Handle,
  options: RouteOptions<Handle>,
): HttpRoute<Handle> {
  const handle = snapshotProjectedHandle(handleValue, "route.handle");
  const mode = modeForHandle(handle, options.mode, "route.mode");
  const method = options.method?.toUpperCase() as HttpMethod;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    fail("route.method", `unsupported HTTP method: ${String(options.method)}`);
  }
  const parsedPath = pathPattern(options.path);
  if (handle.inputArity === 0 && parsedPath.parameters.length > 0) {
    fail("route.path", `${handle.interactionId} takes no input and cannot bind path parameters`);
  }
  if (handle.inputArity === 0 && options.input !== undefined) {
    fail("route.input", `${handle.interactionId} takes no input and cannot declare an input mapping`);
  }
  if (
    options.successStatus !== undefined &&
    (!Number.isInteger(options.successStatus) ||
      options.successStatus < 200 ||
      options.successStatus > 299 ||
      options.successStatus === 204 ||
      options.successStatus === 205)
  ) {
    fail("route.successStatus", "successStatus must be a body-bearing 2xx integer");
  }
  if (options.input !== undefined && typeof options.input !== "function") {
    fail("route.input", "input must be a function");
  }
  const headers = Object.freeze({ ...options.headers });
  const declaration = Object.freeze({
    handle: handleValue,
    mode,
    method,
    path: options.path,
    inputMapping: options.input === undefined ? "default" : "custom",
    ...(options.successStatus === undefined ? {} : { successStatus: options.successStatus }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  }) as HttpRoute<Handle>;
  routeRuntimes.set(declaration, Object.freeze({
    handle,
    mode,
    method,
    path: options.path,
    ...parsedPath,
    ...(options.input === undefined ? {} : { input: options.input as NonNullable<RouteRuntime["input"]> }),
    ...(options.successStatus === undefined ? {} : { successStatus: options.successStatus }),
    headers,
  }));
  return declaration;
}

function queryObject(url: URL): Readonly<Record<string, string | readonly string[]>> {
  const values: Record<string, string | readonly string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    values[key] = all.length === 1 ? all[0]! : Object.freeze(all);
  }
  return Object.freeze(values);
}

async function requestBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw requestFailure("request.body", "request body must be valid JSON");
  }
}

function matchRoute(
  routes: readonly RouteRuntime[],
  request: Request,
): Readonly<{ route: RouteRuntime; params: Readonly<Record<string, string>> }> | undefined {
  const url = new URL(request.url);
  for (const route of routes) {
    if (route.method !== request.method) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [index, name] of route.parameters.entries()) {
      try {
        params[name] = decodeURIComponent(match[index + 1]!);
      } catch {
        throw requestFailure(`request.params.${name}`, "path parameter is not valid URI encoding");
      }
    }
    return Object.freeze({ route, params: Object.freeze(params) });
  }
  return undefined;
}

function mergePathInput(body: unknown, params: Readonly<Record<string, string>>): unknown {
  if (Object.keys(params).length === 0) return body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw requestFailure("request.body", "a route with path parameters requires an object input");
  }
  return Object.freeze({ ...(body as Record<string, unknown>), ...params });
}

async function routeInput(route: RouteRuntime, context: RouteInputContext): Promise<unknown> {
  if (route.handle.inputArity === 0) {
    if (Object.keys(context.params).length > 0 || Object.keys(context.query).length > 0) {
      throw requestFailure(`${route.handle.interactionId}.input`, "this interaction takes no input");
    }
    if (route.method !== "GET") {
      const body = await context.body();
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
        throw requestFailure(`${route.handle.interactionId}.input`, "a no-input interaction accepts only an empty JSON object");
      }
    }
    return null;
  }
  if (route.input) return route.input(context);
  if (route.method === "GET") return Object.freeze({ ...context.query, ...context.params });
  return mergePathInput(await context.body(), context.params);
}

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

function compileRoutes(routes: readonly HttpRoute[]): readonly RouteRuntime[] {
  const seen = new Set<string>();
  return Object.freeze(routes.map((declaration, index) => {
    const runtime = routeRuntimes.get(declaration);
    if (!runtime) fail(`routes[${index}]`, "routes must be created by route()");
    const key = `${runtime.method} ${runtime.path}`;
    if (seen.has(key)) {
      throw new AdapterError("DUPLICATE_DECLARATION", `routes[${index}]`, `duplicate route: ${key}`);
    }
    seen.add(key);
    return runtime;
  }));
}

export type CreateHttpHandlerOptions<Context> = Readonly<{
  binding: ProjectionBinding<any, Context>;
  context(request: Request): Context | Promise<Context>;
  routes: readonly HttpRoute[];
}>;

/** Build a Fetch-native adapter over one exact live Binding. */
export function createHttpHandler<Context>(
  options: CreateHttpHandlerOptions<Context>,
): HttpHandler {
  if (!options || typeof options.context !== "function") {
    fail("createHttpHandler.context", "context must resolve one invocation-scoped host value");
  }
  const routes = compileRoutes(options.routes);
  const exposure = createCheckedHandoff(options.binding).then((handoff) =>
    compileExposure(handoff, routes.map((entry) => ({
      handle: entry.handle,
      mode: entry.mode,
    }))),
  );

  return async (request: Request): Promise<Response> => {
    let matched: ReturnType<typeof matchRoute>;
    try {
      matched = matchRoute(routes, request);
    } catch {
      return json({ error: { kind: "protocol", code: "INVALID_REQUEST", message: "The request path is invalid." } }, 400);
    }
    if (!matched) {
      return json({ error: { kind: "protocol", code: "ROUTE_NOT_FOUND", message: "No route matched." } }, 404);
    }
    let compiled: Awaited<typeof exposure>;
    try {
      compiled = await exposure;
    } catch {
      return json({
        certainty: "not-started",
        error: {
          kind: "internal",
          code: "ADAPTER_INITIALIZATION_FAILED",
          message: "The HTTP adapter could not initialize its declared exposure.",
        },
      }, 500);
    }
    const exposed = compiled.interactions.get(interactionKey(
      matched.route.handle.interactionId,
      matched.route.mode,
    ));
    if (!exposed) {
      return json({
        certainty: "not-started",
        error: {
          kind: "internal",
          code: "ADAPTER_INITIALIZATION_FAILED",
          message: "The HTTP adapter could not resolve its declared route.",
        },
      }, 500);
    }
    const url = new URL(request.url);
    let bodyPromise: Promise<unknown> | undefined;
    const inputContext: RouteInputContext = Object.freeze({
      request,
      params: matched.params,
      query: queryObject(url),
      body() {
        return (bodyPromise ??= requestBody(request));
      },
    });
    let prepared: Awaited<ReturnType<typeof prepareExposedInteraction>>;
    let context: Context;
    try {
      context = await options.context(request);
      prepared = await prepareExposedInteraction({
        exposure: compiled,
        handle: matched.route.handle,
        mode: matched.route.mode,
        input: await routeInput(matched.route, inputContext),
      });
    } catch (error) {
      const issue = error instanceof AdapterError
        ? requestFailures.get(error)
        : undefined;
      const result = issue === undefined
        ? faultResult(compiled, exposed, "realization-failed")
        : faultResult(compiled, exposed, "invalid-input", [issue]);
      return json(result, statusForRemoteResult(result), matched.route.headers);
    }
    let result: RemoteCallResult;
    try {
      result = await invokePreparedInteraction(compiled, prepared.invocation, context);
    } catch {
      result = sanitizedInternalResult(compiled, prepared.exposed);
    }
    const status =
      result.result.kind === "returned" || result.result.kind === "proposed"
        ? (matched.route.successStatus ?? statusForRemoteResult(result))
        : statusForRemoteResult(result);
    return json(result, status, matched.route.headers);
  };
}

export type { ProjectedInteractionHandle };
