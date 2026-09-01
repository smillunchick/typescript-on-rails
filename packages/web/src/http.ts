type MaybePromise<T> = T | Promise<T>;

export type CachePolicy = "no-store" | { readonly publicSeconds: number } | { readonly privateSeconds: number };
export interface HttpFile {
  readonly field: string;
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}
export interface HttpInput {
  readonly request: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body: unknown;
  readonly form?: FormData;
  readonly files: readonly HttpFile[];
}
export interface HttpContext { readonly requestId: string; readonly actor?: { readonly id: string }; readonly signal: AbortSignal }
export interface HttpObservation { start(name: string, request: Request): { end(status: number, error?: unknown): void } }

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "HttpError"; }
}

export interface HttpHandlerOptions<TContext extends HttpContext, TOutput> {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly maximumBodyBytes?: number;
  readonly cache?: CachePolicy;
  readonly guard?: (request: Request) => MaybePromise<void>;
  readonly context: (request: Request) => Promise<TContext> | TContext;
  readonly authorize?: (input: HttpInput, context: TContext) => Promise<boolean> | boolean;
  readonly handle: (input: HttpInput, context: TContext) => Promise<TOutput> | TOutput;
  readonly respond?: (output: TOutput) => MaybePromise<Response>;
  readonly observe?: HttpObservation;
}

async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel("body too large"); throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large"); }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "INVALID_TEXT", "Request text is invalid UTF-8");
  }
}

function formBody(form: FormData): Readonly<Record<string, string | readonly string[]>> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of form) {
    if (typeof value !== "string") continue;
    const prior = output[name];
    if (prior === undefined) output[name] = value;
    else if (Array.isArray(prior)) prior.push(value);
    else output[name] = [prior, value];
  }
  return Object.freeze(output);
}

async function requestInput(request: Request, maximumBodyBytes: number, params: Readonly<Record<string, string>>): Promise<HttpInput> {
  const rawContentType = request.headers.get("content-type") ?? undefined;
  const contentType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase();
  const bytes =
    request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : await boundedBytes(request, maximumBodyBytes);
  let body: unknown = undefined;
  let form: FormData | undefined;
  const files: HttpFile[] = [];
  if (bytes.byteLength > 0 && contentType === "application/json") {
    try { body = JSON.parse(decodeText(bytes)); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "INVALID_JSON", "Request JSON is invalid");
    }
  } else if (bytes.byteLength > 0 && contentType === "application/x-www-form-urlencoded") {
    form = new FormData();
    for (const [key, value] of new URLSearchParams(decodeText(bytes))) form.append(key, value);
    body = formBody(form);
  } else if (bytes.byteLength > 0 && contentType === "multipart/form-data") {
    if (rawContentType === undefined) throw new HttpError(400, "MULTIPART_BOUNDARY_MISSING", "Multipart boundary is missing");
    try {
      form = await new Response(Uint8Array.from(bytes).buffer, {
        headers: { "content-type": rawContentType },
      }).formData();
    } catch {
      throw new HttpError(400, "INVALID_MULTIPART", "Multipart form is invalid");
    }
    for (const [field, value] of form) {
      if (typeof value === "string") continue;
      files.push(Object.freeze({
        field,
        name: value.name,
        type: value.type,
        bytes: new Uint8Array(await value.arrayBuffer()),
      }));
    }
    body = formBody(form);
  } else if (bytes.byteLength > 0 && contentType?.startsWith("text/") === true) body = decodeText(bytes);
  else if (bytes.byteLength > 0) body = bytes;
  return Object.freeze({ request, params: Object.freeze({ ...params }), query: new URL(request.url).searchParams, headers: request.headers, body, ...(form === undefined ? {} : { form }), files: Object.freeze(files) });
}

function cacheHeader(policy: CachePolicy | undefined): string {
  if (policy === undefined || policy === "no-store") return "no-store";
  if ("publicSeconds" in policy) return `public, max-age=${String(policy.publicSeconds)}`;
  return `private, max-age=${String(policy.privateSeconds)}`;
}

