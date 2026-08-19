import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  diffArchitecture,
  formatArchitectureDiff,
  graphAsDot,
  graphAsText,
  inspectApplication,
  inspectManifest,
  type ArchitectureManifest,
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

function manifest(overrides: Partial<ArchitectureManifest> = {}): ArchitectureManifest {
  return {
    version: 1,
    root: "/app",
    features: [{ name: "billing", publicBoundary: "src/features/billing/index.ts", exports: [{ name: "approveInvoice", kind: "value", file: "a.ts", line: 1 }], file: "a.ts", line: 1 }],
    models: [{ name: "Invoice", feature: "billing", contract: "model-v1", file: "model.ts", line: 1 }],
    operations: [{ name: "approveInvoice", kind: "action", feature: "billing", contract: "action-v1", permission: "invoice.approve", file: "actions.ts", line: 1 }],
    routes: [{ name: "invoiceRoute", method: "GET", path: "/invoices/:id", feature: "billing", contract: "route-v1", permission: "invoice.read", file: "actions.ts", line: 2 }],
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
    assert.equal(inspector.findOwner("Invoice")?.feature, "billing");
    assert.deepEqual(inspector.findCallers("approveInvoice"), [
      { feature: "reports", owner: "billing", symbol: "approveInvoice" },
    ]);
    assert.deepEqual(inspector.findCallers("Invoice"), []);
    assert.deepEqual(inspector.explainRoute("/invoices/:id"), {
      name: "invoiceRoute",
      method: "GET",
      path: "/invoices/:id",
      feature: "billing",
      permission: "invoice.read",
    });
    const feature = inspector.explainFeature("billing");
    assert.equal(feature?.name, "billing");
    assert.deepEqual(feature?.models, ["Invoice"]);
    assert.deepEqual(feature?.actions, ["approveInvoice"]);
    assert.deepEqual(feature?.dependents, ["reports"]);
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
    assert.deepEqual(inspector.findCallers("Invoice"), [
      { feature: "namespace", owner: "billing", symbol: "Invoice" },
    ]);
    assert.deepEqual(inspector.findCallers("approveInvoice"), [
      { feature: "named", owner: "billing", symbol: "approveInvoice" },
      { feature: "namespace", owner: "billing", symbol: "approveInvoice" },
    ]);
  });

  it("renders deterministic graph, owner, boundary, exception, and impact projections", () => {
    const source = manifest({
      features: [
        { name: "billing", publicBoundary: "src/features/billing/index.ts", exports: [{ name: "approveInvoice", kind: "value", file: "a.ts", line: 1 }], file: "a.ts", line: 1 },
        { name: "reports", publicBoundary: "src/features/reports/index.ts", exports: [], file: "r.ts", line: 1 },
      ],
      dependencies: [{ from: "reports", to: "billing", symbols: ["approveInvoice"], file: "r.ts", line: 4 }],
      exceptions: [{ rule: "external-io", reason: "Migration", target: "legacy", valid: true, file: "a.ts", line: 3 }],
    });
    const inspector = inspectManifest(source);

    assert.equal(graphAsText(source), "billing\nreports -> billing\n");
    assert.equal(graphAsDot(source), "digraph architecture {\n  \"billing\";\n  \"reports\";\n  \"reports\" -> \"billing\";\n}\n");
    assert.deepEqual(inspector.owners(), [{ model: "Invoice", feature: "billing" }]);
    assert.deepEqual(inspector.boundaries(), [{ feature: "billing", path: "src/features/billing/index.ts", exports: [{ name: "approveInvoice", kind: "value" }] }, { feature: "reports", path: "src/features/reports/index.ts", exports: [] }]);
    assert.equal(inspector.exceptions()[0]?.reason, "Migration");
    assert.deepEqual(inspector.impact("approveInvoice"), { symbol: "approveInvoice", owner: "billing", callers: ["reports"] });
  });
});

describe("semantic architecture diff", () => {
  it("ignores source paths and line-number noise", () => {
    const before = manifest();
    const after = manifest({
      root: "/other",
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
      models: [{ name: "Invoice", feature: "accounts", contract: "model-v1", file: "x.ts", line: 1 }],
      routes: [{ name: "invoiceRoute", method: "POST", path: "/invoices", feature: "billing", contract: "route-v1", permission: "invoice.create", file: "x.ts", line: 2 }],
      permissions: ["invoice.create"],
      events: [{ name: "InvoiceCreated", feature: "billing", contract: "event-v1", file: "x.ts", line: 3 }],
    });
    const diff = diffArchitecture(before, after);

    assert.equal(diff.changed, true);
    assert.deepEqual(diff.models.changed, [{ before: { name: "Invoice", feature: "billing", contract: "model-v1" }, after: { name: "Invoice", feature: "accounts", contract: "model-v1" } }]);
    assert.deepEqual(diff.permissions.added, ["invoice.create"]);
    assert.deepEqual(diff.permissions.removed, ["invoice.approve", "invoice.read"]);
    assert.equal(diff.routes.changed.length, 1);
    assert.deepEqual(diff.events.added, [{ name: "InvoiceCreated", feature: "billing", contract: "event-v1" }]);
    assert.match(formatArchitectureDiff(diff), /Model changed: Invoice/);
  });

  it("reports static contract-shape and access changes", () => {
    const before = manifest({
      events: [{ name: "InvoicePaid", feature: "billing", contract: "event-v1", file: "events.ts", line: 1 }],
      adapters: [{ name: "Payments", kind: "contract", feature: "billing", contract: "adapter-v1", file: "payments.ts", line: 1 }],
    });
    const after = manifest({
      models: before.models.map((entry) => ({ ...entry, contract: "model-v2" })),
      operations: before.operations.map((entry) => ({ ...entry, contract: "action-v2", permission: "invoice.admin" })),
      events: before.events.map((entry) => ({ ...entry, contract: "event-v2" })),
      adapters: before.adapters.map((entry) => ({ ...entry, contract: "adapter-v2" })),
      permissions: ["invoice.admin", "invoice.read"],
    });

    const diff = diffArchitecture(before, after);

    assert.equal(diff.models.changed.length, 1);
    assert.equal(diff.operations.changed.length, 1);
    assert.equal(diff.events.changed.length, 1);
    assert.equal(diff.adapters.changed.length, 1);
    assert.match(formatArchitectureDiff(diff), /Operation changed: approveInvoice/);
  });
});
