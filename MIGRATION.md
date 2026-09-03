# Migrate architecture manifests

## Adopt Manifest v3 without changing v2

Manifest v3 is an additive executable-composition envelope. Manifest v2 remains byte- and semantic-compatible and stays available through `analyzeApplication`. Use `analyzeApplicationV3` when the application registers features, operations, routes, pages, permissions, events, consumers, adapters, process entry points, and test ownership with `defineApp`.

Manifest v3 embeds the unchanged v2 manifest as `base`, analyzes configured support workspaces, and reports declared, discovered-but-undeclared, outside-root, and unknown behavior. Linkage protocol 4 records identity-derived runtime links, adapter and repository dependencies, registered schedules, and static source provenance. A manifest is complete only when routes derive from registered operations and web bindings, durable consumers bind to the registered worker, entrypoints are executable, test files exist, and no discovered or unknown behavior remains. Use `migrateManifestV2` for an explicit conservative wrapper; it marks completeness false because v2 has no executable graph or linkage evidence.

One package capability catalog now derives both Manifest v2 enforcement and Manifest v3 description. Official package manifests declare their own and supported peer facts. The catalog resolves installed packages and npm lock entries only within the application Git root or authenticated npm-workspace root, merges legacy v1 and exact v2 application inputs, records `official`, `override`, `declared-v2`, or `migrated-v1` provenance, and rejects conflicting facts or version mismatches. Manifest v3 remains descriptive: runtime/effect facts never infer an enforcement capability, so every non-official v2 entry still needs an explicit `packageCapabilities` decision. If a version cannot be resolved, the catalog omits the unsafe v3 decision and reports an unknown observation. Unknown packages still need an explicit owner decision.

`diffArchitectureV3` compares the unchanged v2 semantic diff plus executable composition, completeness counts, and package-capability decisions.

Full-stack CLI commands load `src/app.ts` through `@typescript-on-rails/fullstack` before creating Manifest v3. Programmatic callers pass the `application` returned by `defineApp` to `analyzeApplicationV3`. Support workspaces and version-bound capability decisions can live in `package.json`:

```json
{
  "typescriptOnRails": {
    "packageCapabilities": {
      "vendor-audit": "external-system"
    },
    "architectureWorkspaces": [
      { "name": "contracts", "root": "packages/contracts" }
    ],
    "packageCapabilitiesV2": [
      {
        "version": 2,
        "package": "vendor-audit",
        "packageVersion": "1.2.3",
        "runtime": ["server"],
        "effects": ["network", "external-system"],
        "nondeterminism": ["external"]
      }
    ]
  }
}
```

Manifest v3 inherits application capability decisions into each configured support workspace. A workspace can override a package version through its own legacy package policy or through programmatic v3 options during a staged migration.

## Adopt canonical agent projection v2

`app brief`, `app trace`, `app tests-for`, `app unknowns`, and JSON `app check` receipts now use one canonical selector, projection version 2, and SHA-256 hash. Owner names select an owner group. Exact `rid1` IDs and `kind:owner/name` selectors choose one record. Ambiguous simple names fail with sorted candidates instead of merging owners.

Trace links contain verified executable-graph linkage only. Bounded context-member and event-name syntax observations remain unverified and appear under `lexicalObservations`. Full-stack and testing compatibility APIs delegate to this projection. Generated `npm run check` uses `app check --with-tests`; lifecycle `check` type-checks and the separate test stage runs once.

## Register adapter contracts and production suitability

Features now list the exact adapter contracts they require: `defineFeature({ adapters: [emailContract] })`. Applications register one exact instance per contract through `defineApp({ adapters: { email } })`. Missing, same-name-different-object, duplicate, invalid, and unused registrations fail before graph links are built. Shared instances may satisfy several features.

`implementAdapter` now requires `{ provider, suitability }`. Official local factories use the core contracts, retain their compatibility methods, and are marked `local-only`. The full-stack application lifecycle rejects a local-only instance before any production entrypoint runs. Manifest v3 linkage protocol 4 records `feature-adapter` links and exposes only contract name, operation names, provider, and suitability; it does not include credentials, local messages, or stored bytes. Manifest v2 remains unchanged.

