import {
  runtimeBinding,
  type ExecutionContext,
  type RouteDefinition,
  type RuntimeBinding,
} from "typescript-on-rails";

import {
  defineHttpHandler,
  requestCookie,
  requireTrustedMutation,
  requireTrustedOrigin,
  type CachePolicy,
  type HttpContext,
  type HttpInput,
  type HttpObservation,
} from "./http.js";
import type { FrameworkHttpHandler } from "./next.js";
import { ROUTE_BINDING_PROTOCOL } from "./protocol.js";

type MaybePromise<T> = T | Promise<T>;

export interface RouteMutationPolicy {
  readonly trustedOrigins: readonly string[];
  readonly csrf?: {
    readonly cookie: string;
    readonly header?: string;
  };
}

export interface RouteBindingOptions<
  TContext extends ExecutionContext,
  TResult,
> {
  readonly scope: (
    input: HttpInput,
    execute: (context: TContext) => Promise<TResult>,
  ) => MaybePromise<TResult>;
  readonly mutation?: RouteMutationPolicy;
  readonly mapInput?: (input: HttpInput) => unknown;
  readonly respond?: (output: TResult) => MaybePromise<Response>;
  readonly maximumBodyBytes?: number;
  readonly cache?: CachePolicy;
  readonly observe?: HttpObservation;
}

export type BoundRoute<
  TInput = unknown,
  TResult = unknown,
  TContext extends ExecutionContext = ExecutionContext,
> = RuntimeBinding<RouteDefinition<TInput, TResult, TContext>> & FrameworkHttpHandler;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function defaultRouteInput(input: HttpInput, method: string): unknown {
  const params = { ...input.params };
  if (method === "GET" || method === "DELETE") {
    return Object.freeze({ ...Object.fromEntries(input.query), ...params });
  }
  const body = record(input.body);
  if (body !== undefined) return Object.freeze({ ...body, ...params });
  if (Object.keys(params).length === 0) return input.body;
  return Object.freeze({ body: input.body, ...params });
}

function enforceMutationPolicy(request: Request, policy: RouteMutationPolicy): void {
  if (policy.csrf === undefined) {
    requireTrustedOrigin({ request, trustedOrigins: policy.trustedOrigins });
    return;
  }
  requireTrustedMutation({
    request,
    trustedOrigins: policy.trustedOrigins,
    csrfCookie: requestCookie(request, policy.csrf.cookie),
    csrfValue: request.headers.get(policy.csrf.header ?? "x-csrf-token") ?? undefined,
  });
}

export function bindRoute<
  TInput,
  TResult,
  TContext extends ExecutionContext,
>(
  route: RouteDefinition<TInput, TResult, TContext>,
  options: RouteBindingOptions<TContext, TResult>,
): BoundRoute<TInput, TResult, TContext> {
  const method = route.metadata.method;
  const mutation = options.mutation;
  if (method !== "GET" && mutation === undefined) {
    throw new TypeError("ROUTE_BINDING_MUTATION_POLICY_REQUIRED");
  }
  if (mutation !== undefined && mutation.trustedOrigins.length === 0) {
    throw new TypeError("ROUTE_BINDING_TRUSTED_ORIGIN_REQUIRED");
  }
  const handler = defineHttpHandler<HttpContext, TResult>({
    name: `${method} ${route.metadata.path}`,
    method,
    path: route.metadata.path,
    ...(mutation === undefined ? {} : { guard: (request: Request) => enforceMutationPolicy(request, mutation) }),
    context: (request) => ({
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      signal: request.signal,
    }),
    handle: async (input) => {
      const routeInput = options.mapInput?.(input) ?? defaultRouteInput(input, method);
      return options.scope(input, (context) => route.execute(routeInput, context));
    },
    ...(options.respond === undefined ? {} : { respond: options.respond }),
    ...(options.maximumBodyBytes === undefined ? {} : { maximumBodyBytes: options.maximumBodyBytes }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.observe === undefined ? {} : { observe: options.observe }),
  });
  return Object.freeze({
    ...runtimeBinding({
      name: `${method} ${route.metadata.path}`,
      protocol: ROUTE_BINDING_PROTOCOL,
      process: "web",
      target: route,
    }),
    metadata: handler.metadata,
    handle: handler.handle,
  });
}
