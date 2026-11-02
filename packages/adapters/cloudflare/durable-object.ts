import type { HttpHandler } from "@foxworth/boundary/http";

export interface SurfaceDurableObjectInstance {
  fetch(request: Request): Promise<Response>;
}

export type SurfaceDurableObjectClass<State = unknown, Environment = unknown> =
  new (state: State, environment: Environment) => SurfaceDurableObjectInstance;

export type DurableObjectHandlerFactory<State = unknown, Environment = unknown> =
  (state: State, environment: Environment) => HttpHandler;

/**
 * Give each Durable Object instance its own prebuilt surface HTTP handler.
 * State and environment stay in the application-owned factory.
 */
export function createSurfaceDurableObject<
  State = unknown,
  Environment = unknown,
>(
  createHandler: DurableObjectHandlerFactory<State, Environment>,
): SurfaceDurableObjectClass<State, Environment> {
  return class ProjectionDurableObject {
    readonly #handler: HttpHandler;

    constructor(state: State, environment: Environment) {
      this.#handler = createHandler(state, environment);
    }

    async fetch(request: Request): Promise<Response> {
      try {
        return await this.#handler(request);
      } catch {
        return new Response("Internal Server Error", { status: 500 });
      }
    }
  };
}
