import { bindRoute, cookie, requestCookie, type HttpInput } from "@typescript-on-rails/web";
import { withPostgresRequestUnitOfWork, type RequestTransactionScope } from "@typescript-on-rails/jobs";
import { Unauthorized } from "typescript-on-rails";

import { sessionRoute } from "../features/access/index.js";
import { acceptProjectInvitationRoute, createProjectInvitationRoute, createProjectRoute, type ProjectCommandContext } from "../features/projects/index.js";
import type { ReferenceDatabase } from "./database.js";
import { referenceDatabase } from "./database.js";
import { postgresProjectRepository } from "./project-repository.js";
import { postgresInvitationRepository } from "./invitation-repository.js";
import { identity, localPrincipal, sessions } from "./runtime.js";

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
  readonly now?: () => Date;
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
  // All three project mutations share the same trusted session and transaction.
  const authenticated = {
    mutation: {
      trustedOrigins: [origin],
      csrf: { cookie: csrfCookie, header: "x-csrf-token" },
    },
    async scope<TResult>(input: HttpInput, execute: (context: ProjectCommandContext) => Promise<TResult>) {
      const token = requestCookie(input.request, sessionCookie);
      const session = token === undefined ? undefined : await sessions.read(token, new Date());
      if (session === undefined) throw new Unauthorized();
      const principal = await localPrincipal(session.actorId);
      const requestId = input.request.headers.get("x-request-id") ?? crypto.randomUUID();
      return withPostgresRequestUnitOfWork(
        database(),
        { tenantId: principal.tenantId, actorId: principal.actorId, requestId },
        (unit) => execute({
          ...principal,
          now: options.now?.() ?? new Date(),
          projects: postgresProjectRepository(unit.transaction),
          invitations: postgresInvitationRepository(unit.transaction),
          outbox: unit.outbox,
        }),
      );
    },
  };
  return Object.freeze({
    signIn,
    createProject: bindRoute(createProjectRoute, authenticated),
    createProjectInvitation: bindRoute(createProjectInvitationRoute, authenticated),
    acceptProjectInvitation: bindRoute(acceptProjectInvitationRoute, authenticated),
  });
}

export const httpBindings = createHttpBindings();
