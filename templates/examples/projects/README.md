# Full-stack TypeScript on Rails application

## Start locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Run `npm install`.
3. Run `npm run migrate`.
4. Run `npm run dev`.

The local subjects are `demo` (creator), `reader` (recipient), and `outsider` (another tenant), each with proof `local-proof`. The projects feature registers `public.projects` and `public.project_invitations`; PostgreSQL resolves the local table names through the connection's `search_path`.

## Project invitations

1. Sign in through `POST /api/session`. Mutations need the session cookie, trusted origin, and matching CSRF cookie/header.
2. As `demo`, create a project through `POST /api/projects` with `{ "id": "project_one", "name": "Example" }`.
3. Send `POST /api/projects/invitations` with `{ "projectId": "project_one", "email": "reader@example.test" }`. The server checks tenant and `project.create` permission, normalizes the email, and saves the invitation and outbox record in one transaction. Repeats return the same invitation without another message; expired pending invitations return 409.
4. The worker delivers to the local email adapter. Tests read its `messages`; this example sends no external email and has no invitation screen.
5. As `reader`, send `POST /api/projects/invitations/accept` with the delivered `{ "token": "..." }` before its 24-hour expiry. Acceptance requires the same tenant and recipient email. Repeats by the accepting actor return the saved success, even after expiry. No membership system is included.

`src/features/projects/invitations.ts` owns the contracts and actions. `src/infra/http.ts` shares trusted session and transaction setup across project mutations. Worker bindings come from registered consumers. `events.ts` retains the v1 parser and v1-to-v2 upgrade so the current worker can execute old queued invitations without rewriting their stored payloads.

Run `npm run check` for architecture, TypeScript, and tests. Set an isolated, non-superuser `TEST_DATABASE_URL` to run all database cases; otherwise they skip. `test/invitations.test.ts` covers authorization, tenant isolation, expiry, concurrent repeats, rollback, duplicate effects, and old queued work.

Durable jobs and schedules remain experimental. This example demonstrates local at-least-once handling, not production readiness or exactly-once behavior. Keep the migration search path stable and do not drop schemas while Kysely runs migrations; its catalog inspection can race with schema deletion.

## Before production

Replace the `localIdentityAdapter`, `localSessionAdapter`, and `localEmailAdapter` values in `src/infra/runtime.ts` with production-suitable provider instances of the same core contracts. The full-stack lifecycle rejects every local-only adapter before a production entrypoint starts. Local state also resets when the process stops.
