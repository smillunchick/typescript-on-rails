# @typescript-on-rails/fullstack

Framework-owned application lifecycle, validated configuration, opaque secret references, runtime-redacted observability, deterministic local adapters, and semantic agent tools. This is a pre-stable modular runtime; local lifecycle and reference checks do not prove production operations or deployment readiness.

Applications export `fullstack.config.mjs` with a `LifecycleRegistry`. Use `applicationLifecyclePlugin` from `@typescript-on-rails/fullstack/application-lifecycle` to run the exact entrypoints registered in `src/app.ts`. Development entrypoints run concurrently and share one cancellation signal. Provider choice and credentials stay in the application.

`semanticBrief`, `testsFor`, and `unknowns` are compatibility views over the core canonical projection. They do not keep a second selector or graph traversal.

Official email, storage, payments, identity, session, and cache adapters implement the core contracts and validate every operation input and output. Local factories return the exact registered instance plus compatibility methods. They carry `suitability: "local-only"`; `applicationLifecyclePlugin` refuses them before a production entrypoint starts. Replace them with a production-suitable implementation rather than bypassing the check.
