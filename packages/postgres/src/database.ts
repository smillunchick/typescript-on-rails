import { AsyncLocalStorage } from "node:async_hooks";

import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import pg from "pg";

export interface DatabaseContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
}

const contextStorage = new AsyncLocalStorage<DatabaseContext>();

export function currentDatabaseContext(): DatabaseContext {
  const context = contextStorage.getStore();
  if (context === undefined) throw new Error("DATABASE_CONTEXT_MISSING");
  return context;
}

export interface RlsHooks<DB> {
  beforeTransaction?(transaction: Transaction<DB>, context: DatabaseContext): Promise<void>;
  afterTransaction?(transaction: Transaction<DB>, context: DatabaseContext): Promise<void>;
}

export interface DatabaseRuntime<DB> {
  readonly db: Kysely<DB>;
  transaction<T>(context: DatabaseContext, operation: (transaction: Transaction<DB>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function withDatabaseTransaction<DB, T>(
  db: Kysely<DB>,
  context: DatabaseContext,
  operation: (transaction: Transaction<DB>) => Promise<T>,
  rls?: RlsHooks<DB>,
): Promise<T> {
  if (!context.tenantId || !context.actorId || !context.requestId) {
    throw new Error("DATABASE_CONTEXT_INVALID");
  }
  return contextStorage.run(Object.freeze({ ...context }), () =>
    db.transaction().execute(async (transaction) => {
      await rls?.beforeTransaction?.(transaction, context);
      const result = await operation(transaction);
      await rls?.afterTransaction?.(transaction, context);
      return result;
    }),
  );
}

export function createPostgresDatabase<DB>(options: {
  readonly connectionString: string;
  readonly maximumConnections?: number;
  readonly rls?: RlsHooks<DB>;
  readonly onPoolError?: (error: Error) => void;
}): DatabaseRuntime<DB> {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.maximumConnections ?? 10 });
  pool.on("error", options.onPoolError ?? (() => {
    // pg removes failed idle clients. Active operations still reject through their query promise.
  }));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return Object.freeze({
    db,
    async transaction<T>(
      context: DatabaseContext,
      operation: (transaction: Transaction<DB>) => Promise<T>,
    ): Promise<T> {
      return withDatabaseTransaction(db, context, operation, options.rls);
    },
    close: async () => { await db.destroy(); },
  });
}

export function postgresRlsHooks<DB>(options: { readonly tenantSetting?: string; readonly actorSetting?: string; readonly requestSetting?: string } = {}): RlsHooks<DB> {
  const tenant = options.tenantSetting ?? "app.tenant_id";
  const actor = options.actorSetting ?? "app.actor_id";
  const request = options.requestSetting ?? "app.request_id";
  for (const name of [tenant, actor, request]) if (!/^[a-z][a-z0-9_.]*$/.test(name)) throw new TypeError(`Invalid PostgreSQL setting: ${name}`);
  return Object.freeze({
    async beforeTransaction(transaction: Transaction<DB>, context: DatabaseContext) {
      await sql`select set_config(${tenant}, ${context.tenantId}, true), set_config(${actor}, ${context.actorId}, true), set_config(${request}, ${context.requestId}, true)`.execute(transaction);
    },
  });
}

export interface MigrationDefinition { readonly name: string; readonly up: Migration["up"]; readonly down?: Migration["down"] }

class OrderedMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: readonly MigrationDefinition[]) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    const output: Record<string, Migration> = {};
    for (const migration of this.migrations) {
      if (output[migration.name] !== undefined) throw new Error(`DUPLICATE_MIGRATION:${migration.name}`);
      output[migration.name] = { up: migration.up, ...(migration.down === undefined ? {} : { down: migration.down }) };
    }
    return output;
  }
}

export async function migrateToLatest<DB>(db: Kysely<DB>, migrations: readonly MigrationDefinition[]): Promise<readonly string[]> {
  return db.connection().execute(async (connection) => {
    const { rows } = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(connection);
    const schema = rows[0]?.schema;
    if (typeof schema !== "string" || schema.length === 0) throw new Error("MIGRATION_SCHEMA_MISSING");
    // Bookkeeping must not match identically named tables in another schema.
    // Keep the connection's search path unchanged for application migrations.
    const migrator = new Migrator({ db: connection, migrationTableSchema: schema, provider: new OrderedMigrationProvider([...migrations].sort((a, b) => a.name.localeCompare(b.name))) });
    const result = await migrator.migrateToLatest();
    if (result.error !== undefined) throw result.error;
    return Object.freeze((result.results ?? []).map(({ migrationName, status }: { readonly migrationName: string; readonly status: string }) => `${migrationName}:${status}`));
  });
}

export interface Seed<DB> { readonly name: string; run(db: Kysely<DB>): Promise<void> }
export async function runSeeds<DB>(db: Kysely<DB>, seeds: readonly Seed<DB>[]): Promise<readonly string[]> {
  const names = new Set<string>();
  const completed: string[] = [];
  for (const seed of [...seeds].sort((a, b) => a.name.localeCompare(b.name))) {
    if (names.has(seed.name)) throw new Error(`DUPLICATE_SEED:${seed.name}`);
    names.add(seed.name);
    await seed.run(db);
    completed.push(seed.name);
  }
  return Object.freeze(completed);
}