## Register executable repository ownership

Define each repository with core `defineRepository({ name, feature, relations })` and register the exact object through `defineFeature({ repositories: [...] })`. Cross-feature public-port use registers the owner's exact repository under `repositoryAccess`. A direct relation exception belongs to the accessing feature and needs a non-empty reason plus an optional `YYYY-MM-DD` expiry. Repository, relation, public-access, and exception links then come from the executable graph.

`checkRelationOwnership` remains a deprecated migration-only view. Use `migrateRelationOwnership` for deterministic repository definitions and `relationOwnershipFromGraph` when a legacy caller still needs arrays. Do not merge manual owners with registered owners. The old `defineRepository.create` field moved to an application infrastructure factory.

Repository evidence is declaration-scoped. Manifest v3 states `sqlVerified: false`: it does not parse arbitrary SQL, prove a repository touches only declared relations, detect direct database access outside repositories, or prove that a logical relation prefix is a physical PostgreSQL schema. `resolveDeclaredRelationNames` only checks local-name resolution through the active `search_path`.

## Register schedules and migrate lexical observations

Use core `schedule({ name, feature, target, occurrences })` for feature-owned durable schedules. The target must be the exact durable consumer and event registered by the same feature. Bind that schedule object to the scheduler entrypoint with `scheduleRuntimeBinding`; Manifest v3 then records scheduler-to-schedule and schedule-to-consumer links. `runScheduler` still accepts generic string-job schedules as experimental unlinked behavior, contains failures per schedule or occurrence, accepts cancellation, bounds each schedule's occurrence batch, and returns structured counts. For a stable occurrence key, the first materialized `dueAt` wins; later wall-clock drift does not change idempotency.

Application graph protocol 2, Manifest v3 composition protocol 4, and linkage protocol 4 add schedules and their links. Agent projection protocol 2 replaces operation `calls`/`callsResolved` with `contextObservations` and `contextObservationResolution`. These are bounded lexical facts with explicit direct, alias-unresolved, computed-unresolved, nested-scope, source-resolution, and unknown runtime-reachability states. They never become verified graph links.

## Migrate to architecture manifest v2

Manifest v2 is a breaking semantic boundary. It replaces path-based, name-only records and opaque contract strings with stable semantic IDs, explicit package capabilities, and separate static and runtime contract facts.

There is no v1-to-v2 converter. Regenerate manifests from TypeScript source with the current analyzer.

## Migration checklist

1. Pin TypeScript to `5.9.3`.
2. Add `typescriptOnRails.packageCapabilities` to the root `package.json`.
3. Remove `AnalyzeApplicationOptions.allowedExternalPackages`.
4. Regenerate every stored manifest from source.
5. Update selectors to use semantic IDs, or unique legacy names.
6. Update JSON consumers for structured contract facets and typed selector results.
7. Adapt external schemas through `adaptSchema` when needed.
8. Rename no-emit build or development scripts as checks.
9. Choose your migration commit as the earliest supported architecture-diff base.

## Regenerate manifests from source

Do not compare, merge, or rewrite persisted manifest v1 JSON. Run the current analyzer against the application source instead:

```ts
import { analyzeApplication } from "typescript-on-rails";

const manifest = analyzeApplication(process.cwd());
```

A v1 value, a v1/v2 comparison, malformed v2 data, duplicate semantic IDs, or an unsupported compiler protocol fails with regeneration guidance.

For Git architecture diffs, first commit the manifest v2 migration and a valid package capability policy. Use that commit, or a later commit, as the earliest supported base:

```sh
app diff --architecture --base <your-v2-migration-commit>
```

An earlier base cannot supply the effective policy and semantic contract required for a valid comparison.

## Adopt semantic IDs

Every addressable record now uses this grammar:

```text
sid1/<category>/<owner-kind>/<owner-name>/<local-name>
```

Example:

```text
sid1/operation/feature/billing/approveInvoice
```

