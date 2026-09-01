export interface FrameworkHttpHandler {
  readonly metadata: { readonly method: string; readonly path: string };
  handle(request: Request, params?: Readonly<Record<string, string>>): Promise<Response>;
}

export type NextRouteContext = { readonly params?: Promise<Readonly<Record<string, string | string[]>>> };

export function nextRoute(handler: FrameworkHttpHandler): (request: Request, context?: NextRouteContext) => Promise<Response> {
  return async (request, context) => {
    const raw = await context?.params;
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw ?? {})) params[name] = Array.isArray(value) ? value.join("/") : value;
    return handler.handle(request, params);
  };
}

export function nextRouteExports(handlers: readonly FrameworkHttpHandler[]): Readonly<Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", ReturnType<typeof nextRoute>>>> {
  const output: Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", ReturnType<typeof nextRoute>>> = {};
  const supported = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"] as const);
  for (const handler of handlers) {
    const method = handler.metadata.method as keyof typeof output;
    if (!supported.has(method)) throw new TypeError(`Unsupported Next route method: ${handler.metadata.method}`);
    if (output[method] !== undefined) throw new TypeError(`Duplicate Next route method: ${method}`);
    output[method] = nextRoute(handler);
  }
  return Object.freeze(output);
}
