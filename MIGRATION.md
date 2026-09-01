# Migrate architecture manifests

## Adopt Manifest v3 without changing v2

Manifest v3 is an additive executable-composition envelope. Manifest v2 remains byte- and semantic-compatible and stays available through `analyzeApplication`. Use `analyzeApplicationV3` when the application registers features, operations, routes, pages, permissions, events, consumers, adapters, process entry points, and test ownership with `defineApp`.

Manifest v3 embeds the unchanged v2 manifest as `base`, analyzes configured support workspaces, and reports declared, discovered-but-undeclared, outside-root, and unknown behavior. Composition protocol v2 also records identity-derived runtime links and static source provenance. A manifest is complete only when routes derive from registered operations and web bindings, durable consumers bind to the registered worker, entrypoints are executable, test files exist, and no discovered or unknown behavior remains. Use `migrateManifestV2` for an explicit conservative wrapper; it marks completeness false because v2 has no executable graph or linkage evidence.

Package capability v2 separates runtime location, effects, and nondeterminism and binds decisions to exact installed package versions. The manifest labels records `declared-v2` or `migrated-v1` and reports the effect model as descriptive. Automatic v1 migration resolves package metadata from each workspace and uses the active Node version for built-in modules, but its effects are conservative upper bounds rather than owner decisions. If a version cannot be resolved, Manifest v3 omits the unsafe decision and reports an unknown `package-version` observation. Programmatic `migratePackageCapabilityV1` calls must supply the exact version. Keep the legacy package map for enforced source-role rules and declare v2 records when planning needs exact effects such as `database`.

`diffArchitectureV3` compares the unchanged v2 semantic diff plus executable composition, completeness counts, and package-capability decisions.

Full-stack CLI commands load `src/app.ts` through `@typescript-on-rails/fullstack` before creating Manifest v3. Programmatic callers pass the `application` returned by `defineApp` to `analyzeApplicationV3`. Support workspaces and version-bound capability decisions can live in `package.json`:

```json
{
  "typescriptOnRails": {
    "architectureWorkspaces": [
      { "name": "contracts", "root": "packages/contracts" }
    ],
    "packageCapabilitiesV2": [
      {
        "version": 2,
        "package": "pg",
        "packageVersion": "8.22.0",
        "runtime": ["server"],
        "effects": ["database", "network"],
        "nondeterminism": ["external"]
      }
    ]
  }
}
```

Manifest v3 inherits application capability decisions into each configured support workspace. A workspace can override a package version through its own legacy package policy or through programmatic v3 options during a staged migration.

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

When `@typescript-on-rails/fullstack` is installed, `app dev`, `app build`, `app test`, `app check`, `app migrate`, `app worker`, `app scheduler`, and `app seed` use its lifecycle registry. `app dev` runs registered web, worker, and scheduler entrypoints concurrently. Core-only applications keep the legacy app-owned `dev:app`, `build:app`, and `test:app` delegation path. New scaffolds are full-stack by default; use `app new <directory> --core` for the old minimal shape.

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