The ID does not depend on a file path, line number, declaration order, or implementation body. Owner or declaration renames are removal plus addition. Operation kind, route method, and route path are contract fields, not identity fields.

Use an exact semantic ID when a selector must remain stable. A legacy name or route path still works only when it has one candidate. Ambiguous selectors return a typed result with sorted candidate IDs; they never select the first match.

```ts
const result = inspector.explainRoute(
  "sid1/route/feature/billing/invoiceRoute",
);

if (result.status === "resolved") {
  console.log(result.value);
} else if (result.status === "ambiguous") {
  console.error(result.candidates.map((candidate) => candidate.id));
}
```

The selector statuses are `resolved`, `not-found`, and `ambiguous`.

## Read structured contracts

Opaque `contract` strings are gone. Operations and routes now have independent static and runtime facets:

```ts
operation.output.staticType
operation.output.runtimeSchema
```

A resolved static facet has `provenance: "inferred-typescript"` and a canonical TypeContract graph. It describes what TypeScript proves. It is not a runtime validator.

A resolved runtime facet has `provenance: "declared-schema"` and `validator: "declared"`. When no output schema exists, the runtime facet is:

```json
{
  "status": "not-declared",
  "validator": "not-declared"
}
```

Do not turn inferred TypeScript output into a runtime-validation claim. Handle `unresolved` facets as errors, not as `any`, `unknown`, or source-text contracts.

Manifest compiler metadata records the exact supported versions:

```json
{
  "manifestVersion": 2,
  "typescriptVersion": "5.9.3",
  "schemaProtocolVersion": "1",
  "canonicalSchemaVersion": "1",
  "typeContractVersion": 1
}
```

## Declare package capabilities

Every non-framework third-party runtime package needs an explicit capability in the root `package.json`:

```json
{
  "typescriptOnRails": {
    "packageCapabilities": {
      "date-fns": "pure",
      "react": "ui",
      "stripe": "external-system",
      "typescript": "host-io"
    }
  }
}
```

Capabilities are:

- `pure`: in-process code with no external capability; allowed in all source roles.
- `ui`: a UI/client runtime library; allowed only in UI/client code.
- `external-system`: a client for a system outside the application; allowed only in infrastructure.
- `host-io`: filesystem, process, network, VM, worker, or similar host access; allowed only in infrastructure.

An exact subpath entry overrides its package root. Node built-ins use framework-owned classifications and canonical `node:` identities. Type-only imports do not create runtime package uses.

When `AnalyzeApplicationOptions.packageCapabilities` is present, it replaces the file policy in full. An empty object is still a complete replacement. The file policy and options never merge.

Remove this v1 option:

```ts
// Remove this.
{ allowedExternalPackages: ["date-fns"] }
```

If packages are unclassified, `app check` returns one sorted inventory and a starter map. The starter contains `CHOOSE` values on purpose. Review each package and replace every placeholder with one valid capability. The compiler does not choose effects and does not write `package.json`.

## Migrate schema integrations

The runtime schema boundary is validator-neutral. Built-in schemas and adapted schemas use the same synchronous protocol.

Use `adaptSchema` for an external parser:

```ts
import { adaptSchema } from "typescript-on-rails";

const CustomerCode = adaptSchema({
  metadata: {
    kind: "extension",
    namespace: "example",
    name: "customer-code",
    version: "1",
    payload: { format: "customer-code" },
    underlying: { kind: "string" },
  },
  parse: (value) => typeof value === "string"
    ? { success: true, value }
    : { success: false, error: "invalid" },
  mapError: () => [{
    path: [],
    code: "invalid_type",
    expected: "customer code",
  }],
});
```

The parser must be synchronous and side-effect-free. A promise or thenable fails at the schema boundary. Canonical metadata must be complete and JSON-safe. Public validation issues must not include raw input, vendor messages, stacks, or error objects.

The exact legacy `{ metadata, parse }` shape remains supported. This release does not claim compatibility with any named validator ecosystem.

## Update source roles and dynamic imports

