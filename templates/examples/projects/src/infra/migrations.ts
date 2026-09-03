import { jobsExpandMigration, jobsMigration } from "@typescript-on-rails/jobs";
import type { MigrationDefinition } from "@typescript-on-rails/postgres";
import { sql } from "kysely";

export const referenceMigrations: readonly MigrationDefinition[] = [
  {
    name: "001_projects",
    up: async (db) => {
      await db.schema
        .createTable("projects")
        .addColumn("id", "varchar(80)", (column) => column.primaryKey())
        .addColumn("tenant_id", "varchar(80)", (column) => column.notNull())
        .addColumn("name", "varchar(200)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull())
        .execute();
      await sql`alter table projects enable row level security`.execute(db);
      await sql`alter table projects force row level security`.execute(db);
      await sql`
        create policy projects_tenant_isolation on projects
        using (tenant_id = current_setting('app.tenant_id', true))
        with check (tenant_id = current_setting('app.tenant_id', true))
      `.execute(db);
    },
    down: async (db) => {
      await db.schema.dropTable("projects").ifExists().execute();
    },
  },
  {
    name: "002_jobs",
    up: jobsMigration.up,
    ...(jobsMigration.down === undefined ? {} : { down: jobsMigration.down }),
  },
  { name: "003_jobs_expand", up: jobsExpandMigration.up },
];
