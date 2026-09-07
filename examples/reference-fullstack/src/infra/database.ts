import { createPostgresDatabase, postgresRlsHooks } from "@typescript-on-rails/postgres";
import type { JobDatabase } from "@typescript-on-rails/jobs";

export interface ReferenceDatabase extends JobDatabase {
  projects: { id: string; tenant_id: string; name: string; created_at: Date };
  project_invitations: {
    id: string; tenant_id: string; project_id: string; email: string; token: string;
    expires_at: Date; accepted_by: string | null; accepted_at: Date | null;
  };
}

export function referenceDatabase(connectionString: string) {
  return createPostgresDatabase<ReferenceDatabase>({ connectionString, rls: postgresRlsHooks() });
}