Literal `import()` is allowed only in UI/client and infrastructure code. It is analyzed like a static reference: feature boundaries, package capabilities, runtime boundaries, dependencies, and cycles still apply.

Domain and application code cannot use literal dynamic imports. Computed, concatenated, interpolated, variable, or missing specifiers fail in every role. `any`, unchecked assertions, non-null assertions, decorators, and `require()` remain restricted in every role.

Files with incompatible role signals fail and receive the strict combination of all signaled rules.

## Rename misleading scripts

A no-emit TypeScript check is not an application build. The kernel also does not provide a development server.

Use names such as:

```json
{
  "scripts": {
    "check": "app check",
    "check:types": "tsc -p tsconfig.json",
    "check:types:watch": "tsc -p tsconfig.json --watch",
    "test:app": "node --test"
  }
}
```

When `@typescript-on-rails/fullstack` is installed, `app dev`, `app build`, `app test`, and `app check` use its lifecycle registry; applications may add migrate, worker, scheduler, and seed commands when those runtimes exist. Core-only applications keep the legacy app-owned `dev:app`, `build:app`, and `test:app` delegation path. New scaffolds are neutral full-stack web applications by default. Use `app new <directory> --example projects` for the guided PostgreSQL and jobs example, or `app new <directory> --core` for the old minimal shape.

Generated actions and queries now require either `--public` or `--permission <permission>`. Feature, model, action, and query generation updates the canonical `defineFeature` and `defineApp` registrations. A customized registration shape receives a non-writing error and must be updated manually. If a handled failure cannot restore every journaled file, run `app recover` before another generator command.

Manifest v2 semantic IDs remain `sid1` and byte-compatible. Manifest v3 composition protocol 3 uses `rid1` runtime-record IDs and linkage protocol 2. Application construction now rejects distinct definitions with the same owner-qualified runtime identity, duplicate HTTP method and path pairs, duplicate entrypoint names across processes, and conflicting test-file owners. Feature tests belong in `defineFeature.tests`; named cross-feature suites use `defineApp({ tests: [{ suite, features, files }] })`.

## Verify the migration

Run:

```sh
npm run typecheck
npm test
npm run emit
app check
npm pack --dry-run
```

Then inspect representative manifest records and CLI JSON. Confirm that:

- every selected record has the expected `sid1` ID;
- duplicate names require exact IDs;
- inferred static output does not claim runtime validation;
- declared schemas report `validator: "declared"`;
- package policy and package uses are present and correct;
- architecture diff ignores source-only movement;
- the package includes this migration guide.

## Expand the experimental jobs schema

Apply `jobsExpandMigration` after the existing `jobsMigration`. Do not edit or rerun the old migration.

The new writer stores both the legacy event name and the exact `rid1/event/<feature>/<event>` ID. It also stores the schema version, occurrence time, request and correlation IDs, optional causation ID, and optional tenant and actor IDs. Do not add credentials, permission results, or free-form context to the envelope.

Before `jobsExpandMigration`, the database is in the conceptual `Legacy` stage and has no migration-state row. Applying the expand migration creates the `Expanded` row. Move that stored state only through:

1. `Expanded`
2. `Dual-write`
3. `Reconciling`
4. `Cutover`

Reconciliation uses the current application graph. It resolves a legacy name only when that name has one exact event ID. It quarantines unknown and ambiguous names without changing their payloads. The first reconciliation step pins the canonical graph hash; a changed graph must not continue the same reconciliation. Cutover refuses any legacy row without classification evidence.

Before cutover, start exact-capable workers and call `assertOutboxCapability("exact")`. A rollback restriction blocks name-only workers after cutover or as soon as two exact IDs use one legacy display name. Replay needs a bounded request ID, approver, reason, and valid request time. It keeps the original row and history, carries successful target receipts forward, and retries failed targets under a new generation. History stays append-only; read it in bounded pages with `outboxHistory(id, { limit, beforeSequence })`. The expand migration has no destructive `down` step.

The jobs APIs in this release are experimental. Outbox delivery and external effects remain at least once. Use business-write deduplication, provider idempotency, and fenced effect receipts where needed.
