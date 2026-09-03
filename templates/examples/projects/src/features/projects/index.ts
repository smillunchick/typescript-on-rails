import type { DurableConsumerContext } from "@typescript-on-rails/jobs";
import { consumer, defineFeature, emailContract, page, schedule } from "typescript-on-rails";

import { ProjectCheckDue, ProjectCreated } from "./events.js";
import { createProjectRoute } from "./http-contract.js";
import { Project } from "./model.js";
import { createProject } from "./operations.js";
import { projectsRepository } from "./repository.js";

interface WelcomeConsumerContext {
  readonly email: {
    send(message: { readonly idempotencyKey: string; readonly to: string; readonly subject: string; readonly text: string }): Promise<unknown>;
  };
}

export { Project, type ProjectValue } from "./model.js";
export { ProjectCheckDue, ProjectCreated } from "./events.js";
export { createProjectRoute } from "./http-contract.js";
export { createProject } from "./operations.js";
export { projectsRepository, type ProjectRepository } from "./repository.js";

export const sendProjectWelcome = consumer({
  name: "sendProjectWelcome",
  event: ProjectCreated,
  durable: true,
  async handle({ projectId }, context: DurableConsumerContext<WelcomeConsumerContext>) {
    await context.application.email.send({
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
  async handle({ date }, context: DurableConsumerContext<WelcomeConsumerContext>) {
    await context.application.email.send({
      idempotencyKey: `project-check:${date}`,
      to: "developer@example.test",
      subject: "Project check complete",
      text: `Project checks completed for ${date}.`,
    });
  },
});

export const dailyProjectCheck = schedule({
  name: "daily-project-check",
  feature: "projects",
  target: checkProjects,
  occurrences: (now) => {
    const date = now.toISOString().slice(0, 10);
    return [{ occurrence: date, payload: { date }, dueAt: now }];
  },
});

export const projectsFeature = defineFeature({
  name: "projects",
  models: [Project],
  operations: { createProject },
  routes: [createProjectRoute],
  pages: [page({ name: "projects", path: "/", runtime: "hybrid" })],
  permissions: ["project.create", "project.read"],
  events: [ProjectCreated, ProjectCheckDue],
  consumers: [sendProjectWelcome, checkProjects],
  adapters: [emailContract],
  repositories: [projectsRepository],
  schedules: [dailyProjectCheck],
});
