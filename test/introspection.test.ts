import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  diffArchitecture,
  encodeSemanticId,
  formatArchitectureDiff,
  graphAsDot,
  graphAsText,
  inspectApplication,
  inspectManifest,
  ManifestCompatibilityError,
  type ArchitectureManifest,
  type ManifestCompatibilityErrorCode,
  type SemanticIdCategory,
} from "../src/index.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const fixtures: AppFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function application() {
  const fixture = await createAppFixture({
    "src/features/billing/model.ts": `
import { defineModel, id } from "typescript-on-rails";
export const Invoice = defineModel({ name: "Invoice", fields: { id: id("Invoice") } });
`,
    "src/features/billing/actions.ts": `
import { action, object, route, string } from "typescript-on-rails";
export const approveInvoice = action({ input: object({ id: string() }), permission: "invoice.approve", run: ({ id }) => id });
export const invoiceRoute = route({ method: "GET", path: "/invoices/:id", input: object({ id: string() }), permission: "invoice.read", handler: ({ id }) => id });
`,
    "src/features/billing/index.ts": `export { Invoice } from "./model.js"; export { approveInvoice, invoiceRoute } from "./actions.js";`,
    "src/features/reports/index.ts": `import { approveInvoice } from "@/features/billing"; export const approveForReport = approveInvoice;`,
  });
  fixtures.push(fixture);
  return inspectApplication(fixture.root);
}

const resolvedStringSchema = {
  status: "resolved",
  provenance: "declared-schema",
  validator: "declared",
  metadata: { kind: "string" },
} as const;
const resolvedStatic = {
  status: "resolved",
  provenance: "inferred-typescript",
  contract: { version: 1, root: "n0", nodes: [{ id: "n0", kind: "primitive", name: "string" }] },
  labels: [],
} as const;
const notDeclared = { status: "not-declared", validator: "not-declared" } as const;
const declaredSlot = { staticType: resolvedStatic, runtimeSchema: resolvedStringSchema } as const;
const inferredSlot = { staticType: resolvedStatic, runtimeSchema: notDeclared } as const;

function record(category: SemanticIdCategory, name: string, feature = "billing") {
  const owner = { kind: "feature", name: feature } as const;
  return {
    id: encodeSemanticId({ category, owner, localName: name }),
    owner,
    name,
    feature,
  };
}

