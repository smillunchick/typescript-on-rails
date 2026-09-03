import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** Expand-only Phase B schema. Apply after jobsMigration; it has no destructive down step. */
export const jobsExpandMigration: Migration = {
  async up(db) {
    await db.schema.alterTable("tor_outbox").addColumn("event_id", "text").execute();
    await db.schema.alterTable("tor_outbox").addColumn("event_id_hash", "varchar(64)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("occurred_at", "timestamptz").execute();
    await db.schema.alterTable("tor_outbox").addColumn("tenant_id", "varchar(200)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("actor_id", "varchar(200)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("request_id", "varchar(200)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("correlation_id", "varchar(200)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("causation_id", "varchar(200)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("state", "varchar(30)", (column) => column.notNull().defaultTo("ready")).execute();
    await db.schema.alterTable("tor_outbox").addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0)).execute();
    await db.schema.alterTable("tor_outbox").addColumn("maximum_attempts", "integer", (column) => column.notNull().defaultTo(5)).execute();
    await db.schema.alterTable("tor_outbox").addColumn("available_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`)).execute();
    await db.schema.alterTable("tor_outbox").addColumn("last_error_code", "varchar(100)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("quarantine_reason", "varchar(100)").execute();
    await db.schema.alterTable("tor_outbox").addColumn("replay_generation", "integer", (column) => column.notNull().defaultTo(0)).execute();
    await db.schema.alterTable("tor_outbox").addColumn("migration_classification", "varchar(30)").execute();
    await sql`update tor_outbox set state = 'published' where published_at is not null`.execute(db);
    await db.schema.createIndex("tor_outbox_due_v2").on("tor_outbox").columns(["state", "available_at"]).execute();
    await sql`create index tor_outbox_legacy on tor_outbox (created_at, id) where event_id is null`.execute(db);
    await sql`create index tor_outbox_exact_identities on tor_outbox (event, event_id_hash) where event_id is not null`.execute(db);

    await db.schema.alterTable("tor_jobs").addColumn("outbox_id", "varchar(80)", (column) => column.references("tor_outbox.id")).execute();
    await db.schema.alterTable("tor_jobs").addColumn("consumer_id", "text").execute();
    await db.schema.alterTable("tor_jobs").addColumn("consumer_id_hash", "varchar(64)").execute();
    await db.schema.alterTable("tor_jobs").addColumn("quarantine_reason", "varchar(100)").execute();
    await db.schema.alterTable("tor_jobs").addColumn("replay_generation", "integer", (column) => column.notNull().defaultTo(0)).execute();
    await sql`create unique index tor_jobs_outbox_consumer on tor_jobs (outbox_id, consumer_id_hash, replay_generation) where outbox_id is not null and consumer_id_hash is not null`.execute(db);

    await db.schema
      .createTable("tor_outbox_delivery_receipts")
      .addColumn("outbox_id", "varchar(80)", (column) => column.notNull().references("tor_outbox.id"))
      .addColumn("consumer_id", "text", (column) => column.notNull())
      .addColumn("consumer_id_hash", "varchar(64)", (column) => column.notNull())
      .addColumn("consumer_version", "integer", (column) => column.notNull())
      .addColumn("replay_generation", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("job_id", "varchar(80)", (column) => column.references("tor_jobs.id"))
      .addColumn("state", "varchar(20)", (column) => column.notNull())
      .addColumn("error_code", "varchar(100)")
      .addColumn("permanent", "boolean", (column) => column.notNull().defaultTo(false))
      .addColumn("created_at", "timestamptz", (column) => column.notNull())
      .addColumn("settled_at", "timestamptz")
      .addPrimaryKeyConstraint("tor_outbox_delivery_receipts_pk", ["outbox_id", "consumer_id_hash", "replay_generation"])
      .execute();

    await db.schema
      .createTable("tor_outbox_history")
      .addColumn("id", "varchar(80)", (column) => column.primaryKey())
      .addColumn("outbox_id", "varchar(80)", (column) => column.notNull().references("tor_outbox.id"))
      .addColumn("sequence", "integer", (column) => column.notNull())
      .addColumn("kind", "varchar(40)", (column) => column.notNull())
      .addColumn("actor_id", "varchar(200)")
      .addColumn("reason_code", "varchar(100)")
      .addColumn("at", "timestamptz", (column) => column.notNull())
      .addColumn("details", "jsonb")
      .addUniqueConstraint("tor_outbox_history_sequence", ["outbox_id", "sequence"])
      .execute();

    await db.schema
      .createTable("tor_outbox_replay_requests")
      .addColumn("request_id", "varchar(200)", (column) => column.primaryKey())
      .addColumn("outbox_id", "varchar(80)", (column) => column.notNull().references("tor_outbox.id"))
      .addColumn("approved_by", "varchar(200)", (column) => column.notNull())
      .addColumn("reason", "varchar(300)", (column) => column.notNull())
      .addColumn("requested_at", "timestamptz", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("tor_jobs_migration_state")
      .addColumn("singleton", "integer", (column) => column.primaryKey())
      .addColumn("state", "varchar(30)", (column) => column.notNull())
      .addColumn("rollback_restricted", "boolean", (column) => column.notNull().defaultTo(false))
      .addColumn("reconciliation_graph_hash", "varchar(64)")
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .execute();
    await sql`insert into tor_jobs_migration_state (singleton, state, rollback_restricted, updated_at) values (1, 'Expanded', false, now())`.execute(db);

    await db.schema
      .createTable("tor_outbox_reconciliation")
      .addColumn("outbox_id", "varchar(80)", (column) => column.primaryKey().references("tor_outbox.id"))
      .addColumn("graph_hash", "varchar(64)", (column) => column.notNull())
      .addColumn("classification", "varchar(30)", (column) => column.notNull())
      .addColumn("resolved_event_id", "text")
      .addColumn("at", "timestamptz", (column) => column.notNull())
      .execute();
  },
};
