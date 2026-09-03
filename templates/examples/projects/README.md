# Full-stack TypeScript on Rails application

## Start locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Run `npm install`.
3. Run `npm run migrate`.
4. Run `npm run dev`.

The local sign-in is `demo` with proof `local-proof`. The projects feature registers the logical `public.projects` relation; PostgreSQL verification resolves its local `projects` name through the test or application `search_path`.

Durable jobs and schedules remain experimental. This example demonstrates local at-least-once handling; it does not show production readiness or exactly-once behavior.

## Before production

Replace the `localIdentityAdapter`, `localSessionAdapter`, and `localEmailAdapter` values in `src/infra/runtime.ts` with production-suitable provider instances of the same core contracts. The full-stack lifecycle rejects every local-only adapter before a production entrypoint starts. Local state also resets when the process stops.
