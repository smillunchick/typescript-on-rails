import {
  cookie,
  defineHttpHandler,
  requireTrustedMutation,
  requireTrustedOrigin,
} from "@typescript-on-rails/web";
import { durableEvent } from "@typescript-on-rails/jobs";

import { authenticateSession } from "../features/access/index.js";
import { createProjectRoute } from "../features/projects/index.js";
import { cookieValue, identity, jobs, sessions } from "./runtime.js";

const origin = "https://localhost:3420";
const ProjectCreatedDurable = durableEvent({ name: "ProjectCreated", parse(value: unknown) { if (typeof value !== "object" || value === null || !("projectId" in value) || typeof value.projectId !== "string") throw new Error("PROJECT_EVENT_INVALID"); return { projectId: value.projectId }; } });
const sessionCookie = "__Host-tor-session";
const csrfCookie = "__Host-tor-csrf";

export const signInHandler = defineHttpHandler({
  name: "sign-in",
  method: "POST",
  path: "/api/session",
  context: (request) => ({ requestId: crypto.randomUUID(), signal: request.signal }),
  handle: async (input) => {
    requireTrustedOrigin({ request: input.request, trustedOrigins: [origin] });
    const body = input.body;
    if (typeof body !== "object" || body === null || !("subject" in body) || !("proof" in body) || typeof body.subject !== "string" || typeof body.proof !== "string") throw Object.assign(new Error("INVALID_INPUT"), { code: "INVALID_INPUT" });
    const actor = await authenticateSession.execute(body, {
      permissions: new Set(),
      authenticate: (credentials) => identity.authenticate(credentials),
    });
    return {
      token: await sessions.create(actor.actorId, new Date(Date.now() + 3_600_000)),
      csrf: crypto.randomUUID().replaceAll("-", ""),
    };
  },
  respond: ({ token, csrf }) => {
    const headers = new Headers();
    headers.append("Set-Cookie", cookie(sessionCookie, token, { sameSite: "Lax", maxAgeSeconds: 3600 }));
    headers.append("Set-Cookie", cookie(csrfCookie, csrf, { httpOnly: false, sameSite: "Strict", maxAgeSeconds: 3600 }));
    return Response.json({ signedIn: true }, { headers });
  },
});

export const createProjectHandler = defineHttpHandler({
  name: "create-project",
  method: "POST",
  path: "/api/projects",
  context: async (request) => {
    const token = cookieValue(request, sessionCookie);
    const session = token === undefined ? undefined : await sessions.read(token, new Date());
    return { requestId: crypto.randomUUID(), signal: request.signal, ...(session === undefined ? {} : { actor: { id: session.actorId } }) };
  },
  authorize: (_input, context) => context.actor !== undefined,
  handle: async (input, context) => {
    requireTrustedMutation({
      request: input.request,
      trustedOrigins: [origin],
      csrfCookie: cookieValue(input.request, csrfCookie),
      csrfValue: input.request.headers.get("x-csrf-token") ?? undefined,
    });
    const permissions = new Set(["project.create", "project.read"]);
    const project = await createProjectRoute.execute(input.body, { permissions });
    await jobs.appendOutbox(ProjectCreatedDurable, { projectId: project.id }, `project-created:${project.id}`);
    await jobs.enqueue({ name: "projects.welcome", payload: { projectId: project.id }, idempotencyKey: `welcome:${project.id}` });
    return project;
  },
});
