import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineApp, defineFeature } from "typescript-on-rails";

import { checkRelationOwnership, defineRepository, migrateRelationOwnership, relationOwnershipFromGraph, runSeeds } from "../src/index.js";

describe("official PostgreSQL runtime", () => {
  it("enforces relation ownership and explicit exceptions", () => {
    const ownership = [{ relation: "app.invoices", feature: "billing" }];
    assert.deepEqual(checkRelationOwnership(ownership, [{ relation: "app.invoices", feature: "billing" }]), []);
    assert.deepEqual(checkRelationOwnership(ownership, [{ relation: "app.invoices", feature: "reporting", file: "report.ts" }]), [{ code: "FOREIGN_RELATION_ACCESS", relation: "app.invoices", feature: "reporting", owner: "billing", file: "report.ts", message: "reporting cannot access app.invoices; use billing's public boundary" }]);
    assert.deepEqual(checkRelationOwnership(ownership, [{ relation: "app.invoices", feature: "reporting" }], [{ relation: "app.invoices", feature: "reporting", reason: "temporary projection migration" }]), []);
    assert.equal(checkRelationOwnership([], [{ relation: "app.unknown", feature: "billing" }])[0]?.code, "RELATION_OWNER_MISSING");
    assert.throws(() => checkRelationOwnership(ownership, [], [{ relation: "app.invoices", feature: "reporting", reason: "" }]), /RELATION_EXCEPTION_REASON_REQUIRED/);
  });

  it("creates repository definitions and deterministic seed order", async () => {
    const repository = defineRepository<{ readonly read: () => number }>({ name: "billing-repository", feature: "billing", relations: ["app.subscriptions", "app.invoices"] });
    assert.deepEqual(repository.relations, ["app.invoices", "app.subscriptions"]);
    const app = defineApp({ features: [defineFeature({ name: "billing", repositories: [repository] })] });
    assert.deepEqual(relationOwnershipFromGraph(app.graph), [
      { relation: "app.invoices", feature: "billing" },
      { relation: "app.subscriptions", feature: "billing" },
    ]);
    assert.deepEqual(migrateRelationOwnership(relationOwnershipFromGraph(app.graph)).map(({ feature, relations }) => ({ feature, relations })), [{ feature: "billing", relations: ["app.invoices", "app.subscriptions"] }]);
    assert.throws(() => migrateRelationOwnership([{ relation: "app.invoices", feature: "billing" }, { relation: "app.invoices", feature: "other" }]), /CONFLICTING_RELATION_OWNER/);
    const calls: string[] = [];
    const completed = await runSeeds({} as never, [{ name: "b", run: async () => { calls.push("b"); } }, { name: "a", run: async () => { calls.push("a"); } }]);
    assert.deepEqual(calls, ["a", "b"]);
    assert.deepEqual(completed, ["a", "b"]);
  });
});
