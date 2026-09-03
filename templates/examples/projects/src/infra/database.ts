import { createPostgresDatabase, postgresRlsHooks } from "@typescript-on-rails/postgres";
import type { JobDatabase } from "@typescript-on-rails/jobs";

export interface ReferenceDatabase extends JobDatabase {
  projects: { id: string; tenant_id: string; name: string; created_at: Date };
}

export function referenceDatabase(connectionString: string) {
  return createPostgresDatabase<ReferenceDatabase>({ connectionString, rls: postgresRlsHooks() });
}
