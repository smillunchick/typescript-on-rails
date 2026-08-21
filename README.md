# typescript-on-rails

An agent-native TypeScript application architecture kernel and compiler with runtime contract primitives. It keeps application code organized by feature and makes architectural boundaries explicit.

## Current scope

The package provides:

- static architecture analysis;
- strict TypeScript conventions;
- feature-oriented application structure and generators;
- manifest v2, semantic diff, and introspection;
- synchronous schema, operation, route, event, model, and adapter primitives.

It does not provide HTTP serving, rendered UI, persistence or storage, or bundling. Applications own those runtime layers and their development, build, and test scripts. No-emit TypeScript checks are not application builds.

The analyzer reads TypeScript source through the compiler API. It does not import or execute application modules.

## Install

```sh
npm install typescript-on-rails
```

Use TypeScript `5.9.3`, the version supported by the architecture compiler.

## Quick start

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

Unknown packages fail with a sorted inventory and a non-writing starter map. The starter values require an owner decision; the compiler never chooses package effects.

Type-only imports do not create runtime package uses. Exact subpath policy overrides a package-root policy. Node built-ins use framework-owned classifications.

## Schemas

The runtime uses one validator-neutral, synchronous schema protocol. Built-in and adapted schemas pass through the same normalization and validation boundary.

Use `adaptSchema` for an external parser that supplies complete canonical metadata and maps vendor failures to safe framework issue codes. Parsers must be synchronous and side-effect-free. The package does not claim compatibility with a named validator ecosystem.

## Role-aware dynamic imports

Literal `import()` calls are allowed in UI/client and infrastructure code. The compiler resolves them and applies the same feature, runtime, package, dependency, and cycle checks as static imports.

Domain and application code cannot use literal dynamic imports. Computed imports and `require()` remain forbidden. Unsafe typing rules do not change by source role.

## Commands

Generated applications expose working kernel commands:

```sh
app check
npm run typecheck
```

`app dev`, `app build`, and `app test` only delegate to app-owned `dev:app`, `build:app`, and `test:app` scripts. The kernel does not invent those lifecycles.

Use the other architecture views as needed:

```sh
app explain sid1/route/feature/billing/invoiceRoute --json
app graph --json
app owners --json
app impact sid1/public-export/feature/billing/approveInvoice --json
app diff --architecture --base HEAD
```

## Migration and reference application

- [Migrate to architecture manifest v2](MIGRATION.md)
- [Reference SaaS architecture](examples/reference-saas/README.md)

The reference application demonstrates stable IDs, inferred versus declared contracts, package policy, routes, events, adapters, permissions, and domain tests. Its UI module is a view model; it is not rendered frontend support.
