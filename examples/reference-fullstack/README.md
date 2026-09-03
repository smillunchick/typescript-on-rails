# Full-stack reference application

This application demonstrates the official TypeScript on Rails stack locally without production credentials:

- Next and React server rendering plus client interaction;
- contract-backed local-only identity, session, and email adapters that the lifecycle rejects in production;
- bounded HTTP input, authorization, trusted-origin and CSRF checks;
- one bound request that writes PostgreSQL state and a transactional outbox record in the same tenant-scoped transaction;
- a registered projects repository that owns the logical `public.projects` relation without claiming SQL inference;
- PostgreSQL worker and scheduler entrypoints that execute the consumers registered in the application graph;
- framework-owned lifecycle commands; and
- executable composition and Manifest v3 completeness.

Run `npm run check` without a database. Set a local `TEST_DATABASE_URL` to include the PostgreSQL integration case. Set a local `DATABASE_URL` before `npm run migrate`, `npm run seed`, `npm run worker`, or `npm run scheduler`.

Durable jobs and schedules remain experimental. This example demonstrates local at-least-once handling; it does not show production readiness or exactly-once behavior.

Set `DATABASE_URL` before `npm run dev`. The command supervises Next, the registered PostgreSQL worker, and the registered scheduler together and stops the group cleanly. Next listens on `https://localhost:3420` with a generated development certificate so Secure `__Host-` cookies exercise the real browser contract. The synthetic credentials are `demo` and `local-proof`; they are fixtures, not production identity.
