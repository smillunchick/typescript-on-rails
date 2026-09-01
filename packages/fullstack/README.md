# @typescript-on-rails/fullstack

Framework-owned application lifecycle, validated configuration, opaque secret references, runtime-redacted observability, deterministic local adapters, and semantic agent tools.

Applications export `fullstack.config.mjs` with a `LifecycleRegistry`. Use `applicationLifecyclePlugin` from `@typescript-on-rails/fullstack/application-lifecycle` to run the exact entrypoints registered in `src/app.ts`. Development entrypoints run concurrently and share one cancellation signal. Provider choice and credentials stay in the application.
