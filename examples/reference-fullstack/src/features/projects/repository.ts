import type { ProjectValue } from "./model.js";

export interface ProjectRepository {
  save(project: ProjectValue, tenantId: string): Promise<ProjectValue>;
}
