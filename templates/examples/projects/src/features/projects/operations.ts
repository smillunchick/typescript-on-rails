import { action, object, string } from "typescript-on-rails";

import { ProjectCreated } from "./events.js";
import { Project } from "./model.js";
import type { ProjectCommandContext } from "./context.js";

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