function manifest(overrides: Partial<ArchitectureManifest> = {}): ArchitectureManifest {
  return {
    version: 2,
    compiler: {
      manifestVersion: 2,
      typescriptVersion: "5.9.3",
      schemaProtocolVersion: "1",
      canonicalSchemaVersion: "1",
      typeContractVersion: 1,
    },
    packagePolicy: [],
    packageUses: [],
    features: [{ ...record("feature", "billing"), publicBoundary: "src/features/billing/index.ts", exports: [{ ...record("public-export", "approveInvoice"), kind: "value", file: "a.ts", line: 1 }], file: "a.ts", line: 1 }],
    models: [{ ...record("model", "Invoice"), fields: resolvedStringSchema, file: "model.ts", line: 1 }],
    operations: [{ ...record("operation", "approveInvoice"), kind: "action", input: declaredSlot, output: inferredSlot, access: "permission", permission: "invoice.approve", file: "actions.ts", line: 1 }],
    routes: [{ ...record("route", "invoiceRoute"), method: "GET", path: "/invoices/:id", input: declaredSlot, output: inferredSlot, access: "permission", permission: "invoice.read", file: "actions.ts", line: 2 }],
    events: [],
    adapters: [],
    permissions: ["invoice.approve", "invoice.read"],
    dependencies: [],
    exceptions: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("application introspection", () => {
  it("projects exact ownership, callers, explanations, and routes from the analyzer manifest", async () => {
    const inspector = await application();

    assert.deepEqual(inspector.features().map((entry) => entry.name), ["billing", "reports"]);
    assert.deepEqual(inspector.actions().map((entry) => entry.name), ["approveInvoice"]);
    const owner = inspector.findOwner("Invoice");
    assert.equal(owner.status, "resolved");
    if (owner.status === "resolved") assert.equal(owner.value.feature, "billing");
    const callers = inspector.findCallers("approveInvoice");
    assert.equal(callers.status, "resolved");
    if (callers.status === "resolved") assert.deepEqual(callers.value.map(({ feature, owner, symbol }) => ({ feature, owner, symbol })), [
      { feature: "reports", owner: "billing", symbol: "approveInvoice" },
    ]);
    assert.equal(inspector.findCallers("missing").status, "not-found");
    const route = inspector.explainRoute("/invoices/:id");
    assert.equal(route.status, "resolved");
    if (route.status === "resolved") {
      assert.equal(route.value.id, "sid1/route/feature/billing/invoiceRoute");
      assert.equal(route.value.displayName, "billing.invoiceRoute");
      assert.equal(route.value.permission, "invoice.read");
    }
    const feature = inspector.explainFeature("billing");
    assert.equal(feature.status, "resolved");
    if (feature.status === "resolved") {
      assert.equal(feature.value.name, "billing");
      assert.deepEqual(feature.value.models.map((entry) => entry.displayName), ["billing.Invoice"]);
      assert.deepEqual(feature.value.actions.map((entry) => entry.displayName), ["billing.approveInvoice"]);
      assert.deepEqual(feature.value.dependents.map((entry) => entry.displayName), ["reports"]);
      assert.deepEqual(feature.value.actions.map((entry) => entry.id), ["sid1/operation/feature/billing/approveInvoice"]);
    }
  });

  it("limits callers to imported symbols and expands namespace imports", async () => {
    const fixture = await createAppFixture({
      "src/features/billing/index.ts": `export const Invoice = true; export const approveInvoice = true;`,
      "src/features/named/index.ts": `import { approveInvoice } from "@/features/billing"; export const named = approveInvoice;`,
      "src/features/namespace/index.ts": `import * as billing from "@/features/billing"; export const allBilling = billing;`,
    });
    fixtures.push(fixture);
    const inspector = inspectApplication(fixture.root);

    assert.deepEqual(inspector.manifest.dependencies.map(({ from, symbols }) => ({ from, symbols })), [
      { from: "named", symbols: ["approveInvoice"] },
      { from: "namespace", symbols: ["*"] },
    ]);
    const invoiceCallers = inspector.findCallers("Invoice");
    assert.equal(invoiceCallers.status, "resolved");
    if (invoiceCallers.status === "resolved") assert.deepEqual(invoiceCallers.value.map(({ feature, owner, symbol }) => ({ feature, owner, symbol })), [
      { feature: "namespace", owner: "billing", symbol: "Invoice" },
    ]);
    const approveCallers = inspector.findCallers("approveInvoice");
    assert.equal(approveCallers.status, "resolved");
    if (approveCallers.status === "resolved") assert.deepEqual(approveCallers.value.map(({ feature, owner, symbol }) => ({ feature, owner, symbol })), [
      { feature: "named", owner: "billing", symbol: "approveInvoice" },
      { feature: "namespace", owner: "billing", symbol: "approveInvoice" },
    ]);
  });

  it("renders deterministic graph, owner, boundary, exception, and impact projections", () => {
    const source = manifest({
      features: [
        { ...record("feature", "billing"), publicBoundary: "src/features/billing/index.ts", exports: [{ ...record("public-export", "approveInvoice"), kind: "value", file: "a.ts", line: 1 }], file: "a.ts", line: 1 },
        { ...record("feature", "reports", "reports"), publicBoundary: "src/features/reports/index.ts", exports: [], file: "r.ts", line: 1 },
      ],
      dependencies: [{ from: "reports", to: "billing", symbols: ["approveInvoice"], file: "r.ts", line: 4 }],
      exceptions: [{ rule: "external-io", reason: "Migration", target: "legacy", valid: true, file: "a.ts", line: 3 }],
    });
    const inspector = inspectManifest(source);

    assert.equal(graphAsText(source), "billing\nreports -> billing\n");
    assert.equal(graphAsDot(source), "digraph architecture {\n  \"billing\";\n  \"reports\";\n  \"reports\" -> \"billing\";\n}\n");
    assert.deepEqual(inspector.owners(), [{ id: "sid1/model/feature/billing/Invoice", displayName: "billing.Invoice", model: "Invoice", feature: "billing" }]);
    assert.deepEqual(inspector.boundaries().map(({ id, displayName, exports }) => ({ id, displayName, exports })), [
      { id: "sid1/feature/feature/billing/billing", displayName: "billing", exports: [{ id: "sid1/public-export/feature/billing/approveInvoice", displayName: "billing.approveInvoice", name: "approveInvoice", kind: "value" }] },
      { id: "sid1/feature/feature/reports/reports", displayName: "reports", exports: [] },
    ]);
    assert.equal(inspector.exceptions()[0]?.reason, "Migration");
    const impact = inspector.impact("approveInvoice");
    assert.equal(impact.status, "resolved");
    if (impact.status === "resolved") {
      assert.equal(impact.value.id, "sid1/public-export/feature/billing/approveInvoice");
      assert.deepEqual(impact.value.callers, ["reports"]);
      assert.deepEqual(impact.value.callerIds, ["sid1/feature/feature/reports/reports"]);
    }
  });

  it("resolves exact IDs and unique legacy aliases, and reports every ambiguous category with sorted IDs", () => {
    const feature = (name: string, exports: ArchitectureManifest["features"][number]["exports"] = []) => ({
      ...record("feature", name, name), publicBoundary: `${name}.ts`, exports, file: `${name}.ts`, line: 1,
    });
    const exportOf = (name: string, owner: string) => ({ ...record("public-export", name, owner), kind: "value", file: `${owner}.ts`, line: 1 });
    const model = (name: string, owner: string) => ({ ...record("model", name, owner), fields: resolvedStringSchema, file: `${owner}.ts`, line: 1 });
    const operation = (name: string, owner: string) => ({ ...record("operation", name, owner), kind: "action" as const, input: declaredSlot, output: inferredSlot, access: "public" as const, file: `${owner}.ts`, line: 1 });
    const route = (name: string, owner: string, path: string) => ({ ...record("route", name, owner), method: "GET", path, input: declaredSlot, output: inferredSlot, access: "public" as const, file: `${owner}.ts`, line: 1 });
    const event = (name: string, owner: string) => ({ ...record("event", name, owner), payload: resolvedStringSchema, file: `${owner}.ts`, line: 1 });
    const contract = (name: string, owner: string) => ({ ...record("adapter-contract", name, owner), kind: "contract" as const, operations: { status: "resolved" as const, operations: {} }, file: `${owner}.ts`, line: 1 });
    const implementation = (name: string, owner: string) => ({ ...record("adapter-implementation", name, owner), kind: "implementation" as const, contractId: null, file: `${owner}.ts`, line: 1 });
    const source = manifest({
      features: [
        feature("alpha", [exportOf("sharedExport", "alpha")]),
        feature("beta", [exportOf("sharedExport", "beta")]),
        feature("shared"),
      ],
      models: [model("sharedModel", "alpha"), model("sharedModel", "beta"), model("uniqueModel", "alpha")],
      operations: [operation("sharedOperation", "alpha"), operation("sharedOperation", "beta")],
      routes: [route("shared", "alpha", "/same"), route("shared", "beta", "/same")],
      events: [event("sharedEvent", "alpha"), event("sharedEvent", "beta")],
      adapters: [contract("sharedContract", "alpha"), contract("sharedContract", "beta"), implementation("sharedImplementation", "alpha"), implementation("sharedImplementation", "beta")],
    });
    const inspector = inspectManifest(source);

    const unique = inspector.findOwner("uniqueModel");
    assert.equal(unique.status, "resolved");
    assert.equal(inspector.findOwner("sid1/model/feature/alpha/uniqueModel").status, "resolved");
    assert.equal(inspector.resolve("sid1/model/feature/missing/uniqueModel", ["model"]).status, "not-found");

    const ambiguous: Array<[string, Parameters<typeof inspector.resolve>[1]]> = [
      ["sharedOperation", ["operation"]], ["sharedModel", ["model"]], ["sharedExport", ["public-export"]],
      ["sharedEvent", ["event"]], ["sharedContract", ["adapter-contract"]],
      ["sharedImplementation", ["adapter-implementation"]], ["shared", ["route"]], ["/same", ["route"]],
    ];
    for (const [selector, categories] of ambiguous) {
      const result = inspector.resolve(selector, categories);
      assert.equal(result.status, "ambiguous", selector);
      if (result.status === "ambiguous") {
        assert.deepEqual(result.candidates.map((entry) => entry.id), [...result.candidates.map((entry) => entry.id)].sort());
        assert.equal(result.candidates.length, 2);
      }
    }
    const crossCategory = inspector.resolve("shared", ["feature", "route"]);
    assert.equal(crossCategory.status, "ambiguous");
    if (crossCategory.status === "ambiguous") assert.equal(crossCategory.candidates.length, 3);
    assert.equal(inspector.explainRoute("sid1/route/feature/alpha/shared").status, "resolved");
  });

  it("validates manifest v2 before constructing an inspector", () => {
    assert.throws(() => inspectManifest({ ...manifest(), models: [{ ...manifest().models[0]!, id: null }] }), ManifestCompatibilityError);
    assert.throws(() => inspectManifest({ ...manifest(), operations: [manifest().operations[0]!, manifest().operations[0]!] }), ManifestCompatibilityError);
  });
});

describe("semantic architecture diff", () => {
  it("ignores source paths and line-number noise", () => {
    const before = manifest();
    const after = manifest({
      features: before.features.map((entry) => ({ ...entry, file: "moved.ts", line: 99, exports: entry.exports.map((item) => ({ ...item, file: "moved.ts", line: 100 })) })),
      models: before.models.map((entry) => ({ ...entry, file: "moved.ts", line: 50 })),
      operations: before.operations.map((entry) => ({ ...entry, file: "moved.ts", line: 51 })),
      routes: before.routes.map((entry) => ({ ...entry, file: "moved.ts", line: 52 })),
    });

    const diff = diffArchitecture(before, after);
    assert.equal(diff.changed, false);
    assert.equal(formatArchitectureDiff(diff), "No architecture changes.\n");
  });

  it("reports semantic additions, removals, and changes", () => {
    const before = manifest();
    const after = manifest({
      features: [
        ...before.features,
        { ...record("feature", "accounts", "accounts"), publicBoundary: "accounts.ts", exports: [], file: "accounts.ts", line: 1 },
      ],
      models: [{ ...record("model", "Invoice", "accounts"), fields: resolvedStringSchema, file: "x.ts", line: 1 }],
      routes: [{ ...record("route", "invoiceRoute"), method: "POST", path: "/invoices", input: declaredSlot, output: inferredSlot, access: "permission", permission: "invoice.create", file: "x.ts", line: 2 }],
      permissions: ["invoice.create"],
      events: [{ ...record("event", "InvoiceCreated"), payload: resolvedStringSchema, file: "x.ts", line: 3 }],
    });
    const diff = diffArchitecture(before, after);

    assert.equal(diff.changed, true);
    assert.deepEqual(diff.models.removed.map((entry) => entry.name), ["Invoice"]);
    assert.deepEqual(diff.models.added.map((entry) => entry.name), ["Invoice"]);
    assert.deepEqual(diff.permissions.added, ["invoice.create"]);
    assert.deepEqual(diff.permissions.removed, ["invoice.approve", "invoice.read"]);
    assert.equal(diff.routes.changed.length, 1);
    assert.deepEqual(diff.events.added.map((entry) => entry.name), ["InvoiceCreated"]);
    assert.match(formatArchitectureDiff(diff), /Model added: accounts\.Invoice/);
  });

  it("reports static contract-shape and access changes", () => {
    const before = manifest({
      events: [{ ...record("event", "InvoicePaid"), payload: resolvedStringSchema, file: "events.ts", line: 1 }],
      adapters: [{ ...record("adapter-contract", "Payments"), kind: "contract", operations: { status: "resolved", operations: {} }, file: "payments.ts", line: 1 }],
    });
    const after = manifest({
      models: before.models.map((entry) => ({ ...entry, fields: { ...resolvedStringSchema, metadata: { kind: "number" } } })),
      operations: before.operations.map((entry) => ({ ...entry, access: "authorize" as const, permission: "invoice.admin" })),
      events: before.events.map((entry) => ({ ...entry, payload: { ...resolvedStringSchema, metadata: { kind: "boolean" } } })),
      adapters: before.adapters.map((entry) => entry.kind === "contract" ? { ...entry, operations: { status: "unresolved" as const, diagnostic: { code: "SC002", path: "operations", message: "invalid" } } } : entry),
      permissions: ["invoice.admin", "invoice.read"],
    });

    const diff = diffArchitecture(before, after);

    assert.equal(diff.models.changed.length, 1);
    assert.equal(diff.operations.changed.length, 1);
    assert.equal(diff.events.changed.length, 1);
    assert.equal(diff.adapters.changed.length, 1);
    assert.match(formatArchitectureDiff(diff), /Operation changed: billing\.approveInvoice/);
  });

  it("keys same-named operations by owner ID and detects validator-only contract changes", () => {
    const reportOperation = {
      ...manifest().operations[0]!,
      ...record("operation", "approveInvoice", "reports"),
      file: "reports.ts",
      output: declaredSlot,
    };
    const before = manifest({
      features: [
        ...manifest().features,
        { ...record("feature", "reports", "reports"), publicBoundary: "reports.ts", exports: [], file: "reports.ts", line: 1 },
      ],
      operations: [{ ...manifest().operations[0]!, output: declaredSlot }, reportOperation],
    });
    const after = manifest({
      features: before.features,
      operations: [before.operations[0]!, { ...reportOperation, output: inferredSlot, file: "moved-reports.ts", line: 99 }],
    });

    const diff = diffArchitecture(before, after);
    assert.deepEqual(diff.operations.changed.map((entry) => entry.after.id), [
      "sid1/operation/feature/reports/approveInvoice",
    ]);
    assert.match(formatArchitectureDiff(diff), /Operation changed: reports\.approveInvoice/);
  });

  it("diffs package policy and collapsed package uses without source-location noise", () => {
    const before = manifest({
      features: [
        ...manifest().features,
        { ...record("feature", "reports", "reports"), publicBoundary: "reports.ts", exports: [], file: "reports.ts", line: 1 },
      ],
      packagePolicy: [{ package: "date-lib", capability: "pure" }],
      packageUses: [
        { package: "date-lib", capability: "pure", file: "one.ts", line: 1 },
        { package: "date-lib", capability: "pure", file: "two.ts", line: 2 },
      ],
      dependencies: [{ from: "reports", to: "billing", symbols: ["z", "a"], file: "one.ts", line: 1 }],
    });
    const moved = manifest({
      ...before,
      packageUses: [{ package: "date-lib", capability: "pure", file: "moved.ts", line: 80 }],
      dependencies: [{ from: "reports", to: "billing", symbols: ["a", "z"], file: "moved.ts", line: 80 }],
    });
    assert.equal(diffArchitecture(before, moved).changed, false);

    const after = manifest({
      ...moved,
      packagePolicy: [{ package: "date-lib", capability: "external-system" }],
      packageUses: [{ package: "date-lib", capability: "external-system", file: "moved.ts", line: 80 }],
    });
    const diff = diffArchitecture(before, after);
    assert.equal(diff.packagePolicy.changed.length, 1);
    assert.equal(diff.packageUses.changed.length, 1);
    assert.match(formatArchitectureDiff(diff), /Package policy changed: date-lib \(external-system\)/);
  });

  it("rejects malformed nested schema metadata, type contracts, and labels", () => {
    const withStaticType = (staticType: unknown): unknown => ({
      ...manifest(),
      operations: manifest().operations.map((entry) => ({
        ...entry,
        input: { ...entry.input, staticType },
      })),
    });
    const withContract = (contract: unknown): unknown => withStaticType({
      status: "resolved",
      provenance: "inferred-typescript",
      contract,
      labels: [],
    });
    const withMetadata = (metadata: unknown): unknown => ({
      ...manifest(),
      models: manifest().models.map((entry) => ({
        ...entry,
        fields: { ...resolvedStringSchema, metadata },
      })),
    });
    const primitive = { id: "n0", kind: "primitive", name: "string" };
    const malformedInputs: readonly unknown[] = [
      withContract({ version: 1, root: "n0", nodes: [] }),
      withContract({ version: 2, root: "n0", nodes: [primitive] }),
      withContract({ version: 1, root: "n0", nodes: [{ ...primitive, id: "node" }] }),
      withContract({ version: 1, root: "n0", nodes: [{ id: "n0", kind: "unsupported" }] }),
      withContract({ version: 1, root: "n1", nodes: [primitive] }),
      withContract({ version: 1, root: "n0", nodes: [{ id: "n0", kind: "array", element: "n1", readonly: false }] }),
      withContract({
        version: 1,
        root: "n0",
        nodes: [
          { id: "n0", kind: "array", element: "n1", readonly: false },
          { id: "n1", kind: "array", element: "n0", readonly: false },
        ],
      }),
      withMetadata({ kind: "unsupported" }),
      withMetadata({ kind: "extension", namespace: "acme", name: "", version: "1", payload: null, underlying: { kind: "string" } }),
      withMetadata({ kind: "extension", namespace: "acme", name: "token", version: "1", payload: new Date(0), underlying: { kind: "string" } }),
      withStaticType({ ...resolvedStatic, labels: ["Zulu", "Alpha"] }),
      withStaticType({ ...resolvedStatic, labels: ["Alpha", "Alpha"] }),
    ];

    for (const value of malformedInputs) {
      assert.throws(
        () => diffArchitecture(value, manifest()),
        (error: unknown) => error instanceof ManifestCompatibilityError && error.code === "malformed-v2",
      );
    }
  });

  it("rejects v1, mixed, malformed, null-ID, and duplicate-ID runtime inputs with typed guidance", () => {
    const invalidInputs: Array<{ readonly value: unknown; readonly code: ManifestCompatibilityErrorCode }> = [
      { value: { version: 1 }, code: "mixed-version" },
      { value: { ...manifest(), compiler: { ...manifest().compiler, manifestVersion: 1 } }, code: "mixed-version" },
      { value: { ...manifest(), compiler: { typescriptVersion: "5.9.3", schemaProtocolVersion: "1", canonicalSchemaVersion: "1", typeContractVersion: 1 } }, code: "malformed-v2" },
      { value: { ...manifest(), features: null }, code: "malformed-v2" },
      { value: { ...manifest(), diagnostics: [null] }, code: "malformed-v2" },
      { value: { ...manifest(), models: [{ ...manifest().models[0]!, id: null }] }, code: "null-semantic-id" },
      { value: { ...manifest(), operations: [manifest().operations[0]!, { ...manifest().operations[0]!, file: "duplicate.ts", line: 9 }] }, code: "duplicate-semantic-id" },
    ];

    for (const { value, code } of invalidInputs) {
      assert.throws(
        () => diffArchitecture(value, manifest()),
        (error: unknown) => error instanceof ManifestCompatibilityError
          && error.code === code
          && /Regenerate the architecture manifest from source/.test(error.message),
      );
    }
    assert.throws(
      () => diffArchitecture({ version: 1 }, { version: 1 }),
      (error: unknown) => error instanceof ManifestCompatibilityError && error.code === "persisted-v1",
    );
  });
});
