import { bindRoute, cookie, requestCookie, type BoundRoute } from "@typescript-on-rails/web";
import { withPostgresRequestUnitOfWork, type RequestTransactionScope } from "@typescript-on-rails/jobs";
import { Unauthorized } from "typescript-on-rails";

import { sessionRoute } from "../features/access/index.js";
import { createProjectRoute } from "../features/projects/index.js";
import type { ReferenceDatabase } from "./database.js";
import { referenceDatabase } from "./database.js";
import { postgresProjectRepository } from "./project-repository.js";
import { identity, sessions } from "./runtime.js";

const origin = "https://localhost:3420";
const sessionCookie = "__Host-tor-session";
const csrfCookie = "__Host-tor-csrf";

let defaultDatabase: ReturnType<typeof referenceDatabase> | undefined;

function configuredDatabase(): ReturnType<typeof referenceDatabase> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_REQUIRED_FOR_REQUEST");
  defaultDatabase ??= referenceDatabase(url);
  return defaultDatabase;
}

export function createHttpBindings(options: {
  readonly database?: () => RequestTransactionScope<ReferenceDatabase>;
} = {}) {
  const database = options.database ?? configuredDatabase;
  const signIn = bindRoute(sessionRoute, {
    mutation: { trustedOrigins: [origin] },
    scope: (_input, execute) => execute({
      permissions: new Set<string>(),
      authenticate: (credentials) => identity.authenticate(credentials),
    }),
    async respond(actor) {
      const token = await sessions.create(actor.actorId, new Date(Date.now() + 3_600_000));
      const csrf = crypto.randomUUID().replaceAll("-", "");
      const headers = new Headers();
      headers.append("Set-Cookie", cookie(sessionCookie, token, { sameSite: "Lax", maxAgeSeconds: 3600 }));
      headers.append("Set-Cookie", cookie(csrfCookie, csrf, { httpOnly: false, sameSite: "Strict", maxAgeSeconds: 3600 }));
      return Response.json({ signedIn: true }, { headers });
    },
  });
  const createProject = bindRoute(createProjectRoute, {
    mutation: {
      trustedOrigins: [origin],
      csrf: { cookie: csrfCookie, header: "x-csrf-token" },
    },
    async scope(input, execute) {
      const token = requestCookie(input.request, sessionCookie);
      const session = token === undefined ? undefined : await sessions.read(token, new Date());
      if (session === undefined) throw new Unauthorized();
      const requestId = input.request.headers.get("x-request-id") ?? crypto.randomUUID();
      return withPostgresRequestUnitOfWork(
        database(),
        { tenantId: "tenant_local", actorId: session.actorId, requestId },
        (unit) => execute({
          permissions: new Set(["project.create", "project.read"]),
          tenantId: unit.tenantId,
          projects: postgresProjectRepository(unit.transaction),
          outbox: unit.outbox,
        }),
      );
    },
  });
  return Object.freeze({ signIn, createProject });
}

const bindings = createHttpBindings();
export const signInHttpRoute: BoundRoute = bindings.signIn;
export const createProjectHttpRoute: BoundRoute = bindings.createProject;
