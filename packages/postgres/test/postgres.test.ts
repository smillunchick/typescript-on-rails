import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkRelationOwnership, defineRepository, runSeeds } from "../src/index.js";

describe("official PostgreSQL runtime", () => {
  it("enforces relation ownership and explicit exceptions", () => {
    const ownership = [{ relation: "app.invoices", feature: "billing" }];
    assert.deepEqual(checkRelationOwnership(ownership, [{ relation: "app.invoices", feature: "billing" }]), []);
    assert.deepEqual(checkRelationOwnership(ownership, [{ relation: "app.invoices", feature: "reporting", file: "report.ts" }]), [{ code: "FOREIGN_RELATION_ACCESS", relation: "app.invoices", feature: "reporting", owner: "billing", file: "report.ts", message: "reporting cannot access app.invoices; use billing's public boundary" }]);
    assert.deepEqual(checkRelationOwnership(ownership, [{ relation: "app.invoices", feature: "reporting" }], [{ relation: "app.invoices", feature: "reporting", reason: "temporary projection migration" }]), []);
    assert.equal(checkRelationOwnership([], [{ relation: "app.unknown", feature: "billing" }])[0]?.code, "RELATION_OWNER_MISSING");
  });

  it("creates repository definitions and deterministic seed order", async () => {
    const repository = defineRepository({ feature: "billing", relations: ["app.subscriptions", "app.invoices"], create: () => ({ read: () => 1 }) });
    assert.deepEqual(repository.relations, ["app.invoices", "app.subscriptions"]);
    assert.equal(repository.create().read(), 1);
    const calls: string[] = [];
    const completed = await runSeeds({} as never, [{ name: "b", run: async () => { calls.push("b"); } }, { name: "a", run: async () => { calls.push("a"); } }]);
    assert.deepEqual(calls, ["a", "b"]);
    assert.deepEqual(completed, ["a", "b"]);
  });
});
