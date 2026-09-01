import { consumer, defineFeature, page } from "typescript-on-rails";

import { ProjectCheckDue, ProjectCreated } from "./events.js";
import { createProjectRoute } from "./http-contract.js";
import { createProject } from "./operations.js";

interface WelcomeConsumerContext {
  readonly email: {
    send(message: { readonly idempotencyKey: string; readonly to: string; readonly subject: string; readonly text: string }): Promise<unknown>;
  };
}

export { Project, type ProjectValue } from "./model.js";
export { ProjectCheckDue, ProjectCreated } from "./events.js";
export { createProjectRoute } from "./http-contract.js";
export { createProject } from "./operations.js";
export type { ProjectRepository } from "./repository.js";

export const sendProjectWelcome = consumer({
  name: "sendProjectWelcome",
  event: ProjectCreated,
  durable: true,
  async handle({ projectId }, context: WelcomeConsumerContext) {
    await context.email.send({
      idempotencyKey: `welcome:${projectId}`,
      to: "developer@example.test",
      subject: "Project created",
      text: `Project ${projectId} was created.`,
    });
  },
});

export const checkProjects = consumer({
  name: "checkProjects",
  event: ProjectCheckDue,
  durable: true,
  async handle({ date }, context: WelcomeConsumerContext) {
    await context.email.send({
      idempotencyKey: `project-check:${date}`,
      to: "developer@example.test",
      subject: "Project check complete",
      text: `Project checks completed for ${date}.`,
    });
  },
});

export const projectsFeature = defineFeature({
  name: "projects",
  operations: { createProject },
  routes: [createProjectRoute],
  pages: [page({ name: "projects", path: "/", runtime: "hybrid" })],
  permissions: ["project.create", "project.read"],
  events: [ProjectCreated, ProjectCheckDue],
  consumers: [sendProjectWelcome, checkProjects],
  tests: ["test/reference.test.ts"],
});
