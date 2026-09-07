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
- `@typescript-on-rails/jobs` — experimental durable events, outbox, jobs, retries, leases, quarantine, replay, schedules, and reconciliation;
- `@typescript-on-rails/fullstack` — lifecycle, configuration, secrets, observability, contract-backed local-only adapters, and semantic briefs; and
- `@typescript-on-rails/testing` — operation, HTTP, PostgreSQL, job, and browser harnesses.

The core does not import Next, React, PostgreSQL, or Kysely. Applications install only the official runtime packages they use. Official package metadata feeds one capability catalog for Manifest v2 policy and Manifest v3 provenance, so generated apps keep only an empty override map instead of two copied ledgers. Manifest v2 analysis reads TypeScript source through the compiler API and does not import or execute application modules. In a full-stack app, the Manifest v3 CLI explicitly loads `src/app.ts` through the official TypeScript loader. Its completeness result now requires source provenance, route-to-operation links, web bindings, durable-consumer worker bindings, and non-placeholder entrypoints.

## Maturity

Version 0.1 is a pre-stable local development candidate, not a production-readiness claim. The core kernel owns authoring, validation, and architecture views. The official web, PostgreSQL, full-stack, jobs, and testing packages are optional modular runtimes rather than hidden core behavior.

The included identity, session, email, storage, payments, and cache adapters are deterministic local substitutes. They carry `suitability: "local-only"`, and production startup rejects them. The jobs package remains experimental and provides at-least-once work with explicit retry, quarantine, replay, and effect fencing; it does not promise exactly-once delivery.

The neutral scaffold, projects example, and reference app pass local Node 22 and isolated PostgreSQL checks. They do not prove production identity, provider, cloud, migration, operating, recovery, security-review, or launch quality. The first corrected-baseline Bandwidth handoff was inconclusive because the frozen app did not pass complete Manifest v3 and no valid comparable benchmark pair existed. It supports no context-benefit or stronger maturity claim.

## Agent-effort evidence

A paired local experiment started both fresh workers at `c13afb042686bfa826e52746175dc026b4aea30b`. Both had the same task, source tools, permissions, supplied relationship map, and 30-minute limit: change new invitations from 24 to 48 hours while preserving authorization, transactions, and duplicate handling. One worker could also use architecture views. Runtime records identify both as `openai-codex/gpt-6-astra:high`, with one successful model attempt each.

Both made the direct repository change and updated reference/template tests and docs, without framework or dependency edits. Independent HTTP/PostgreSQL runs passed all seven invitation tests in each arm, with no skips: exact 48-hour expiry, first acceptance at 47 hours, rejection at 48 hours, tenant/recipient checks, atomic outbox writes, and duplicate effects. The views arm kept accepted-request replay at 48 hours rather than moving it strictly past the new deadline; that reduces the existing beyond-expiry test coverage, though the replay code did not change. Neither experiment was integrated; this candidate still uses 24 hours.

| Recorded worker measure | Source only | Source plus views |
| --- | ---: | ---: |
| Input / output tokens | 50,607 / 7,285 | 53,690 / 8,234 |
| Cache-read tokens; cache-write tokens | 489,600; 0 | 454,528; 0 |
| Reported model cost | $1.359920 | $1.403128 |
| Turns | 17 | 14 |
| Managed start-to-handoff elapsed time | 624.247 s | 548.514 s |

These counters cover the worker runs, including setup, checks, and reporting—not parent setup, independent review, or total engineering cost. Both used one intentional failing-then-passing test cycle, with no implementation repairs or human intervention during the run. Views found useful registered relationships but did not expose the expiry calculation; the brief stayed unchanged. No analyzer false positives were observed. The views worker's `--help` probe printed usage but exited 2; the source worker's production build reported an unchanged dynamic-filesystem tracing warning.

