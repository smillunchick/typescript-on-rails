import { action, object, string, type OwnedEventDefinition, type ExecutionContext } from "typescript-on-rails";

import { ProjectCreated } from "./events.js";
import { Project } from "./model.js";
import type { ProjectRepository } from "./repository.js";

interface ProjectCommandContext extends ExecutionContext {
  readonly tenantId: string;
  readonly projects: ProjectRepository;
  readonly outbox: {
    appendOutbox<T>(event: OwnedEventDefinition<T>, payload: T, idempotencyKey: string): Promise<unknown>;
  };
}

export const createProject = action({
  input: object({ id: string(), name: string() }),
  output: object({ id: string(), name: string() }),
  permission: "project.create",
  async run(input, context: ProjectCommandContext) {
    const project = await context.projects.save(Project.parse(input), context.tenantId);
    await context.outbox.appendOutbox(ProjectCreated, { projectId: project.id }, `project-created:${project.id}`);
    return project;
  },
});
