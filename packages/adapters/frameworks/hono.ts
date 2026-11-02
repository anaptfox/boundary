import type { Context, Env, Input, MiddlewareHandler } from "hono";
import type { HttpHandler } from "@foxworth/boundary/http";

/**
 * Turn one explicit surface HTTP handler into Hono middleware.
 * The Hono application chooses the route or prefix where it is installed.
 */
export function mountSurface(handler: HttpHandler): MiddlewareHandler {
  return (context) => handler(context.req.raw);
}

/**
 * Creates the already-checked HTTP handler for one native Hono invocation.
 *
 * The application prepares its Binding outside the request, then
 * uses this factory to derive host context from Hono middleware, route
 * parameters, bindings, and (when present) the runtime execution context.
 * Receiving a Context selects request data; it neither grants authority nor
 * changes the Surface's selected interactions.
 */
export type SurfaceHonoHandlerFactory<
  Environment extends Env = Env,
  Path extends string = string,
  RequestInput extends Input = Input,
> = (
  context: Context<Environment, Path, RequestInput>,
) => HttpHandler | Promise<HttpHandler>;

/**
 * Adapt a per-invocation surface handler factory to Hono middleware.
 *
 * Unlike {@link mountSurface}, this preserves Hono's typed Context for the
 * host to derive invocation-scoped context. It does not provide automatic
 * Hono RPC routing or infer any authority from a route or middleware value.
 */
export function createSurfaceHonoMiddleware<
  Environment extends Env = Env,
  Path extends string = string,
  RequestInput extends Input = Input,
>(
  createHandler: SurfaceHonoHandlerFactory<Environment, Path, RequestInput>,
): MiddlewareHandler<Environment, Path, RequestInput> {
  return async (context) => {
    const handler = await createHandler(context);
    return handler(context.req.raw);
  };
}
