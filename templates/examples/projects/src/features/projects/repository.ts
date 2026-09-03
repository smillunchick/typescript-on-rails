import { defineRepository } from "typescript-on-rails";

import type { ProjectValue } from "./model.js";

export interface ProjectRepository {
  save(project: ProjectValue, tenantId: string): Promise<ProjectValue>;
}

export const projectsRepository = defineRepository<ProjectRepository>({
  name: "projects",
  feature: "projects",
  relations: ["public.projects"],
});
