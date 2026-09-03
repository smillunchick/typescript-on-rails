# @typescript-on-rails/postgres

The official pre-stable PostgreSQL and Kysely runtime. It supplies migrations, typed transaction scopes, tenant/request context, optional row-security hooks, relation ownership migration helpers, deterministic seeds, fixtures, and isolated test schemas. It is not an ORM, and its isolated local database proof is not production migration or operating approval.

Define repository ownership with the core `defineRepository`, then register the exact definition under its feature. The application graph is authoritative; `checkRelationOwnership` accepts legacy arrays only as migration input. `resolveDeclaredRelationNames` checks that each logical relation's local name resolves through the active PostgreSQL `search_path`. The framework does not parse SQL, prove which relations arbitrary SQL touches, or claim that a logical schema prefix is a physical schema.
