# Full-stack reference application

This application demonstrates the official TypeScript on Rails stack locally without production credentials:

- Next and React server rendering plus client interaction;
- contract-backed local-only identity, session, and email adapters that the lifecycle rejects in production;
- bounded HTTP input, authorization, trusted-origin and CSRF checks;
- project creation and invitations that save PostgreSQL state and an outbox record in the same tenant-scoped transaction;
- registered repositories that own `public.projects` and `public.project_invitations` without claiming SQL inference;
- PostgreSQL worker and scheduler entrypoints that execute the consumers registered in the application graph;
- framework-owned lifecycle commands; and
- executable composition and Manifest v3 completeness.

Run `npm run check` without a database. Set a local `TEST_DATABASE_URL` to include the PostgreSQL integration case. Set a local `DATABASE_URL` before `npm run migrate`, `npm run seed`, `npm run worker`, or `npm run scheduler`.

Durable jobs and schedules remain experimental. This example demonstrates local at-least-once handling; it does not show production readiness or exactly-once behavior. Identity, sessions, and delivered email live in process memory. They do not survive restart or form a shared production service. No invitation screen, real email provider, membership system, or production authentication is included.

Set `DATABASE_URL` before `npm run dev`. The command supervises Next, the registered PostgreSQL worker, and the registered scheduler together and stops the group cleanly. Next listens on `https://localhost:3420` with a generated development certificate so Secure `__Host-` cookies exercise the real browser contract. The synthetic subjects are `demo` (creator), `reader` (recipient), and `outsider` (another tenant); each uses `local-proof`. They are fixtures, not production identity.

## Project invitations

1. Sign in through `POST /api/session`. Project mutations require the issued session cookie, trusted origin, and matching CSRF cookie/header. The server resolves tenant, email, and permissions from the session actor; request fields cannot grant authority.
2. Create a project through `POST /api/projects` with `{ "id": "project_one", "name": "Example" }`.
3. As `demo`, send `POST /api/projects/invitations` with `{ "projectId": "project_one", "email": "reader@example.test" }`. `project.create` permits creation only for a project visible in the current tenant. The response contains invitation ID, project ID, normalized email, expiry, and status, but not the token. Concurrent repeats return the same invitation without another outbox record. An expired pending invitation returns HTTP 409, not a false fresh-send result; this example has no resend flow.
4. The registered worker upgrades and validates the event, reloads creator authority from the historical actor and tenant IDs, and sends a deterministic message through the existing local email adapter. The token appears only in stored invitation/event payloads and the intended local message, not general diagnostics. Tests inspect the adapter's `messages`; there is no external mail delivery.
5. As `reader`, send `POST /api/projects/invitations/accept` with the delivered `{ "token": "..." }` before its 24-hour expiry. The first acceptance requires the same tenant and matching recipient email. It records actor and time under a row lock. Repeating acceptance as that actor returns the recorded success, even after expiry. Unknown or cross-tenant tokens return 404; wrong recipients return 403; expired pending invitations return 409.

The invitation row and outbox write commit together or both roll back. One database constraint enforces a single invitation per tenant/project/email. The worker uses the invitation ID for both the durable effect receipt and local email idempotency key, so retries and duplicate occurrences do not create another local message or suppress a different invitation. An uncertain effect after a crash still needs reconciliation; this example does not provide a production recovery operator.

## Authoring through public conventions

- `src/features/projects/invitations.ts` defines the model, repository contract, actions, and route contracts. `object(ProjectInvitation.fields)` derives the output schema instead of copying fields. Register executable definitions in the feature's `index.ts`.
- `src/infra/invitation-repository.ts` implements the contract with the request's transaction. `src/infra/http.ts` binds all three project mutations through one authenticated transaction scope and one feature context type. A new mutation still needs an explicit operation and HTTP binding; it does not need another session/tenant/outbox setup.
- `Object.values(httpBindings)` supplies the web entrypoint bindings. `src/infra/next-routes.ts` reads method and path from route definitions rather than repeating those strings. Next's small `route.ts` files remain explicit host exports; the architecture check verifies their coverage.
- `createConsumerRuntime` derives worker handlers and bindings from registered consumers. `app create action <name> --feature projects --permission <permission>` already writes the ordinary action, feature registration, and app registration with collision checks and rollback. Business rules, repository code, and HTTP policy remain explicit; there is no invitation-specific generator or new framework abstraction.

## Event compatibility and proof

`ProjectInvitationCreated` version 2 replaces v1's flat `email`, `token`, and `expiresAt` fields with required `recipient` and `acceptance` objects. Keep the v1 payload parser and adjacent upgrade in `events.ts` while old records or queued jobs remain. Register only the current event definition, preserving its owner/name ID; historical schemas are parsers, not competing event registrations. The worker applies the upgrade to a temporary execution payload and retains the original envelope, materialized job, and delivery receipt.

`test/invitations.test.ts` exercises real HTTP, operations, PostgreSQL, outbox dispatch, and worker execution. It covers concurrent repeats, permissions and tenant isolation, acceptance and expiry, transaction rollback, duplicate delivery, distinct invitation effects, and a v1 HTTP-created job executed by the v2 worker. `npm run check:architecture` also verifies the app graph, host routes, and TypeScript. Without `TEST_DATABASE_URL`, database cases skip rather than claim a pass.

Storage dependency ranges are `pg ^8.22.0` and `kysely ^0.29.4`. Local checks cover endpoint pairs pg 8.22.0/Kysely 0.29.4 and pg 8.23.0/Kysely 0.29.5 on Node 22.23.2 and PostgreSQL 17.9. The lockfile selects the latter pair. This is not proof of every future compatible release. TypeScript 5.9.3 and Next 16.3.3 remain the tested compiler and host; their compatibility claims have not expanded. See the PostgreSQL package's [migration limits](../../packages/postgres/README.md) before changing schema search paths or dropping schemas during migration.
