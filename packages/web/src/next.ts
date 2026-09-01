import type { ApplicationGraph, ExecutionContext, RouteDefinition, RouteMethod, RuntimeBinding } from "typescript-on-rails";

import { ROUTE_BINDING_PROTOCOL } from "./protocol.js";

export interface FrameworkHttpHandler {
  readonly metadata: { readonly method: string; readonly path: string };
  handle(request: Request, params?: Readonly<Record<string, string>>): Promise<Response>;
}

export type NextRouteContext = { readonly params?: Promise<Readonly<Record<string, string | string[]>>> };

type ApplicationGraphLike = Pick<ApplicationGraph, "entrypoints">;

type RouteTarget = Pick<RouteDefinition<unknown, unknown, ExecutionContext>, "metadata">;

function isBoundRoute(binding: RuntimeBinding): binding is RuntimeBinding<RouteTarget> & FrameworkHttpHandler {
  return binding.binding.protocol === ROUTE_BINDING_PROTOCOL &&
    "metadata" in binding.target &&
    typeof binding.target.metadata === "object" &&
    binding.target.metadata !== null &&
    "path" in binding.target.metadata &&
    typeof binding.target.metadata.path === "string" &&
    "metadata" in binding &&
    "handle" in binding &&
    typeof binding.handle === "function";
}

export function nextRoute(handler: FrameworkHttpHandler): (request: Request, context?: NextRouteContext) => Promise<Response> {
  return async (request, context) => {
    const raw = await context?.params;
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw ?? {})) params[name] = Array.isArray(value) ? value.join("/") : value;
    return handler.handle(request, params);
  };
}

export function nextRouteExports(handlers: readonly FrameworkHttpHandler[]): Readonly<Partial<Record<RouteMethod, ReturnType<typeof nextRoute>>>> {
  const output: Partial<Record<RouteMethod, ReturnType<typeof nextRoute>>> = {};
  const supported = new Set<RouteMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  for (const handler of handlers) {
    const method = handler.metadata.method as keyof typeof output;
    if (!supported.has(method)) throw new TypeError(`Unsupported Next route method: ${handler.metadata.method}`);
    if (output[method] !== undefined) throw new TypeError(`Duplicate Next route method: ${method}`);
    output[method] = nextRoute(handler);
  }
  return Object.freeze(output);
}

export function nextRouteExportsFor(
  graph: ApplicationGraphLike,
  path: string,
): Readonly<Partial<Record<RouteMethod, ReturnType<typeof nextRoute>>>> {
  const handlers = (graph.entrypoints.web?.bindings ?? []).filter((binding): binding is RuntimeBinding<RouteTarget> & FrameworkHttpHandler =>
    isBoundRoute(binding) && binding.target.metadata.path === path,
  );
  if (handlers.length === 0) throw new Error(`NEXT_ROUTE_NOT_REGISTERED:${path}`);
  return nextRouteExports(handlers);
}

export function nextRouteFor(
  graph: ApplicationGraphLike,
  path: string,
  method: RouteMethod,
): ReturnType<typeof nextRoute> {
  const handler = nextRouteExportsFor(graph, path)[method];
  if (handler === undefined) throw new Error(`NEXT_ROUTE_METHOD_NOT_REGISTERED:${method} ${path}`);
  return handler;
}
