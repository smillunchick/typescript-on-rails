import assert from "node:assert/strict";
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
    assert.ok(manifest.models.some((model) => model.name === "Invoice" && model.feature === "billing"));
    assert.ok(manifest.operations.some((operation) => operation.name === "approveInvoice"));
    assert.ok(manifest.dependencies.some((edge) => edge.from === "reports" && edge.to === "billing"));
  });
});
