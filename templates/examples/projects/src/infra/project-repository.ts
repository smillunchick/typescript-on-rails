import type { Transaction } from "kysely";

import type { ProjectRepository, ProjectValue } from "../features/projects/index.js";
import type { ReferenceDatabase } from "./database.js";

export function postgresProjectRepository(transaction: Transaction<ReferenceDatabase>): ProjectRepository {
  return Object.freeze({
    async save(project: ProjectValue, tenantId: string) {
      await transaction
        .insertInto("projects")
        .values({
          id: project.id,
          tenant_id: tenantId,
          name: project.name,
          created_at: new Date(),
        })
        .execute();
      return project;
    },
  });
}
