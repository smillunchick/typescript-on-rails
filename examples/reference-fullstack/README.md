# Full-stack reference application

This application proves the official TypeScript on Rails stack without production credentials:

- Next and React server rendering plus client interaction;
- a local identity and secure session boundary;
- bounded HTTP input, authorization, trusted-origin and CSRF checks;
- one bound request that writes PostgreSQL state and a transactional outbox record in the same tenant-scoped transaction;
- PostgreSQL worker and scheduler entrypoints that execute the consumers registered in the application graph;
- framework-owned lifecycle commands; and
- executable composition and Manifest v3 completeness.

Run `npm run check` without a database. Set a local `TEST_DATABASE_URL` to include the PostgreSQL integration case. Set a local `DATABASE_URL` before `npm run migrate`, `npm run seed`, `npm run worker`, or `npm run scheduler`.

Set `DATABASE_URL` before `npm run dev`. The command supervises Next, the registered PostgreSQL worker, and the registered scheduler together and stops the group cleanly. Next listens on `https://localhost:3420` with a generated development certificate so Secure `__Host-` cookies exercise the real browser contract. The synthetic credentials are `demo` and `local-proof`; they are fixtures, not production identity.
