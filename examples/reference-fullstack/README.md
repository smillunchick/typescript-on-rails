# Full-stack reference application

This application proves the official TypeScript on Rails stack without production credentials:

- Next and React server rendering plus client interaction;
- a local identity and secure session boundary;
- bounded HTTP input, authorization, trusted-origin and CSRF checks;
- PostgreSQL/Kysely migrations, row security, a tenant-scoped transaction, and a transactional outbox when `TEST_DATABASE_URL` is configured;
- an in-memory durable job flow plus PostgreSQL worker and scheduler entry points;
- framework-owned lifecycle commands; and
- executable composition and Manifest v3 completeness.

Run `npm run check` without a database. Set a local `TEST_DATABASE_URL` to include the PostgreSQL integration case. Set a local `DATABASE_URL` before `npm run migrate`, `npm run seed`, `npm run worker`, or `npm run scheduler`.

`npm run dev` starts the local app on `https://localhost:3420` with a generated development certificate so Secure `__Host-` cookies exercise the real browser contract. The synthetic credentials are `demo` and `local-proof`; they are fixtures, not production identity.
