# typescript-on-rails

An agent-native, full-stack TypeScript framework for Node, Next and React, PostgreSQL and Kysely, and PostgreSQL-backed durable work. It keeps application code organized by feature and makes architectural boundaries explicit.

## Current scope

The small `typescript-on-rails` core provides:

- static architecture analysis and strict TypeScript conventions;
- feature-oriented application structure and generators;
- byte-compatible Manifest v2 plus executable-composition Manifest v3;
- semantic diff, completeness reporting, introspection, and agent views; and
- synchronous schema, operation, route, event, model, adapter, feature, page, consumer, and process primitives.

Official modular packages provide the full-stack runtime:

- `@typescript-on-rails/web` — host-neutral HTTP and maintained Next/React bindings;
- `@typescript-on-rails/postgres` — Kysely transactions, migrations, tenant context, ownership, seeds, and test databases;
- `@typescript-on-rails/jobs` — durable events, outbox, jobs, retries, leases, dead letters, schedules, and reconciliation;
- `@typescript-on-rails/fullstack` — lifecycle, configuration, secrets, observability, local adapters, and semantic briefs; and
- `@typescript-on-rails/testing` — operation, HTTP, PostgreSQL, job, and browser harnesses.

The core does not import Next, React, PostgreSQL, or Kysely. Applications install only the official runtime packages they use. Manifest v2 analysis reads TypeScript source through the compiler API and does not import or execute application modules. In a full-stack app, the Manifest v3 CLI explicitly loads `src/app.ts` through the official TypeScript loader. Its completeness result now requires source provenance, route-to-operation links, web bindings, durable-consumer worker bindings, and non-placeholder entrypoints.

## Install

```sh
npm install typescript-on-rails
```

Use TypeScript `5.9.3`, the version supported by the architecture compiler.

## Quick start

Create the full-stack application, install it, then run its framework check:

```sh
app new my-app
cd my-app
npm install
npm run check
```

The generated app includes Next, PostgreSQL migrations and row security, an atomic request and outbox path, registered workers and schedulers, lifecycle configuration, and tests. Copy `.env.example` to `.env` and set an isolated PostgreSQL URL before running database commands or the complete integration test.

Use `app new my-kernel --core` only when you want the minimal compiler-only scaffold.

Define schemas and executable domain operations with explicit access rules:

```ts
import { action, object, string } from "typescript-on-rails";

export const greet = action({
  input: object({ name: string() }),
  public: true,
  run: ({ name }) => `Hello, ${name}`,
});
```

Run the project health check with `app check` when using a generated application.

## Manifest v2

Manifest v2 gives each addressable record a stable semantic ID:

```text
sid1/operation/feature/billing/approveInvoice
```

IDs use the record category, semantic owner, and local name. They do not depend on file paths, line numbers, declaration order, or implementation bodies.

Operation and route contracts separate TypeScript facts from runtime validation:

```json
{
  "id": "sid1/operation/feature/billing/approveInvoice",
  "output": {
    "staticType": {
      "status": "resolved",
      "provenance": "inferred-typescript",
      "contract": {
        "version": 1,
        "root": "n0",
        "nodes": [
          {
            "id": "n0",
            "kind": "object",
            "properties": [
              { "name": "approvedBy", "type": "n1", "optional": false, "readonly": true },
              { "name": "invoiceId", "type": "n1", "optional": false, "readonly": true }
            ]
          },
          { "id": "n1", "kind": "primitive", "name": "string" }
        ]
      },
      "labels": ["InvoiceApproval"]
    },
    "runtimeSchema": {
      "status": "not-declared",
      "validator": "not-declared"
    }
  }
}
```

A resolved static facet describes what TypeScript proves. It does not claim runtime validation. A runtime facet reports `validator: "declared"` only when a schema exists.

Use exact semantic IDs for stable inspection. A legacy name or route path works only when unique. Ambiguous selectors return sorted candidate IDs instead of selecting the first match.

## Package capabilities

Declare each non-framework third-party runtime package in the root `package.json`:

```json
{
  "typescriptOnRails": {
    "packageCapabilities": {
      "date-fns": "pure",
      "react": "ui",
      "stripe": "external-system"
    }
  }
}
```

The capabilities are:

- `pure`: allowed in all source roles;
- `ui`: allowed only in UI/client code;
- `external-system`: allowed only in infrastructure;
- `host-io`: allowed only in infrastructure.

Unknown packages fail with a sorted inventory and a non-writing starter map. The starter values require an owner decision; the compiler never chooses package effects. Manifest v3 labels each v2 record `declared-v2` or `migrated-v1` and states that v2 effects are descriptive. Declare v2 records when an exact effect such as `database` matters to planning; legacy migration remains a conservative upper bound.

Type-only imports do not create runtime package uses. Exact subpath policy overrides a package-root policy. Node built-ins use framework-owned classifications.

## Schemas

The runtime uses one validator-neutral, synchronous schema protocol. Built-in and adapted schemas pass through the same normalization and validation boundary.

Use `adaptSchema` for an external parser that supplies complete canonical metadata and maps vendor failures to safe framework issue codes. Parsers must be synchronous and side-effect-free. The package does not claim compatibility with a named validator ecosystem.

## Role-aware dynamic imports

Literal `import()` calls are allowed in UI/client and infrastructure code. The compiler resolves them and applies the same feature, runtime, package, dependency, and cycle checks as static imports.

Domain and application code cannot use literal dynamic imports. Computed imports and `require()` remain forbidden. Unsafe typing rules do not change by source role.

## Commands

Generated full-stack applications expose framework-owned lifecycle commands through `@typescript-on-rails/fullstack` plugins:

```sh
app check
npm run typecheck
```

When the full-stack package is installed, `app dev`, `app build`, `app test`, `app migrate`, `app worker`, `app scheduler`, and `app seed` run its lifecycle registry. `app dev` supervises registered web, worker, and scheduler entrypoints concurrently and stops sibling processes when one fails. Legacy app-owned script delegation remains compatible for core-only applications.

Use the other architecture views as needed:

```sh
app explain sid1/route/feature/billing/invoiceRoute --json
app graph --json
app owners --json
app impact sid1/public-export/feature/billing/approveInvoice --json
app diff --architecture --base HEAD
app manifest --v3 --json
app brief billing --json
app trace approveInvoice --json
app tests-for billing --json
app unknowns --json
```

## Migration and reference application

- [Migrate to architecture manifest v2](MIGRATION.md)
- [Reference SaaS architecture](examples/reference-saas/README.md)
- [Full-stack reference application](examples/reference-fullstack/README.md)

The compiler-only reference preserves the minimal core example. The full-stack reference proves the Next production build, server rendering, client interaction, sessions, registered lifecycle entrypoints, compact agent views, architecture checks, and Manifest v3 completeness without production credentials. When `TEST_DATABASE_URL` points to an isolated database, one bound request writes the project and outbox atomically, dispatches the outbox to the registered consumer, and processes that job once.