**Productivity remains unproven.** This is one small pair, not a framework-versus-conventional comparison. Node versions differed (22.23.2 source, 25.9.0 views), and the source worker ran the full repository check while the views worker ran app gates, core/parity tests, and template typechecks. Both met the requested app checks, but elapsed time and cost are not controlled comparisons. The source worker's raw logs under `node_modules` did not survive the managed handoff; its transcript retains command results and test totals. Independent verification used Node 22.23.2 for both, which does not remove differences in the original runs.

To test broader effort reproducibly:

1. Freeze this framework app and a conventional TypeScript app with the same HTTP, PostgreSQL, authorization, outbox, and worker behavior. Use the same dependency versions and external acceptance tests; include initial setup and later maintenance in the measured work.
2. Before launch, publish the task set, number of repetitions, scoring rules, and stopping budget. Include expiry, authorization, queued-event upgrade, and a new feature. Keep failed and incomplete runs in the results.
3. Use fresh workers with the same model, effort, permissions, runtime versions, starting information, and required checks. Give each an independent install and disposable non-superuser database. Randomize assignments; separate the views-versus-source question from the framework-versus-conventional question.
4. Have reviewers who do not know the condition grade behavior, safety, retained tests, and total application complexity. Record setup, implementation, test repairs, review repairs, human interventions, analyzer errors, tokens, cost, and elapsed time through acceptance. Save patches and logs outside disposable dependency directories; report missing counters as unknown.

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

The generated app is a neutral Next application with one registered status feature, an operation-backed HTTP route, lifecycle configuration, and an executable-graph test. It performs no database, identity, or external-service work until you add those modules.

Use `app new demo --example projects` for the guided PostgreSQL, transactional outbox, worker, and scheduler example. Use `app new my-kernel --core` only when you want the minimal compiler-only scaffold.

Define schemas and executable domain operations with explicit access rules. Generators require the access choice instead of making new operations public by default:

```sh
app create feature billing
app create model Invoice --feature billing
app create action approveInvoice --feature billing --permission invoice.approve
app create query pricing --feature billing --public
```


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

Briefs, traces, test views, unknowns, and check results use the same canonical selector and SHA-256 projection envelope. A simple name that matches more than one owner fails with exact candidates. Trace `links` contain only verified graph links; bounded source observations appear separately under `lexicalObservations`. These observations follow ordinary context destructuring and `const` aliases, respect local names that hide outer names, and do not prove that a call runs.

Manifest v3 matches registration sources by framework symbol, owner, and name. Import aliases and re-exports work; unrelated same-name factories do not count. Missing or competing sources remain `unknown`. Next host checks include explicit `HEAD` and `OPTIONS` exports, but do not require separate registrations for Next's automatic methods. Checks follow root `app/` before `src/app/`, route groups, parallel slots, dynamic segments, and required catch-all segments. Optional catch-all paths, intercepted paths, and unresolved exports remain `unknown` rather than receiving a guessed path or handler. The core does not load Next to make these checks.

## Migration and reference application

- [Migrate to architecture manifest v2](MIGRATION.md)
- [Reference SaaS architecture](examples/reference-saas/README.md)
- [Full-stack reference application](examples/reference-fullstack/README.md)

The compiler-only reference preserves the minimal core example. The full-stack reference proves the Next production build, server rendering, client interaction, sessions, registered lifecycle entrypoints, compact agent views, architecture checks, and Manifest v3 completeness without production credentials. With an isolated `TEST_DATABASE_URL`, its project-invitation tests cross real HTTP, operations, tenant-scoped PostgreSQL, outbox dispatch, and worker execution. They check atomic writes, authorized acceptance, expiry, concurrent repeats, duplicate effects, and an old v1 queued invitation processed by the current v2 worker. The [reference authoring guide](examples/reference-fullstack/README.md#authoring-through-public-conventions) shows which definitions drive runtime bindings and which business decisions stay explicit. These local behavior checks are not an independent agent experiment or a production-readiness claim.
