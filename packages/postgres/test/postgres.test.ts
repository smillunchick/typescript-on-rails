import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineApp, defineFeature } from "typescript-on-rails";
import { sql } from "kysely";

import { checkRelationOwnership, createTestDatabase, defineRepository, migrateRelationOwnership, migrateToLatest, relationOwnershipFromGraph, runSeeds, type MigrationDefinition } from "../src/index.js";

describe("official PostgreSQL runtime", () => {
  it("keeps migration bookkeeping and application changes in each connection's schema", { skip: process.env.TEST_DATABASE_URL === undefined }, async () => {
    const first = await createTestDatabase<{ migration_probe: { value: string } }>(process.env.TEST_DATABASE_URL ?? "");
    try {
      const second = await createTestDatabase<{ migration_probe: { value: string } }>(process.env.TEST_DATABASE_URL ?? "");
      try {
        for (const database of [first, second]) {
          const migrations: readonly MigrationDefinition[] = [{ name: "001_probe", up: async (db) => {
            await db.schema.createTable("migration_probe").addColumn("value", "varchar(100)").execute();
            await sql`insert into migration_probe (value) values (${database.schema})`.execute(db);
          } }];
          assert.deepEqual(await migrateToLatest(database.db, migrations), ["001_probe:Success"]);
          assert.deepEqual(await migrateToLatest(database.db, migrations), []);
          const expanded = [...migrations, { name: "002_probe", up: async (db: Parameters<MigrationDefinition["up"]>[0]) => {
            await sql`insert into migration_probe (value) values ('later')`.execute(db);
          } }];
          assert.deepEqual(await migrateToLatest(database.db, expanded), ["002_probe:Success"]);
          assert.deepEqual(await migrateToLatest(database.db, expanded), []);
          assert.deepEqual(await database.db.selectFrom("migration_probe").selectAll().orderBy("value").execute(), [{ value: "later" }, { value: database.schema }]);
          const tables = await sql<{ tablename: string }>`select tablename from pg_catalog.pg_tables
            where schemaname = ${database.schema} and tablename like 'kysely_%' order by tablename`.execute(database.db);
          assert.deepEqual(tables.rows.map(({ tablename }) => tablename), ["kysely_migration", "kysely_migration_lock"]);
        }
        // Running the second schema must not change the first schema's history or data.
        assert.deepEqual(await first.db.selectFrom("migration_probe").selectAll().orderBy("value").execute(), [{ value: "later" }, { value: first.schema }]);
        const history = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(first.db);
        assert.deepEqual(history.rows.map(({ name }) => name), ["001_probe", "002_probe"]);
        await second.db.connection().execute(async (connection) => {
          await sql`select set_config('search_path', '', false)`.execute(connection);
          try { await assert.rejects(migrateToLatest(connection, []), /MIGRATION_SCHEMA_MISSING/); }
          finally { await sql`select set_config('search_path', ${second.schema}, false)`.execute(connection); }
        });
      } finally { await second.close(); }
    } finally { await first.close(); }
  });

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
