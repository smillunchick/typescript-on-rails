# @typescript-on-rails/fullstack

Framework-owned application lifecycle, validated configuration, opaque secret references, safe observability contracts, deterministic local adapters, and semantic agent tools.

Applications export `fullstack.config.mjs` with a `LifecycleRegistry`. The root `app` command detects this package and runs `dev`, `build`, `test`, `check`, `migrate`, `worker`, `scheduler`, and `seed` through that registry. Provider choice and credentials stay in the application.
