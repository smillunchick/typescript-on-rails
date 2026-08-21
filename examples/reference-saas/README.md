# Reference SaaS architecture

This application demonstrates the shipped architecture kernel and runtime contract primitives. It is a compiler and domain example, not a deployable full-stack service.

The example does not include HTTP serving, rendered UI, persistence, storage, or bundling. `src/features/billing/ui/invoice-page.ts` returns a typed view model. It does not render a page.

## What the example proves

The application is organized into three feature owners:

- `billing`: invoice data, operations, route contract, event, payment port, and view model;
- `identity`: authenticated user context and user query;
- `reports`: a revenue query that depends on billing through its public boundary.

Infrastructure implements the billing payment contract in `src/infra/payments`.

The architecture manifest proves these distinctions:

| Record | Semantic ID | Static output | Runtime output validator |
|---|---|---|---|
| Approve invoice | `sid1/operation/feature/billing/approveInvoice` | Inferred `InvoiceApproval` object | Not declared |
| Pay invoice | `sid1/operation/feature/billing/payInvoice` | Inferred object | Declared schema |
| Invoice route | `sid1/route/feature/billing/invoiceRoute` | Inferred invoice-or-null | Not declared |
| Invoice paid event | `sid1/event/feature/billing/InvoicePaid` | Not applicable | Declared payload schema |
| Payment contract | `sid1/adapter-contract/feature/billing/Payments` | Not applicable | Declared operation schemas |
| Payment implementation | `sid1/adapter-implementation/infra/_/payments` | Links to `Payments` | Contract-owned schemas |

The package policy is empty because application source imports no third-party runtime package other than `typescript-on-rails`, which is framework-exempt. Type-only Node references do not create runtime package uses.

## Run checks

Build the package first from the repository root so the reference CLI can use `dist/bin.js`:

```sh
npm run emit
npm --prefix examples/reference-saas run check
npm --prefix examples/reference-saas run test:app
```

Reference scripts use truthful names:

- `check:architecture`: run `app check` through the built CLI;
- `check:types`: run the no-emit TypeScript check;
- `check:types:watch`: watch the no-emit TypeScript check;
- `test:app`: run the domain tests;
- `check`: run architecture and type checks.

There is no `dev:app` or `build:app` script because this example has no development server or application build pipeline.

## Inspect semantic records

From `examples/reference-saas`, run:

```sh
node ../../dist/bin.js explain sid1/route/feature/billing/invoiceRoute --json
node ../../dist/bin.js impact sid1/public-export/feature/billing/approveInvoice --json
node ../../dist/bin.js graph --json
```

A unique legacy name or route path also works. Prefer exact semantic IDs in scripts and stored tooling. Ambiguous legacy selectors return sorted candidate IDs and never select the first match.

## Read contract facets correctly

`approveInvoice` has a resolved TypeScript output graph with the `InvoiceApproval` label. Its runtime output facet is `not-declared`, so the manifest makes no output-validation guarantee.

`payInvoice` has both a resolved TypeScript output graph and a declared runtime output schema. The two facets provide separate facts; neither replaces the other.

The event and adapter records publish canonical runtime schema metadata. The analyzer reads their TypeScript declarations and never imports or executes these modules.

## Domain promises

The tests verify that:

- invoice approval requires permission and uses the authenticated user;
- billing and identity data remain customer-scoped;
- routes enforce access before returning data;
- payment success emits `InvoicePaid`;
- event delivery attempts every subscriber;
- a declined payment emits no paid event;
- the invoice page function returns a view model with formatted totals.
