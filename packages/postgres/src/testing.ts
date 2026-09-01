import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";

import {
  withDatabaseTransaction,
  type DatabaseContext,
  type RlsHooks,
} from "./database.js";

export interface TestDatabase<DB> {
  readonly db: Kysely<DB>;
  readonly schema: string;
  transaction<T>(
    context: DatabaseContext,
    operation: (transaction: Transaction<DB>) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDatabase<DB>(
  connectionString: string,
  options: string | { readonly prefix?: string; readonly rls?: RlsHooks<DB> } = {},
): Promise<TestDatabase<DB>> {
  if (!connectionString) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const prefix = typeof options === "string" ? options : options.prefix ?? "tor_test";
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new TypeError("TEST_DATABASE_PREFIX_INVALID");
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    options: `-c search_path=${schema}`,
  });
  pool.on("error", () => {
    // pg removes failed idle clients. Tests observe operation failures through their own queries.
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`create schema "${schema}"`).execute(db);
  return Object.freeze({
    db,
    schema,
    async transaction<T>(
      context: DatabaseContext,
      operation: (transaction: Transaction<DB>) => Promise<T>,
    ): Promise<T> {
      return withDatabaseTransaction(
        db,
        context,
        operation,
        typeof options === "string" ? undefined : options.rls,
      );
    },
    async close() {
      try { await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db); }
      finally { await db.destroy(); }
    },
  });
}

export interface Fixture<DB> { readonly name: string; load(db: Kysely<DB>): Promise<void> }
export async function loadFixtures<DB>(db: Kysely<DB>, fixtures: readonly Fixture<DB>[]): Promise<void> {
  for (const fixture of [...fixtures].sort((a, b) => a.name.localeCompare(b.name))) await fixture.load(db);
}
