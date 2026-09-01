# Full-stack TypeScript on Rails application

## Start locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Run `npm install`.
3. Run `npm run migrate`.
4. Run `npm run dev`.

The local sign-in is `demo` with proof `local-proof`.

## Before production

Replace the `localIdentityAdapter`, `localSessionAdapter`, and `localEmailAdapter` values in `src/infra/runtime.ts` with durable provider adapters. Local identity rejects production authentication. Local sessions and email live only in one process and reset on restart.
