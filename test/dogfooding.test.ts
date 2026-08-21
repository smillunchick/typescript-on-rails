import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeApplication } from "../src/features/architecture/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const referenceApplicationRoot = path.join(repositoryRoot, "examples", "reference-saas");

describe("framework dogfooding", () => {
  it("organizes the framework as checked feature modules", () => {
    const manifest = analyzeApplication(repositoryRoot);

    assert.deepEqual(manifest.features.map((feature) => feature.name), [
      "architecture",
      "introspection",
      "runtime",
      "testing",
      "tooling",
    ]);
    assert.deepEqual(manifest.packagePolicy, [{ package: "typescript", capability: "host-io" }]);
    assert.ok(manifest.packageUses.some((entry) => entry.package === "typescript" && entry.capability === "host-io"));
    assert.deepEqual(manifest.diagnostics, []);
  });

  it("keeps the reference SaaS application architecture-clean", () => {
    const manifest = analyzeApplication(referenceApplicationRoot);

    assert.deepEqual(manifest.features.map((feature) => feature.name), [
      "billing",
      "identity",
      "reports",
    ]);
    assert.deepEqual(manifest.packagePolicy, []);
    assert.deepEqual(manifest.packageUses, []);
    assert.deepEqual(manifest.diagnostics, []);

    const invoice = manifest.models.find((model) => model.name === "Invoice");
    assert.ok(invoice);
    assert.equal(invoice.id, "sid1/model/feature/billing/Invoice");

    const approve = manifest.operations.find((operation) => operation.name === "approveInvoice");
    assert.ok(approve);
    assert.equal(approve.id, "sid1/operation/feature/billing/approveInvoice");
    const approveStaticOutput = approve.output.staticType;
    assert.equal(approveStaticOutput.status, "resolved");
    if (approveStaticOutput.status === "resolved") {
      const contract = approveStaticOutput.contract;
      const root = contract.nodes.find((node) => node.id === contract.root);
      assert.deepEqual(root?.kind === "object" ? root.properties.map((property) => property.name) : [], ["approvedBy", "invoiceId"]);
    }
    assert.deepEqual(approve.output.runtimeSchema, { status: "not-declared", validator: "not-declared" });

    const pay = manifest.operations.find((operation) => operation.name === "payInvoice");
    assert.ok(pay);
    assert.equal(pay.id, "sid1/operation/feature/billing/payInvoice");
    assert.equal(pay.output.staticType.status, "resolved");
    assert.equal(pay.output.runtimeSchema.status, "resolved");
    if (pay.output.runtimeSchema.status === "resolved") {
      assert.equal(pay.output.runtimeSchema.validator, "declared");
      assert.equal(pay.output.runtimeSchema.metadata.kind, "object");
    }

    const route = manifest.routes.find((entry) => entry.name === "invoiceRoute");
    assert.ok(route);
    assert.equal(route.id, "sid1/route/feature/billing/invoiceRoute");
    assert.equal(route.input.runtimeSchema.status, "resolved");
    assert.deepEqual(route.output.runtimeSchema, { status: "not-declared", validator: "not-declared" });

    const event = manifest.events.find((entry) => entry.name === "InvoicePaid");
    assert.ok(event);
    assert.equal(event.id, "sid1/event/feature/billing/InvoicePaid");
    assert.equal(event.payload.status, "resolved");

    const contract = manifest.adapters.find((entry) => entry.name === "Payments");
    assert.ok(contract);
    assert.equal(contract.kind, "contract");
    assert.equal(contract.id, "sid1/adapter-contract/feature/billing/Payments");
    if (contract.kind === "contract") assert.equal(contract.operations.status, "resolved");
    const implementation = manifest.adapters.find((entry) => entry.name === "payments");
    assert.ok(implementation);
    assert.equal(implementation.kind, "implementation");
    assert.equal(implementation.id, "sid1/adapter-implementation/infra/_/payments");
    if (implementation.kind === "implementation") assert.equal(implementation.contractId, contract.id);

    assert.ok(manifest.dependencies.some((edge) => edge.from === "reports" && edge.to === "billing"));
  });

  it("ships migration guidance and truthful reference commands", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const referencePackage = JSON.parse(readFileSync(path.join(referenceApplicationRoot, "package.json"), "utf8"));
    const readme = readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
    const migration = readFileSync(path.join(repositoryRoot, "MIGRATION.md"), "utf8");
    const referenceReadme = readFileSync(path.join(referenceApplicationRoot, "README.md"), "utf8");

    assert.ok(packageJson.files.includes("MIGRATION.md"));
    assert.match(readme, /Migrate to architecture manifest v2/);
    assert.match(migration, /There is no v1-to-v2 converter/);
    assert.match(migration, /packageCapabilities/);
    assert.match(migration, /adaptSchema/);
    assert.match(migration, /CHOOSE/);
    assert.equal(referencePackage.scripts["build:app"], undefined);
    assert.equal(referencePackage.scripts["dev:app"], undefined);
    assert.equal(referencePackage.scripts["check:types"], "tsc -p tsconfig.json");
    assert.equal(referencePackage.devDependencies.typescript, "5.9.3");
    assert.match(referenceReadme, /view model/);
    assert.match(referenceReadme, /not a deployable full-stack service/);
  });
});
