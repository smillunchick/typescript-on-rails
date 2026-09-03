import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeApplicationV3,
  assertRelationExceptions,
  defineApp,
  defineFeature,
  defineRepository,
  relationExceptionIssues,
  runtimeRecordId,
} from "../src/index.js";
import { createAppFixture } from "./helpers/app-fixture.js";

describe("executable repository ownership", () => {
  const invoices = defineRepository<{ readonly read: () => unknown }>({
    name: "invoices",
    feature: "billing",
    relations: ["app.subscriptions", "app.invoices"],
  });

  it("registers exact repositories, exclusive relation owners, public access, and exceptions", () => {
    const app = defineApp({
      features: [
        defineFeature({ name: "billing", repositories: [invoices] }),
        defineFeature({ name: "reporting", repositoryAccess: [invoices] }),
        defineFeature({
          name: "audit",
          relationExceptions: [{ relation: "app.invoices", reason: "regulated export", expires: "2099-12-31" }],
        }),
      ],
    });
    assert.deepEqual(app.graph.relations, [
      { relation: "app.invoices", owner: "billing", repository: "invoices", exclusive: true },
      { relation: "app.subscriptions", owner: "billing", repository: "invoices", exclusive: true },
    ]);
    assert.deepEqual(app.graph.links.filter(({ kind }) => kind.includes("repository") || kind === "relation-exception"), [
      { kind: "relation-exception", from: runtimeRecordId("feature", "audit", "audit"), to: runtimeRecordId("relation", "billing", "app.invoices") },
      { kind: "repository-access", from: runtimeRecordId("feature", "reporting", "reporting"), to: runtimeRecordId("repository", "billing", "invoices") },
      { kind: "repository-relation", from: runtimeRecordId("repository", "billing", "invoices"), to: runtimeRecordId("relation", "billing", "app.invoices") },
      { kind: "repository-relation", from: runtimeRecordId("repository", "billing", "invoices"), to: runtimeRecordId("relation", "billing", "app.subscriptions") },
    ]);
    assert.equal(Object.isFrozen(app.graph.repositories), true);
    assert.equal(Object.isFrozen(app.graph.relations), true);
    assert.deepEqual(relationExceptionIssues(app.graph, { asOf: new Date("2099-12-31T23:59:59.999Z") }), []);
    assert.equal(relationExceptionIssues(app.graph, { asOf: new Date("2100-01-01T00:00:00.000Z") })[0]?.code, "RELATION_EXCEPTION_EXPIRED");
    assert.throws(() => assertRelationExceptions(app, { asOf: new Date("2100-01-01T00:00:00.000Z") }), /RELATION_EXCEPTION_EXPIRED:audit.app.invoices/);
  });

  it("projects repository-only proof and governed exception completeness honestly", async () => {
    const fixture = await createAppFixture({
      "src/features/billing/repository.ts": 'import { defineRepository } from "typescript-on-rails"; export const invoices = defineRepository({ name: "invoices", feature: "billing", relations: ["app.invoices"] });\n',
    });
    try {
      const unbounded = defineApp({ features: [
        defineFeature({ name: "billing", repositories: [invoices] }),
        defineFeature({ name: "audit", relationExceptions: [{ relation: "app.invoices", reason: "manual export" }] }),
      ] });
      const manifest = analyzeApplicationV3(fixture.root, { application: unbounded, asOf: new Date("2026-01-01T00:00:00.000Z") });
      const repository = manifest.composition.find(({ kind }) => kind === "repository");
      assert.equal(repository?.detail?.sqlVerified, false);
      assert.equal(typeof repository?.detail?.source, "object");
      assert.ok(manifest.completeness.observations.some(({ kind, reason }) => kind === "relation-exception" && /no expiry/.test(reason)));
      assert.doesNotMatch(JSON.stringify(manifest.composition), /Kysely|Transaction|connectionString|selectFrom|insertInto/);

      const bounded = defineApp({ features: [
        defineFeature({ name: "billing", repositories: [invoices] }),
        defineFeature({ name: "audit", relationExceptions: [{ relation: "app.invoices", reason: "manual export", expires: "2026-01-31" }] }),
      ] });
      assert.ok(!analyzeApplicationV3(fixture.root, { application: bounded, asOf: new Date("2026-01-15T00:00:00.000Z") }).completeness.observations.some(({ kind }) => kind === "relation-exception"));
      assert.ok(analyzeApplicationV3(fixture.root, { application: bounded, asOf: new Date("2026-02-01T00:00:00.000Z") }).completeness.observations.some(({ kind, reason }) => kind === "relation-exception" && /expired/.test(reason)));
    } finally { await fixture.cleanup(); }
  });

  it("rejects duplicate ownership, unregistered access, and invalid exceptions", () => {
    const duplicateOwner = defineRepository({ name: "other", feature: "other", relations: ["app.invoices"] });
    assert.throws(
      () => defineApp({ features: [defineFeature({ name: "billing", repositories: [invoices] }), defineFeature({ name: "other", repositories: [duplicateOwner] })] }),
      /CONFLICTING_RELATION_OWNER/,
    );
    const sameOwner = defineRepository({ name: "other", feature: "billing", relations: ["app.invoices"] });
    assert.throws(
      () => defineApp({ features: [defineFeature({ name: "billing", repositories: [invoices, sameOwner] })] }),
      /CONFLICTING_RELATION_REPOSITORY/,
    );
    const copy = { ...invoices };
    assert.throws(
      () => defineApp({ features: [defineFeature({ name: "billing", repositories: [invoices] }), defineFeature({ name: "reporting", repositoryAccess: [copy] })] }),
      /UNREGISTERED_REPOSITORY_ACCESS/,
    );
    assert.throws(() => defineFeature({ name: "billing", repositoryAccess: [invoices] }), /SELF_REPOSITORY_ACCESS/);
    assert.throws(() => defineFeature({ name: "audit", relationExceptions: [{ relation: "app.invoices", reason: "" }] }), /RELATION_EXCEPTION_REASON_REQUIRED/);
    assert.throws(() => defineFeature({ name: "audit", relationExceptions: [{ relation: "app.invoices", reason: "temporary", expires: "2026-02-30" }] }), /INVALID_RELATION_EXCEPTION_EXPIRY/);
    assert.throws(
      () => defineApp({ features: [defineFeature({ name: "audit", relationExceptions: [{ relation: "app.unknown", reason: "temporary" }] })] }),
      /UNKNOWN_EXCEPTION_RELATION/,
    );
  });
});