export function safeErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: secureHeaders() },
    );
  }
  const candidate =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "UNEXPECTED";
  const statusByCode: Readonly<Record<string, number>> = {
    INVALID_INPUT: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNAVAILABLE: 503,
  };
  const status = statusByCode[candidate] ?? 500;
  const code = status === 500 ? "UNEXPECTED" : candidate;
  const message = status === 500 ? "Unexpected server error" : code.replaceAll("_", " ").toLowerCase();
  return Response.json({ error: { code, message } }, { status, headers: secureHeaders() });
}

export function defineHttpHandler<TContext extends HttpContext, TOutput>(options: HttpHandlerOptions<TContext, TOutput>) {
  if (!options.path.startsWith("/")) throw new TypeError("HTTP paths must be absolute");
  const method = options.method.toUpperCase();
  return Object.freeze({
    metadata: Object.freeze({ kind: "http-handler" as const, name: options.name, method, path: options.path, cache: options.cache ?? "no-store" }),
    async handle(request: Request, params: Readonly<Record<string, string>> = {}): Promise<Response> {
      const observation = options.observe?.start(options.name, request);
      try {
        if (request.method.toUpperCase() !== method) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        await options.guard?.(request);
        const context = await options.context(request);
        const input = await requestInput(request, options.maximumBodyBytes ?? 1024 * 1024, params);
        if (options.authorize !== undefined && !(await options.authorize(input, context))) throw new HttpError(403, "FORBIDDEN", "Access forbidden");
        const output = await options.handle(input, context);
        const response = await options.respond?.(output) ?? Response.json(output);
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(secureHeaders())) if (!headers.has(name)) headers.set(name, value);
        headers.set("Cache-Control", cacheHeader(options.cache));
        const final = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        observation?.end(final.status);
        return final;
      } catch (error) {
        const response = safeErrorResponse(error);
        observation?.end(response.status, error);
        return response;
      }
    },
  });
}

export function secureHeaders(nonce?: string): Readonly<Record<string, string>> {
  if (nonce !== undefined && !/^[A-Za-z0-9+/_=-]{16,128}$/.test(nonce)) throw new TypeError("CSP_NONCE_INVALID");
  return Object.freeze({
    "Cache-Control": "no-store",
    "Content-Security-Policy": [`default-src 'self'`, `base-uri 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, nonce === undefined ? `script-src 'none'` : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

function equal(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function requireTrustedOrigin(input: {
  readonly request: Request;
  readonly trustedOrigins: readonly string[];
}): void {
  const origin = input.request.headers.get("origin");
  const fetchSite = input.request.headers.get("sec-fetch-site");
  if (origin === null || !input.trustedOrigins.includes(origin) || fetchSite === "cross-site") {
    throw new HttpError(403, "UNTRUSTED_ORIGIN", "Mutation origin is not trusted");
  }
}

export function requireTrustedMutation(input: {
  readonly request: Request;
  readonly trustedOrigins: readonly string[];
  readonly csrfCookie: string | undefined;
  readonly csrfValue: string | undefined;
}): void {
  requireTrustedOrigin(input);
  if (
    input.csrfCookie === undefined ||
    input.csrfValue === undefined ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(input.csrfCookie) ||
    !equal(input.csrfCookie, input.csrfValue)
  ) throw new HttpError(403, "CSRF_INVALID", "CSRF proof is invalid");
}

export function requestCookie(request: Request, name: string): string | undefined {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0 && item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
  }
  return undefined;
}

export function cookie(name: string, value: string, options: { readonly httpOnly?: boolean; readonly secure?: boolean; readonly sameSite?: "Strict" | "Lax"; readonly maxAgeSeconds?: number } = {}): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u001F\u007F;,\s]/.test(value)) throw new TypeError("COOKIE_INVALID");
  const parts = [`${name}=${value}`, "Path=/", `SameSite=${options.sameSite ?? "Lax"}`];
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  if (options.secure ?? true) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`);
  return parts.join("; ");
}

export interface SessionHooks<TSession> { read(request: Request): Promise<TSession | undefined>; commit(session: TSession): Promise<string>; clear(request: Request): Promise<string> }

export function stream(body: ReadableStream<Uint8Array>, init: ResponseInit = {}): Response { return new Response(body, init); }
